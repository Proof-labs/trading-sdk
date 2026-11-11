from __future__ import annotations

import base64
import binascii
import hashlib
import inspect
import json
import logging
import re
import threading
import time
import typing as t
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import urljoin

import httpx
import msgpack

from proof_trading_sdk._native import (
    MAX_MARKETS_SNAPSHOT_BYTES,
    MAX_OPEN_ORDERS_BYTES,
    SigningHandle,
    chain_id_from_string,
    decode_open_orders,
    generate_keypair,
    pubkey_to_owner,
    reject_floats,
    sign_account_ws_auth,
    sign_and_encode,
    signing_message,
    account_ws_auth_message,
    encode_signed_tx,
    verify_raw_signature,
)
from proof_trading_sdk.external_signer import ExternalSigner
from proof_trading_sdk.actions import (
    Action,
    CancelPositionTriggers,
    SetPositionTriggers,
    TriggerLimb,
    encode_action,
)
from proof_trading_sdk.config import SdkConfig, load_config
from proof_trading_sdk.finalized_markets import (
    FinalizedOrderbook, FinalizedMarketsSnapshot, orderbook_request,
    decode_finalized_orderbook, decode_finalized_markets_snapshot,
)
from proof_trading_sdk.governance_reads import (
    AuthoritiesSnapshot, LiquidationConfigInfo,
    decode_authorities_snapshot, decode_liquidation_config_info,
)
from proof_trading_sdk.candle_history import (
    CandleHistoryPage,
    CandleHistoryTime,
    candle_history_params,
    decode_candle_history,
)
from proof_trading_sdk.markets_snapshot import MarketsSnapshot, decode_markets_snapshot
from proof_trading_sdk.chain_evidence import (
    BlockResultsRange, BlockResultsWindow, TransactionEvidence,
    read_block_results, read_transaction_evidence,
)
from proof_trading_sdk.evidence import (
    BlockEvidenceHeader,
    _chain_pin,
    _requested_height,
    decode_block_evidence_header,
)
from proof_trading_sdk.finalized_accounts import (
    FinalizedAccountInfo, FinalizedAgentAuthorization, FinalizedRecentNonces,
    FinalizedOpenOrders, _address, _limit, decode_finalized_account,
    decode_finalized_agent_authorization, decode_finalized_recent_nonces,
    decode_finalized_open_orders,
)
from proof_trading_sdk.errors import (
    AuthenticationError,
    CodecError,
    EngineError,
    GatewayError,
    PreAdmissionRefusal,
    ProofTradingSdkError,
    RateLimited,
    SigningError,
    SubmissionPending,
    TransportError,
)
from proof_trading_sdk.nonce import NonceAllocator
from proof_trading_sdk.trigger_history import (
    PositionTriggerHistoryPage,
    TriggerHistoryTime,
    TriggerMarketHistoryPage,
    canonical_owner,
    decode_position_trigger_history_page,
    decode_trigger_market_history_page,
    history_params,
    validate_market,
)
from proof_trading_sdk.trigger_config import (
    TriggerMarketConfigInfo,
    decode_trigger_market_config_infos,
)

from proof_trading_sdk.finalized_account import (
    FinalizedAccountState, account_state_owner, decode_finalized_account_state,
)

if t.TYPE_CHECKING:
    from proof_trading_sdk.streams import AccountEventStream

log = logging.getLogger("proof_trading_sdk")

# ── Helpers ───────────────────────────────────────────────────────────────────


_LEADING_ERROR_CODE = re.compile(r"^(\d+):\s")
_DEFAULT_RATE_LIMIT_BUCKET = "default"


def _leading_error_code(text: str) -> int | None:
    """Recover an engine code from the gateway's ``"<code>: <message>"`` string.

    Returns ``None`` when the text carries no leading code, so the caller can
    apply its own fallback.
    """
    m = _LEADING_ERROR_CODE.match(text or "")
    return int(m.group(1)) if m else None


def _response_json(resp: httpx.Response) -> t.Any:
    """Keep invalid JSON inside the SDK error boundary without echoing its body."""
    try:
        return resp.json()
    except (ValueError, UnicodeError) as exc:
        raise TransportError(
            "gateway returned malformed JSON", status_code=resp.status_code
        ) from exc


def _response_object(resp: httpx.Response) -> dict[str, t.Any]:
    data = _response_json(resp)
    if not isinstance(data, dict):
        raise TransportError("expected a JSON object from gateway", status_code=resp.status_code)
    return data


# httpx failures raised before any request byte reaches the gateway. Every other
# httpx failure (read or write errors, a dropped connection, an undecodable
# response body) may follow an admitted submission.
_NOT_SENT = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.PoolTimeout,
    httpx.LocalProtocolError,
    httpx.UnsupportedProtocol,
)


def _submission_may_have_been_admitted(exc: TransportError) -> bool:
    """Whether a failed ``/exchange`` request may still have been admitted.

    A 5xx reaching this check carries no refusal envelope, so it is ambiguous.
    An httpx failure is ambiguous unless it is in ``_NOT_SENT``. A
    TransportError raised from an HTTP status (4xx, 3xx) was answered by the
    gateway without admission.
    """
    if isinstance(exc, GatewayError):
        return True
    cause = exc.__cause__
    return isinstance(cause, httpx.RequestError) and not isinstance(cause, _NOT_SENT)


def _to_hex(owner: bytes | str) -> str:
    """Normalise *owner* to a hex string (with or without ``0x`` prefix).

    Accepts either raw 20-byte ``bytes`` or any hex string. Strips ``0x``
    prefix if present so the caller doesn't need to check.
    """
    if isinstance(owner, bytes):
        return owner.hex()
    return owner.removeprefix("0x")

# Sub-account registry rows: `proof-wire` `SubAccount` field count (later
# fields are appended as optional) and a decode budget that only stops a
# hostile payload from allocating unbounded rows.
_SUB_ACCOUNT_ROW_FIELDS = 5
_SUB_ACCOUNT_MAX_ROWS = 4096


def _sub_account_bytes(value: t.Any, length: int, field_name: str) -> bytes:
    """Exact-length fixed byte field, as a bin or an array of integer bytes."""
    if isinstance(value, (list, tuple)):
        if any(
            isinstance(b, bool) or not isinstance(b, int) or not 0 <= b <= 255
            for b in value
        ):
            raise CodecError(f"sub-account list decode: {field_name} byte")
        value = bytes(value)
    if not isinstance(value, (bytes, bytearray)):
        raise CodecError(f"sub-account list decode: {field_name} encoding")
    if len(value) != length:
        raise CodecError(f"sub-account list decode: {field_name} length")
    return bytes(value)


def _sub_account_int(value: t.Any, low: int, high: int, field_name: str) -> int:
    """Integer field within ``low..=high``; booleans and floats are rejected."""
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise CodecError(f"sub-account list decode: {field_name}")
    return value


def _sub_account_name(value: t.Any) -> str:
    """32-byte zero-padded UTF-8 display name, padding stripped."""
    try:
        return _sub_account_bytes(value, 32, "name").rstrip(b"\x00").decode("utf-8")
    except UnicodeDecodeError as e:
        raise CodecError("sub-account list decode: name (invalid UTF-8)") from e

# ── Constants ────────────────────────────────────────────────────────────────

ENVELOPE_VERSION = 2
DOMAIN_PREFIX = b"ProofExchange-v3"
UNBOUND_CHAIN_ID = b"\x00" * 32

# ── Enums ────────────────────────────────────────────────────────────────────

class Side:
    Buy = 1
    Sell = 2


class TimeInForce:
    Gtc = 0
    Ioc = 1
    Fok = 2


# ── Response types ───────────────────────────────────────────────────────────

@dataclass
class AccountState:
    balances: dict[str, int] = field(default_factory=dict)
    positions: list[dict[str, t.Any]] = field(default_factory=list)
    open_orders: list[dict[str, t.Any]] = field(default_factory=list)
    margin: dict[str, t.Any] = field(default_factory=dict)
    raw: dict[str, t.Any] = field(default_factory=dict)


@dataclass
class CursorPage:
    data: list[dict[str, t.Any]] = field(default_factory=list)
    next_cursor: str | None = None
    raw: dict[str, t.Any] = field(default_factory=dict)


@dataclass
class RateLimitState:
    limit: int = 0
    remaining: int = 0
    reset: int = 0
    tier: str = ""
    bucket: str = ""


# ── Client ───────────────────────────────────────────────────────────────────

class ExchangeClient:
    """Native Python HTTP client for the Proof Exchange gateway.

    All signing and codec operations call into the shared Rust core via PyO3.
    Transport, async, config, nonce generation, and rate-limit tracking are
    native Python.

    Args:
        gateway_url: Base URL of the gateway API.
        api_key: API key for gateway authentication.
        secret_key: 32-byte Ed25519 signing key (bytes). Passed to the
            Rust core for signing. NOTE: this places the key on Python's heap;
            for hardware-isolated keys prefer ``key_handle`` (see
            :func:`~proof_trading_sdk.load_key_from_fd`), which keeps the secret
            in Rust/HSM memory and never exposes it to Python. Exactly one of
            ``secret_key`` / ``key_handle`` should be set.
        key_handle: Opaque :class:`SigningHandle` whose key never enters Python
            memory. Takes precedence over ``secret_key`` when both are set.
        chain_id: 32-byte chain binding (bytes). If ``None``, uses the
            ``UNBOUND_CHAIN_ID`` (zeros). Prod must bind a real chain_id.
        config: Pre-built :class:`SdkConfig`. If ``None``, loads from
            the layered config system.
        timeout_secs: HTTP request timeout.
    """

    def __init__(
        self,
        gateway_url: str = "",
        api_key: str = "",
        secret_key: bytes | None = None,
        chain_id: bytes | None = None,
        config: SdkConfig | None = None,
        timeout_secs: int = 0,
        key_handle: SigningHandle | None = None,
    ) -> None:
        if config is not None:
            cfg = config.with_overrides(
                gateway_url=gateway_url or config.gateway_url,
                api_key=api_key or config.api_key,
                timeout_secs=timeout_secs or config.timeout_secs,
            )
        else:
            # Only pass truthy overrides so absent-and-falsy constructor
            # defaults ("" / 0) fall back to env/TOML inside load_config.
            overrides: dict[str, t.Any] = {}
            if gateway_url:
                overrides["gateway_url"] = gateway_url
            if api_key:
                overrides["api_key"] = api_key
            if timeout_secs:
                overrides["timeout_secs"] = timeout_secs
            cfg = load_config(**overrides)

        self._gateway_url = cfg.gateway_url.rstrip("/")
        self._api_key = cfg.api_key
        self._timeout_secs = cfg.timeout_secs
        if chain_id is not None:
            self._chain_id = chain_id
        elif cfg.chain_id:
            self._chain_id = chain_id_from_string(cfg.chain_id)
        else:
            self._chain_id = UNBOUND_CHAIN_ID
        self._secret_key = secret_key
        self._key_handle = key_handle
        self._external_signer: ExternalSigner | None = None
        self._signer_revision = 0
        self._signer_lock = threading.RLock()

        self._nonce = NonceAllocator()
        self._rate_limits: dict[str, RateLimitState] = {}

        self._http = httpx.Client(
            base_url=self._gateway_url,
            timeout=httpx.Timeout(self._timeout_secs),
            headers=self._default_headers(),
        )

    def _default_headers(self) -> dict[str, str]:
        hdrs = {"Content-Type": "application/octet-stream"}
        if self._api_key:
            hdrs["X-API-Key"] = self._api_key
        return hdrs

    # ── Rate-limit helpers ───────────────────────────────────────────────

    def _parse_rate_limits(self, resp: httpx.Response) -> None:
        bucket = resp.headers.get("X-RateLimit-Bucket", _DEFAULT_RATE_LIMIT_BUCKET)
        state = RateLimitState(
            limit=int(resp.headers.get("X-RateLimit-Limit", 0)),
            remaining=int(resp.headers.get("X-RateLimit-Remaining", 0)),
            reset=int(resp.headers.get("X-RateLimit-Reset", 0)),
            tier=resp.headers.get("X-RateLimit-Tier", ""),
            bucket=bucket,
        )
        self._rate_limits[bucket] = state

    def rate_limit_remaining(self, bucket: str = _DEFAULT_RATE_LIMIT_BUCKET) -> int:
        """Return the remaining rate-limit tokens for *bucket*.

        This is a synchronous, local check — the authoritative value is
        in the response headers.
        """
        state = self._rate_limits.get(bucket)
        return state.remaining if state else 0

    def rate_limit_state(self, bucket: str = _DEFAULT_RATE_LIMIT_BUCKET) -> RateLimitState:
        """Return cached response headers for *bucket*.

        Responses without ``X-RateLimit-Bucket`` use ``"default"``. After a
        429, pass ``RateLimited.bucket`` to retrieve that response's state.
        """
        return self._rate_limits.get(bucket, RateLimitState())

    # ── HTTP helpers ─────────────────────────────────────────────────────

    def _request(
        self,
        method: str,
        path: str,
        *,
        content: bytes | None = None,
        params: dict[str, t.Any] | None = None,
        headers: dict[str, str] | None = None,
        read_refusal_body: bool = False,
    ) -> httpx.Response:
        url = urljoin(self._gateway_url, path)
        try:
            resp = self._http.request(
                method, url, content=content, params=params, headers=headers
            )
        except httpx.ConnectError as e:
            raise TransportError(f"connection refused: {e}") from e
        except httpx.ConnectTimeout as e:
            raise TransportError(f"connection timed out: {e}") from e
        except httpx.ReadTimeout as e:
            raise TransportError(f"read timed out: {e}") from e
        except httpx.ReadError as e:
            raise TransportError(f"read failed (connection reset): {e}") from e
        except httpx.RemoteProtocolError as e:
            raise TransportError(f"protocol error: {e}") from e
        except httpx.RequestError as e:
            raise TransportError(f"request failed: {e}") from e

        self._parse_rate_limits(resp)
        return self._check_response(resp, read_refusal_body=read_refusal_body)

    def _check_response(
        self, resp: httpx.Response, *, read_refusal_body: bool = False
    ) -> httpx.Response:
        if read_refusal_body:
            # Submission envelopes are validated with the original bytes in
            # submit_action; the HTTP status cannot prove their finality.
            try:
                body = resp.json()
            except (ValueError, UnicodeError):
                body = None
            if isinstance(body, dict) and body.get("status") in ("refused", "pending"):
                return resp

        if resp.status_code == 429:
            retry_after = float(resp.headers.get("Retry-After", "5"))
            bucket = resp.headers.get("X-RateLimit-Bucket", _DEFAULT_RATE_LIMIT_BUCKET)
            raise RateLimited(retry_after_secs=retry_after, bucket=bucket)

        if resp.status_code == 401:
            raise AuthenticationError("unauthorized — check your API key")

        if resp.status_code == 403:
            raise AuthenticationError("forbidden — API key lacks permission")

        if resp.status_code == 404:
            raise TransportError(f"not found: {resp.url}", status_code=404)

        if resp.status_code == 413:
            raise TransportError("payload too large", status_code=413)

        if resp.status_code == 422:
            raise TransportError(f"unprocessable: {resp.text[:200]}", status_code=422)

        if resp.status_code >= 500:
            raise GatewayError(resp.status_code, resp.text)

        # Anything else non-2xx (400, 402, 405-428, 431, 3xx, …) is NOT success.
        # `GatewayError` specifically means "5xx — a read can retry with backoff";
        # `submit_action` decides what a 5xx means for a submission. A 3xx/4xx
        # is a client-side error that must NOT be blind-retried, so it surfaces
        # as a plain TransportError carrying the status.
        if resp.status_code >= 300:
            raise TransportError(
                f"unexpected HTTP {resp.status_code}: {resp.text[:200]}",
                status_code=resp.status_code,
            )

        return resp

    def _get(
        self,
        path: str,
        params: dict[str, t.Any] | None = None,
    ) -> httpx.Response:
        return self._request("GET", path, params=params)

    def _post(
        self,
        path: str,
        content: bytes | None = None,
        *,
        headers: dict[str, str] | None = None,
        read_refusal_body: bool = False,
    ) -> httpx.Response:
        return self._request(
            "POST", path, content=content, headers=headers,
            read_refusal_body=read_refusal_body,
        )

    # ── Signing ──────────────────────────────────────────────────────────

    def set_external_signer(self, signer: ExternalSigner) -> None:
        """Connect a synchronous Ed25519 callback and discard existing keys.

        The public key and callable are captured once; changing ``signer``
        afterwards does not change this connection. Replacing the connection
        while a callback is running invalidates its result. A blocking callback
        cannot be forcibly cancelled; it owns its device/prompt timeout.
        """
        if not isinstance(signer, ExternalSigner):
            raise SigningError("expected ExternalSigner")
        if not isinstance(signer.public_key, (bytes, bytearray, memoryview)):
            raise SigningError("external signer public key must be 32 bytes")
        try:
            public_key = bytes(signer.public_key)
        except ValueError:
            raise SigningError("external signer public key must be 32 bytes") from None
        if len(public_key) != 32 or not callable(signer.sign_raw) or inspect.iscoroutinefunction(signer.sign_raw):
            raise SigningError("invalid external signer connection")
        snapshot = ExternalSigner(public_key, signer.sign_raw)
        with self._signer_lock:
            self._signer_revision += 1
            self._secret_key = None
            self._key_handle = None
            self._external_signer = snapshot

    def _check_signer_revision(self, revision: int) -> None:
        with self._signer_lock:
            if revision != self._signer_revision:
                raise SigningError("signing connection changed")

    def _sign_external(self, signer: ExternalSigner, revision: int, message: bytes) -> bytes:
        self._check_signer_revision(revision)
        callback_failed = False
        try:
            signature = signer.sign_raw(message)
        except Exception:
            # Wallet/device errors can contain key material. Do not chain them
            # into SDK exceptions or log callback inputs or outputs.
            callback_failed = True
        if callback_failed:
            # Raising outside except also removes __context__, which diagnostic
            # loggers may inspect even when `raise ... from None` hides it.
            raise SigningError("external signer callback failed")
        self._check_signer_revision(revision)
        if not isinstance(signature, (bytes, bytearray, memoryview)):
            if inspect.iscoroutine(signature):
                signature.close()
            raise SigningError("external signer returned an invalid signature")
        conversion_failed = False
        try:
            signature = bytes(signature)
        except Exception:
            conversion_failed = True
        if conversion_failed:
            raise SigningError("external signer returned an invalid signature")
        if len(signature) != 64 or not verify_raw_signature(signer.public_key, signature, message):
            raise SigningError("external signer returned an invalid signature")
        self._check_signer_revision(revision)
        return signature

    def sign_and_encode_action(
        self,
        action_type: int,
        action_payload: bytes,
    ) -> bytes:
        """Sign *action_payload* and encode it as a wire envelope.

        Args:
            action_type: Action type byte (e.g. 0x01 for PlaceOrder).
            action_payload: MessagePack-encoded action payload bytes.

        Returns:
            Wire-ready signed envelope bytes.

        Raises:
            CodecError: If encoding fails.
            SigningError: If signing fails.
        """
        return self._sign_and_encode_action(action_type, action_payload)

    def _sign_and_encode_action(
        self, action_type: int, action_payload: bytes, *, expected_revision: int | None = None,
    ) -> bytes:
        with self._signer_lock:
            if expected_revision is not None:
                self._check_signer_revision(expected_revision)
            signer, revision = self._external_signer, self._signer_revision
            key_handle, secret_key = self._key_handle, self._secret_key
            chain_id = self._chain_id
        seq = self._nonce.allocate()
        try:
            if signer is not None:
                # A zero-chain signature stays valid on any unbound chain, so a
                # wallet is never asked for one.
                if chain_id == UNBOUND_CHAIN_ID:
                    raise SigningError("chain_id not configured for external signing")
                if not isinstance(action_payload, (bytes, bytearray, memoryview)):
                    raise CodecError("action payload must be bytes")
                action_payload = bytes(action_payload)
                # Whatever the encoder refuses never reaches the wallet. Discard
                # this unsigned preflight envelope.
                encode_signed_tx(action_type, action_payload, seq, signer.public_key, bytes(64))
                message = signing_message(chain_id, action_type, seq, action_payload)
                signature = self._sign_external(signer, revision, message)
                return encode_signed_tx(action_type, action_payload, seq, signer.public_key, signature)
            if key_handle is not None:
                # Hardware-isolated path: the key never enters Python memory.
                result = key_handle.sign_and_encode(
                    chain_id,
                    action_type,
                    action_payload,
                    seq,
                )
                self._check_signer_revision(revision)
                return result
            if secret_key is not None:
                result = sign_and_encode(
                    chain_id,
                    action_type,
                    action_payload,
                    seq,
                    secret_key,
                )
                self._check_signer_revision(revision)
                return result
        except ValueError as e:
            raise CodecError(str(e)) from e

        raise SigningError("no signer set (pass secret_key/key_handle or call set_external_signer)")

    def sign_action(self, action: Action) -> bytes:
        """Encode a typed :class:`~proof_trading_sdk.actions.Action` through
        the shared Rust codec, then sign it into a wire envelope.

        The payload bytes are produced by the core (not by Python), so the
        wire layout is authoritative and identical across bindings.
        """
        action_type, payload = encode_action(action)
        return self.sign_and_encode_action(action_type, payload)

    def submit(self, action: Action) -> dict[str, t.Any]:
        """Encode + sign + submit a typed action in one call."""
        return self.submit_action(self.sign_action(action))

    def _submit_with_signer_revision(self, action: Action, revision: int) -> dict[str, t.Any]:
        action_type, payload = encode_action(action)
        envelope = self._sign_and_encode_action(action_type, payload, expected_revision=revision)
        return self.submit_action(envelope)

    def set_position_triggers(
        self,
        market: int,
        expected_position_epoch: int,
        *,
        stop_loss: TriggerLimb | None = None,
        take_profit: TriggerLimb | None = None,
        client_group_id: int | None = None,
        owner: bytes | None = None,
    ) -> dict[str, t.Any]:
        """Replace one exact position generation's complete SL/TP bracket.

        ``owner`` defaults to the signer. A version-active trading agent may
        pass the delegated owner explicitly; authorization remains an engine
        decision and is not guessed from stale client state.
        """
        with self._signer_lock:
            revision = self._signer_revision
            selected_owner = self._own_owner() if owner is None else owner
        return self._submit_with_signer_revision(
            SetPositionTriggers(
                market=market,
                owner=selected_owner,
                expected_position_epoch=expected_position_epoch,
                stop_loss=stop_loss,
                take_profit=take_profit,
                client_group_id=client_group_id,
            ),
            revision,
        )

    def cancel_position_triggers(
        self,
        market: int,
        expected_position_epoch: int,
        *,
        owner: bytes | None = None,
    ) -> dict[str, t.Any]:
        """Cancel one bracket, defaulting owner to the loaded signer."""
        with self._signer_lock:
            revision = self._signer_revision
            selected_owner = self._own_owner() if owner is None else owner
        return self._submit_with_signer_revision(
            CancelPositionTriggers(
                market=market,
                owner=selected_owner,
                expected_position_epoch=expected_position_epoch,
            ),
            revision,
        )

    # ── Write action ─────────────────────────────────────────────────────

    def submit_action(self, envelope: bytes) -> dict[str, t.Any]:
        """Submit a signed action envelope to the gateway.

        Args:
            envelope: Wire-ready signed envelope bytes (from
                :meth:`sign_and_encode_action`).

        Returns:
            The engine's response dict with keys like ``code``,
            ``tx_hash``, etc.

        Raises:
            EngineError: the engine rejected the tx with an ``ExecError`` code.
            SubmissionPending: the gateway broadcast it but could not report
                the outcome; reconcile by ``tx_hash``.
            PreAdmissionRefusal: the gateway refused the request before
                admitting it; nothing was broadcast and there is nothing to
                poll for.
            AuthenticationError: HTTP 401 or 403.
            RateLimited: HTTP 429.
            GatewayError: a validated refusal at HTTP 5xx other than
                ``EncodingError``, such as ``Overloaded``, ``Maintenance`` or
                ``Unavailable``. An ambiguous 5xx is ``SubmissionPending``.
            TransportError: a transport or HTTP failure with no refusal
                envelope.
        """
        body = json.dumps({"action": base64.b64encode(envelope).decode("ascii")}).encode()
        try:
            resp = self._post(
                "/exchange", content=body, headers={"Content-Type": "application/json"},
                read_refusal_body=True,
            )
        except TransportError as exc:
            # A write may have been partial, or the response may have been lost
            # after admission. Preserve the original bytes' hash; never retry.
            if _submission_may_have_been_admitted(exc):
                raise SubmissionPending(
                    hashlib.sha256(envelope).hexdigest().upper(),
                    "submission outcome unknown; reconcile by hash",
                ) from exc
            raise
        # Keep explicitly coded legacy errors, but do not infer an engine
        # verdict from an arbitrary non-object or malformed response.
        raw = resp.text
        try:
            parsed: t.Any = resp.json()
        except (ValueError, UnicodeError):
            parsed = None

        if not isinstance(parsed, dict):
            text = (parsed if isinstance(parsed, str) else raw or "").strip()
            code = _leading_error_code(text)
            if code is not None and code > 0:
                raise EngineError(code, text[:200])
            # An arbitrary proxy body or truncated response is not an engine
            # rejection. The original transaction may still have committed.
            raise SubmissionPending(
                hashlib.sha256(envelope).hexdigest().upper(),
                "malformed /exchange response; reconcile by hash",
            )
        data: dict[str, t.Any] = parsed

        # Classify the gateway's envelope, never by defaulting a missing `code`
        # to 0 — and, just as importantly, never by treating "no code" as a
        # rejection. This mirrors the contract pinned by the TypeScript binding
        # (`submitViaGateway` in src/client.ts); the two must agree.
        if data.get("status") == "refused":
            # Even null/empty execution fields contradict a refusal. Never
            # reconcile a response-supplied hash or coerce invalid fields.
            error_code = data.get("errorCode")
            if (
                any(key in data for key in (
                    "txHash", "tx_hash", "code", "height", "events", "log", "info",
                ))
                or not isinstance(error_code, str)
                or not error_code.strip()
                or ("error" in data and not isinstance(data["error"], str))
            ):
                raise SubmissionPending(
                    hashlib.sha256(envelope).hexdigest().upper(),
                    "malformed gateway refusal; reconcile by hash",
                )
            # Auth, rate-limit and 5xx refusals keep their existing exceptions.
            # An EncodingError is different: the gateway explicitly failed before
            # broadcast, including when it reports that refusal with HTTP 500.
            # Every other status, such as the gateway's 413, is an admission
            # refusal whose reason must survive.
            if error_code != "EncodingError" and (
                resp.status_code in (401, 403, 429) or resp.status_code >= 500
            ):
                self._check_response(resp)
            raise PreAdmissionRefusal(
                error_code=error_code,
                message=data.get("error", ""),
                status_code=resp.status_code,
            )

        if data.get("status") == "pending":
            raise SubmissionPending(
                hashlib.sha256(envelope).hexdigest().upper(),
                data.get("error") if isinstance(data.get("error"), str) else "submission pending",
            )

        code = data.get("code")
        if isinstance(code, int) and not isinstance(code, bool):
            # Structured chain verdict — the engine code is authoritative.
            if code != 0:
                msg = data.get("message") or data.get("log") or data.get("error") or ""
                raise EngineError(code, msg)
            return data

        if data.get("status") == "ok":
            # Legacy gateway: CheckTx accepted, execution still unknown.
            #    A code-less `status: ok` is a SUCCESS, not a malformed body.
            return data

        tx_hash = data.get("txHash") or data.get("tx_hash")
        if tx_hash:
            # Broadcast but unresolved — NOT a rejection. The gateway pushed
            #    the tx and could not report the outcome in time (park deadline
            #    exceeded, a byte-identical tx already in flight, or a result it
            #    could not parse). It may still commit, so the caller reconciles
            #    by hash. Reporting this as an engine rejection would announce a
            #    phantom reject for an order that is about to fill, and the
            #    trader would re-place it into a double fill.
            raise SubmissionPending(str(tx_hash), str(data.get("error") or ""))

        # No code and no hash: an error string is all the gateway gave us. It
        #    still emits the "<code>: <message>" compatibility format, so an
        #    explicit non-zero code is a terminal engine verdict. Anything else
        #    proves nothing about admission, so reconcile by hash, as the TS
        #    binding's final fallback does.
        err = str(data.get("error") or data.get("message") or "")
        code = _leading_error_code(err)
        if code is not None and code > 0:
            raise EngineError(code, err)
        raise SubmissionPending(
            hashlib.sha256(envelope).hexdigest().upper(),
            "malformed /exchange response (no verdict); reconcile by hash",
        )

    # ── Info queries ─────────────────────────────────────────────────────

    def _own_owner(self) -> bytes:
        """Derive the 20-byte owner from whichever signing key is configured."""
        with self._signer_lock:
            if self._external_signer is not None:
                return pubkey_to_owner(self._external_signer.public_key)
            if self._key_handle is not None:
                return self._key_handle.owner
            if self._secret_key is not None:
                return pubkey_to_owner(generate_keypair(self._secret_key)["public_key"])
        msg = "No signer configured — pass an explicit owner, secret_key/key_handle or set_external_signer."
        raise ValueError(msg)

    @staticmethod
    def _decode_envelope(payload: t.Any, *, source: str, require_data: bool) -> t.Any:
        """Decode a gateway ``{data: base64 msgpack}`` read envelope.

        Raises ``ProofTradingSdkError`` on a JSON ``{"error": …}`` body. When
        ``require_data`` is set (value-bearing owner-scoped reads), also raises
        if the ``data`` key is absent, so a gateway/engine error or malformed
        response never silently degrades to empty account/order state. A
        present-but-nil ``data`` (e.g. an unknown withdrawal id, which the
        engine encodes as msgpack nil) decodes to ``None`` and is returned.
        """
        if isinstance(payload, dict) and payload.get("error"):
            raise ProofTradingSdkError(
                f"gateway error for {source}: {payload['error']}"
            )
        if not isinstance(payload, dict) or "data" not in payload:
            if require_data:
                raise ProofTradingSdkError(
                    f"gateway {source}: response missing 'data' envelope: "
                    f"{payload!r}"[:200]
                )
            return None
        data_b64 = payload["data"]
        if not data_b64:
            return None
        raw = base64.b64decode(data_b64)
        # Decode first, then run the strict, type-preserving preflight from the
        # shared Rust core: a payload the decoder already refuses keeps its own
        # message, and the preflight only adds rejections for bytes that decode
        # cleanly — refusing the float families so an `int(...)` coercion below
        # can never truncate an integral float into a wire integer (see #221).
        value = msgpack.unpackb(raw, raw=False, strict_map_key=False)
        try:
            reject_floats(raw)
        except ValueError as e:
            raise CodecError(f"gateway {source} preflight: {e}") from e
        return value

    def _post_info(self, info: dict[str, t.Any]) -> t.Any:
        """POST a structured ``/info`` query and return the decoded msgpack
        ``data`` payload (``None`` only for an engine "not found" nil).

        Owner-scoped reads (account, open orders, withdrawal) are deliberately
        NOT exposed as plain GETs on the gateway — it 404s ``/v1/account``,
        ``/v1/orders`` and ``/v1/withdrawal`` and requires ``POST /info``
        instead. The gateway proxies the node body verbatim as
        ``{"data": "<base64 msgpack>"}``. Mirrors the TS ``postInfoJson``: an
        ``{"error": …}`` body or a missing envelope raises rather than silently
        degrading a value-bearing read to empty state.
        """
        body = json.dumps(info).encode()
        resp = self._request(
            "POST", "/info", content=body, headers={"Content-Type": "application/json"}
        )
        return self._decode_envelope(_response_object(resp), source="/info", require_data=True)

    @staticmethod
    def _to_bytes(v: t.Any) -> bytes:
        """serde encodes ``[u8; N]`` as a msgpack ARRAY, so owner / destination
        fields decode to ``list[int]`` — coerce to ``bytes``."""
        if isinstance(v, (bytes, bytearray, list)):
            return bytes(v)
        return b""

    @staticmethod
    def _decode_position(p: t.Sequence[t.Any]) -> dict[str, t.Any]:
        """Decode one position tuple (mirrors the TS ``PositionInfo`` layout).
        Indices 6-13 are optional enrichments older gateways may omit."""

        def opt(i: int) -> int | None:
            return int(p[i]) if len(p) > i and p[i] is not None else None

        return {
            "owner": ExchangeClient._to_bytes(p[0]),
            "market": int(p[1]),
            "side": p[2],
            "entry_price": int(p[3]),
            "size": int(p[4]),
            "last_funding_index": int(p[5]) if len(p) > 5 and p[5] is not None else 0,
            "upnl_now": opt(6),
            "mm_now": opt(7),
            "im_now": opt(8),
            "pnl_if_fires": opt(9),
            "pnl_if_dies": opt(10),
            "funding_since": opt(11),
            "adl_score": opt(12),
            # Canonical first-attach input. None means migration/backfill has
            # not reached this live position; callers must never guess 1.
            "position_epoch": opt(13),
        }

    def account(self, owner: bytes | str | None = None) -> AccountState:
        """Fetch account state (balance, positions, margin) via ``POST /info``.

        Owner-scoped reads are not exposed as GETs on the gateway, so this posts
        a ``clearinghouseState`` query and decodes the returned msgpack tuple
        (mirrors the TS ``queryAccount``). If *owner* is ``None`` (default),
        uses the owner derived from the configured signing key.
        """
        if owner is None:
            owner = self._own_owner()
        raw = self._post_info({"type": "clearinghouseState", "user": _to_hex(owner)})
        if not isinstance(raw, (list, tuple)) or not raw:
            return AccountState()

        def at(i: int) -> int:
            return int(raw[i]) if len(raw) > i and raw[i] is not None else 0

        positions = (
            [
                self._decode_position(p)
                for p in raw[1]
                if isinstance(p, (list, tuple))
            ]
            if len(raw) > 1 and raw[1]
            else []
        )
        return AccountState(
            balances={"USDC": int(raw[0])},
            positions=positions,
            open_orders=[],  # not in clearinghouseState — use open_orders()
            margin={
                "equity": at(2),
                "total_mm": at(3),
                "total_im": at(4),
                "margin_ratio_bps": at(5),
            },
            raw={"tuple": list(raw)},
        )

    def open_orders(self, owner: bytes | str) -> list[dict[str, t.Any]]:
        """Open orders for *owner* via ``POST /info`` (``openOrders``).

        Returns every field in the shared wire Order, including
        ``client_order_id``, original/filled quantity, placement time, queue
        priority, time in force and post/reduce-only flags. Integers remain
        exact; ``owner`` is bytes. Legacy six-field rows use wire defaults
        (client ID None, metadata 0, Gtc, false flags).

        The gateway refuses a response body over 1 MiB rather than returning a
        shorter list. This read does not verify a finalized-state witness.
        Malformed or foreign rows raise CodecError instead of becoming empty state.
        """
        owner_hex = canonical_owner(owner)
        resp = self._request(
            "POST", "/info",
            content=json.dumps({"type": "openOrders", "user": owner_hex}).encode(),
            headers={"Content-Type": "application/json"},
        )
        payload = _response_object(resp)
        if payload.get("error") is not None:
            raise ProofTradingSdkError(f"gateway error for openOrders: {payload['error']}")
        encoded = payload.get("data")
        if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_OPEN_ORDERS_BYTES + 2) // 3):
            raise CodecError("invalid open orders data envelope")
        try:
            raw = base64.b64decode(encoded, validate=True)
            return decode_open_orders(raw, bytes.fromhex(owner_hex))
        except (ValueError, binascii.Error) as exc:
            raise CodecError("invalid open orders response") from exc

    def sub_account_list(self, owner: bytes | str) -> list[dict[str, t.Any]]:
        """Registry rows for *owner* via ``POST /info`` (``subAccountList``).

        Each row decodes from the ``proof-wire`` ``SubAccount`` positional
        array ``[master, sub_account_id, address, name, created_height]``,
        fixed byte fields as integer arrays or bins (mirrors the TS
        ``decodeSubAccountList``). Any malformed payload, row or field raises
        ``CodecError`` rather than degrading to an empty registry. An HTTP 501
        from the route raises like any other non-OK response and means the
        registry query is not available, never an empty registry.
        """
        raw = self._post_info({"type": "subAccountList", "user": _to_hex(owner)})
        if not isinstance(raw, (list, tuple)):
            raise CodecError(f"sub-account list decode: expected an array, got {type(raw).__name__}")
        if len(raw) > _SUB_ACCOUNT_MAX_ROWS:
            raise CodecError(
                f"sub-account list decode: exceeds {_SUB_ACCOUNT_MAX_ROWS} rows"
            )
        rows: list[dict[str, t.Any]] = []
        seen_ids: set[int] = set()
        seen_addresses: set[bytes] = set()
        for row in raw:
            if not isinstance(row, (list, tuple)):
                raise CodecError("sub-account list decode: row (expected a positional array)")
            if len(row) < _SUB_ACCOUNT_ROW_FIELDS:
                raise CodecError(
                    f"sub-account list decode: row (expected "
                    f"{_SUB_ACCOUNT_ROW_FIELDS} fields, got {len(row)})"
                )
            master, row_id, address, name, height = row[:_SUB_ACCOUNT_ROW_FIELDS]
            decoded = {
                "address": _sub_account_bytes(address, 20, "address"),
                "master": _sub_account_bytes(master, 20, "master"),
                "id": _sub_account_int(row_id, 1, 0xFFFFFFFF, "id"),
                "name": _sub_account_name(name),
                "created_height": _sub_account_int(height, 0, 2**64 - 1, "created_height"),
            }
            if decoded["id"] in seen_ids:
                raise CodecError(f"sub-account list decode: duplicate id {decoded['id']}")
            if decoded["address"] in seen_addresses:
                raise CodecError("sub-account list decode: duplicate address")
            seen_ids.add(decoded["id"])
            seen_addresses.add(decoded["address"])
            rows.append(decoded)
        return rows

    def withdrawal_status(self, withdrawal_id: int) -> dict[str, t.Any] | None:
        """Withdrawal record by id via ``POST /info`` (``withdrawalStatus``).

        Returns ``None`` for unknown ids (the engine encodes "not found" as
        msgpack ``nil``).
        """
        raw = self._post_info(
            {"type": "withdrawalStatus", "withdrawalId": int(withdrawal_id)}
        )
        if not isinstance(raw, (list, tuple)) or len(raw) < 6:
            return None
        return {
            "id": int(raw[0]),
            "owner": self._to_bytes(raw[1]),
            "amount": int(raw[2]),
            "solana_destination": self._to_bytes(raw[3]),
            "status": raw[4],
            "request_height": int(raw[5]),
        }

    def nonce_info(self, owner: bytes | str) -> dict[str, t.Any]:
        resp = self._get(f"/v1/nonce/{_to_hex(owner)}")
        return _response_object(resp)

    def authorities(self) -> AuthoritiesSnapshot:
        """Read the six operator-authority sets. HTTP/decode failures remain errors.

        Addresses are 20-byte values. These are gateway-reported membership
        facts, without a witness or proof of action authorization.
        """
        return decode_authorities_snapshot(_response_object(self._get("/v1/admin/authorities")))

    def liquidation_config(self) -> LiquidationConfigInfo:
        """Read the stored global liquidation configuration and exact sequence.

        No default configuration is synthesized on a failed read. Retired
        pacing fields are preserved as wire facts, not enforced limits.
        """
        return decode_liquidation_config_info(_response_object(self._get("/v1/liquidation-config")))

    def _get_data(self, path: str, params: dict[str, t.Any] | None = None) -> t.Any:
        """GET a ``/v1/*`` read endpoint and decode the ``{data: base64 msgpack}``
        envelope the gateway returns (markets, orderbook, adl-queue, …). Raises
        on a JSON ``{"error": …}`` body; a missing envelope yields ``None`` (the
        callers default to an empty list)."""
        resp = self._get(path, params=params)
        return self._decode_envelope(_response_object(resp), source=path, require_data=False)

    @staticmethod
    def _trigger_tuple(value: t.Any, name: str, size: int) -> t.Sequence[t.Any]:
        if not isinstance(value, (list, tuple)) or len(value) != size:
            raise ProofTradingSdkError(
                f"trigger decode: {name} must be exactly a {size}-field tuple"
            )
        return value

    @staticmethod
    def _trigger_uint(
        value: t.Any, name: str, maximum: int = (1 << 64) - 1
    ) -> int:
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            or value > maximum
        ):
            raise ProofTradingSdkError(
                f"trigger decode: {name} is not an exact unsigned integer"
            )
        return value

    @staticmethod
    def _trigger_label(value: t.Any, name: str) -> str:
        if not isinstance(value, str) or value == "":
            raise ProofTradingSdkError(
                f"trigger decode: {name} must be a non-empty string"
            )
        return value

    @classmethod
    def _decode_trigger_evaluation(cls, value: t.Any) -> dict[str, t.Any] | None:
        if value is None:
            return None
        row = cls._trigger_tuple(value, "TriggerEvaluation", 7)
        reason = None if row[6] is None else cls._trigger_label(row[6], "TriggerOutcomeReason")
        requested = cls._trigger_uint(row[3], "evaluation.requested_quantity")
        filled = cls._trigger_uint(row[4], "evaluation.filled_quantity")
        residual = cls._trigger_uint(row[5], "evaluation.residual_quantity")
        if filled + residual != requested:
            raise ProofTradingSdkError("trigger decode: evaluation quantities do not conserve")
        return {
            "height": cls._trigger_uint(row[0], "evaluation.height"),
            "frozen_mark": cls._trigger_uint(row[1], "evaluation.frozen_mark"),
            "limit_price": (
                None
                if row[2] is None
                else cls._trigger_uint(row[2], "evaluation.limit_price")
            ),
            "requested_quantity": requested,
            "filled_quantity": filled,
            "residual_quantity": residual,
            "reason": reason,
        }

    @classmethod
    def _decode_trigger_limb(cls, value: t.Any) -> dict[str, t.Any] | None:
        if value is None:
            return None
        row = cls._trigger_tuple(value, "StoredTriggerLimb", 7)
        cls._trigger_label(row[1], "TriggerKind")
        cls._trigger_label(row[5], "TriggerLimbState")
        limb_id = cls._trigger_uint(row[0], "limb_id")
        trigger_price = cls._trigger_uint(row[2], "trigger_price")
        max_slippage_bps = cls._trigger_uint(
            row[3], "max_slippage_bps", (1 << 32) - 1
        )
        client_trigger_id = (
            None
            if row[4] is None
            else cls._trigger_uint(row[4], "client_trigger_id")
        )
        if limb_id == 0 or trigger_price == 0:
            raise ProofTradingSdkError(
                "trigger decode: limb id and trigger price must be non-zero"
            )
        if not 1 <= max_slippage_bps <= 9_999:
            raise ProofTradingSdkError(
                "trigger decode: limb slippage is outside 1..=9999"
            )
        if client_trigger_id == 0:
            raise ProofTradingSdkError(
                "trigger decode: client trigger id must be non-zero"
            )
        return {
            "limb_id": limb_id,
            "kind": row[1],
            "trigger_price": trigger_price,
            "max_slippage_bps": max_slippage_bps,
            "client_trigger_id": client_trigger_id,
            "state": row[5],
            "last_evaluation": cls._decode_trigger_evaluation(row[6]),
        }

    @classmethod
    def _decode_trigger_info(cls, value: t.Any) -> dict[str, t.Any]:
        row = cls._trigger_tuple(value, "PositionTriggerInfo", 3)
        bracket = cls._trigger_tuple(row[0], "PositionTriggerBracket", 10)
        config = None
        if row[1] is not None:
            cfg = cls._trigger_tuple(row[1], "TriggerMarketConfig", 6)
            if not isinstance(cfg[1], bool):
                raise ProofTradingSdkError(
                    "trigger decode: config.enabled is not boolean"
                )
            config = {
                "version": cls._trigger_uint(cfg[0], "config.version"),
                "enabled": cfg[1],
                "max_trigger_slippage_bps": cls._trigger_uint(
                    cfg[2], "config.max_trigger_slippage_bps", (1 << 32) - 1
                ),
                "max_mark_age_ms": cls._trigger_uint(
                    cfg[3], "config.max_mark_age_ms"
                ),
                "max_future_publish_skew_ms": cls._trigger_uint(
                    cfg[4], "config.max_future_publish_skew_ms"
                ),
                "max_active_brackets": cls._trigger_uint(
                    cfg[5], "config.max_active_brackets"
                ),
            }
            if config["version"] == 0:
                raise ProofTradingSdkError("trigger decode: config version is zero")
            if config["max_trigger_slippage_bps"] > 9_999:
                raise ProofTradingSdkError(
                    "trigger decode: config slippage exceeds 9999"
                )
            if config["enabled"] and (
                config["max_trigger_slippage_bps"] == 0
                or config["max_mark_age_ms"] == 0
                or config["max_future_publish_skew_ms"] == 0
                or config["max_active_brackets"] == 0
            ):
                raise ProofTradingSdkError(
                    "trigger decode: enabled config has a zero bound"
                )
        availability: dict[str, t.Any]
        if isinstance(row[2], str):
            availability = {
                "kind": cls._trigger_label(row[2], "TriggerEffectiveAvailability")
            }
        elif isinstance(row[2], dict) and len(row[2]) == 1:
            ((kind, reason),) = row[2].items()
            availability = {
                "kind": cls._trigger_label(kind, "TriggerEffectiveAvailability"),
                "reason": cls._trigger_label(reason, "TriggerOutcomeReason"),
            }
        else:
            raise ProofTradingSdkError(
                "trigger decode: malformed TriggerEffectiveAvailability"
            )
        if bracket[4] not in ("Buy", "Sell"):
            raise ProofTradingSdkError(
                f"trigger decode: unknown position side {bracket[4]!r}"
            )
        stop_loss = cls._decode_trigger_limb(bracket[8])
        take_profit = cls._decode_trigger_limb(bracket[9])
        if stop_loss is None and take_profit is None:
            raise ProofTradingSdkError("trigger decode: bracket has no limbs")
        # A later kind passes through; a slot holding the other known kind is
        # a corrupt row.
        if stop_loss is not None and stop_loss["kind"] == "TakeProfit":
            raise ProofTradingSdkError("trigger decode: stop_loss has wrong kind")
        if take_profit is not None and take_profit["kind"] == "StopLoss":
            raise ProofTradingSdkError("trigger decode: take_profit has wrong kind")
        if stop_loss is not None and take_profit is not None and (
            stop_loss["limb_id"] == take_profit["limb_id"]
            or (
                stop_loss["client_trigger_id"] is not None
                and stop_loss["client_trigger_id"]
                == take_profit["client_trigger_id"]
            )
        ):
            raise ProofTradingSdkError(
                "trigger decode: bracket has duplicate limb identity"
            )
        group_id = cls._trigger_uint(bracket[0], "group_id")
        position_epoch = cls._trigger_uint(bracket[3], "position_epoch")
        accepted_height = cls._trigger_uint(bracket[5], "accepted_height")
        active_from_height = cls._trigger_uint(bracket[6], "active_from_height")
        client_group_id = (
            None
            if bracket[7] is None
            else cls._trigger_uint(bracket[7], "client_group_id")
        )
        if group_id == 0 or position_epoch == 0 or accepted_height == 0:
            raise ProofTradingSdkError(
                "trigger decode: bracket ids/heights must be non-zero"
            )
        if client_group_id == 0:
            raise ProofTradingSdkError(
                "trigger decode: client group id must be non-zero"
            )
        if active_from_height != accepted_height + 1:
            raise ProofTradingSdkError("trigger decode: invalid active_from_height")
        owner = cls._to_bytes(bracket[1])
        if len(owner) != 20:
            raise ProofTradingSdkError(
                "trigger decode: owner must be exactly 20 bytes"
            )
        return {
            "bracket": {
                "group_id": group_id,
                "owner": owner,
                "market": cls._trigger_uint(
                    bracket[2], "market", (1 << 32) - 1
                ),
                "position_epoch": position_epoch,
                "position_side": bracket[4],
                "accepted_height": accepted_height,
                "active_from_height": active_from_height,
                "client_group_id": client_group_id,
                "stop_loss": stop_loss,
                "take_profit": take_profit,
            },
            "market_config": config,
            "availability": availability,
        }

    def position_triggers(
        self, owner: bytes | str | None = None
    ) -> list[dict[str, t.Any]]:
        """Current stop-loss/take-profit brackets for one owner.

        Uses the public node/gateway ``GET /v1/triggers/{owner}`` route. This
        is current state only; no trigger-history endpoint is implied.
        """
        if owner is None:
            owner = self._own_owner()
        owner_hex = _to_hex(owner)
        if len(owner_hex) != 40 or any(c not in "0123456789abcdefABCDEF" for c in owner_hex):
            raise ValueError("trigger owner must be a 40-character hex address")
        path = f"/v1/triggers/{owner_hex.lower()}"
        resp = self._get(path)
        raw = self._decode_envelope(_response_object(resp), source=path, require_data=True)
        if not isinstance(raw, (list, tuple)):
            raise ProofTradingSdkError("trigger decode: response is not an array")
        return [self._decode_trigger_info(item) for item in raw]

    def trigger_status(self) -> dict[str, t.Any]:
        """Fail-closed next-height trigger admission status.

        Deprecated: ``GET /v1/triggers/status`` is deleted upstream. The node
        dropped it with its activation gates (exchange#619, genesis-first) and
        the gateway drops it in gateway 4.0.0 (api-gateway#175). Trigger
        actions are permanently active, so there is nothing to read, and this
        call fails with the 404 response error once a gateway or node stops
        serving the route. It will be removed in the next major version.

        Python's JSON decoder preserves arbitrary-size integers, so both
        heights remain exact ``int`` values.
        """
        data = _response_object(self._get("/v1/triggers/status"))
        try:
            finalized = data["finalized_height"]
            admission = data["admission_height"]
            active = data["actions_active"]
        except KeyError as exc:
            raise ProofTradingSdkError(
                f"trigger status decode: missing {exc.args[0]}"
            ) from exc
        if (
            isinstance(finalized, bool)
            or not isinstance(finalized, int)
            or not 0 <= finalized <= (1 << 64) - 1
            or isinstance(admission, bool)
            or not isinstance(admission, int)
            or not 0 <= admission <= (1 << 64) - 1
            or not isinstance(active, bool)
        ):
            raise ProofTradingSdkError("trigger status decode: malformed fields")
        if admission != finalized + 1:
            raise ProofTradingSdkError(
                "trigger status decode: admission height is not next height"
            )
        return {
            "finalized_height": finalized,
            "admission_height": admission,
            "actions_active": active,
        }

    def trigger_market_configs(self) -> list[TriggerMarketConfigInfo]:
        """Complete governed trigger policy, sorted by market id.

        Missing markets are disabled. A malformed/missing envelope is an error;
        this method never substitutes a permissive client-side default.
        """
        path = "/v1/triggers/markets"
        raw = self._decode_envelope(
            _response_object(self._get(path)), source=path, require_data=True
        )
        return decode_trigger_market_config_infos(raw)

    @staticmethod
    def _decode_market_config(raw: t.Sequence[t.Any]) -> dict[str, t.Any]:
        """Decode a market-config tuple (the wire ``MarketConfig``)."""

        def opt(i: int) -> int | None:
            return int(raw[i]) if len(raw) > i and raw[i] is not None else None

        def at(i: int) -> int:
            return int(raw[i]) if len(raw) > i and raw[i] is not None else 0

        def flag(i: int) -> bool | None:
            return None if len(raw) <= i or raw[i] is None else bool(raw[i])

        kind: t.Any = None
        k = raw[7] if len(raw) > 7 else None
        if isinstance(k, str):
            kind = k
        elif isinstance(k, dict):
            for variant in ("ConditionalPerp", "PredictionBinary"):
                v = k.get(variant)
                if isinstance(v, (list, tuple)) and len(v) >= 2:
                    kind = {variant: [int(v[0]), v[1]]}
                    break

        fee_tiers = None
        if len(raw) > 13 and isinstance(raw[13], (list, tuple)):
            fee_tiers = [
                {
                    "min_30d_volume_micro_usdc": int(ft[0]),
                    "maker_fee_tenth_bps": int(ft[1]),
                    "taker_fee_tenth_bps": int(ft[2]),
                }
                for ft in raw[13]
                if isinstance(ft, (list, tuple)) and len(ft) >= 3
            ]

        return {
            "market": at(0),
            "im_bps": at(1),
            "mm_bps": at(2),
            "taker_fee_bps": at(3),
            "maker_fee_bps": at(4),
            "funding_interval_ms": at(5),
            "max_funding_rate_bps": at(6),
            "kind": kind,
            "max_position_size": opt(8),
            "default_ttl_ms": opt(9),
            "net_delta_margin": flag(10),
            "pool_id": opt(11),
            "mark_price_max_oracle_age_ms": opt(12),
            "fee_tiers": fee_tiers,
            "tick_size": opt(14),
            "lot_size": opt(15),
            "primary_oracle_signer": (
                ExchangeClient._to_bytes(raw[16])
                if len(raw) > 16 and raw[16] is not None
                else None
            ),
            "oracle_staleness_ms": opt(17),
            "mark_source_mode": (
                raw[18] if len(raw) > 18 and raw[18] is not None else None
            ),
            "max_mark_spread_bps": opt(19),
            "cex_composite_staleness_ms": opt(20),
            "sz_decimals": opt(21),
            "ticker": None if len(raw) <= 22 or raw[22] is None else str(raw[22]),
            "max_open_interest": opt(23),
        }

    def markets(self) -> list[dict[str, t.Any]]:
        """All registered market configs, decoded from the msgpack envelope."""
        raw = self._get_data("/v1/markets")
        if not isinstance(raw, (list, tuple)):
            return []
        return [
            self._decode_market_config(m) for m in raw if isinstance(m, (list, tuple))
        ]

    def markets_snapshot(self, timeout: float = 10.0) -> MarketsSnapshot:
        """Every market, event and per-market open interest from one committed
        state view, bound to this client's chain.

        A wrong chain, an uncommitted height or any malformed part refuses the
        whole read with :class:`CodecError`; nothing partial is returned. The
        client must be bound to a real chain, not the zero binding.

        The body is requested and read uncompressed, and refused once it passes
        ``MAX_MARKETS_SNAPSHOT_BYTES``, before it is buffered whole; a
        compressed body is refused unread. ``timeout`` limits each network wait
        and, checked between body chunks, the whole read, so a body that
        trickles in fails with :class:`TransportError`. It is not a whole-call
        deadline: httpx has none, so response headers that arrive slowly enough
        can hold the call longer. Only HTTP 200 supplies data; redirects are
        not followed.
        """
        url = urljoin(self._gateway_url, "/v1/markets-snapshot")
        deadline = time.monotonic() + timeout
        body = bytearray()
        try:
            with self._http.stream(
                "GET",
                url,
                headers={"Accept-Encoding": "identity"},
                timeout=httpx.Timeout(timeout),
                follow_redirects=False,
            ) as resp:
                self._parse_rate_limits(resp)
                encoding = resp.headers.get("Content-Encoding", "identity").lower()
                identity = encoding in ("", "identity")
                if resp.status_code != 200:
                    # Map the status with whatever prefix of an uncompressed
                    # error body arrives within 200 bytes and the deadline.
                    prefix = b""
                    for chunk in resp.iter_bytes() if identity else ():
                        prefix += chunk[: 200 - len(prefix)]
                        if len(prefix) >= 200 or time.monotonic() > deadline:
                            break
                    headers = resp.headers.copy()
                    for name in ("Content-Encoding", "Content-Length"):
                        headers.pop(name, None)
                    self._check_response(
                        httpx.Response(
                            resp.status_code,
                            headers=headers,
                            content=prefix,
                            request=resp.request,
                        )
                    )
                    raise TransportError(
                        f"markets snapshot: unexpected HTTP {resp.status_code}",
                        status_code=resp.status_code,
                    )
                if not identity:
                    raise CodecError(
                        f"markets snapshot: refused content encoding {encoding!r}"
                    )
                # No decoder runs: every encoding but identity is refused above.
                for chunk in resp.iter_bytes():
                    if len(body) + len(chunk) > MAX_MARKETS_SNAPSHOT_BYTES:
                        raise CodecError(
                            "markets snapshot: response exceeds "
                            f"{MAX_MARKETS_SNAPSHOT_BYTES} bytes"
                        )
                    body += chunk
                    if time.monotonic() > deadline:
                        raise TransportError(
                            f"markets snapshot: not complete within {timeout}s"
                        )
        except httpx.TimeoutException as e:
            raise TransportError(f"markets snapshot: timed out: {e}") from e
        except httpx.RequestError as e:
            raise TransportError(f"markets snapshot: request failed: {e}") from e
        return decode_markets_snapshot(bytes(body), self._chain_id)

    def market_status(self, market: int) -> dict[str, t.Any]:
        resp = self._get(f"/v1/market-status/{market}")
        return _response_object(resp)

    def trades(self, market: int) -> list[dict[str, t.Any]]:
        resp = self._get(f"/v1/trades/{market}")
        return _response_json(resp)

    # ── History ─────────────────────────────────────────────────────────

    def history_candles(
        self,
        market: int,
        resolution: str = "1m",
        *,
        from_: CandleHistoryTime | None = None,
        to: CandleHistoryTime | None = None,
        limit: int = 1500,
    ) -> CandleHistoryPage:
        """Durable OHLCV history through ``GET /v1/history/candles``.

        Times accept RFC3339 strings or integer epoch milliseconds. The newest
        ``limit`` buckets in the window are returned oldest first; empty buckets
        are omitted. Prices and volumes remain exact decimal strings. Read older
        bars with ``to=page.candles[0].time`` when ``page.has_more`` is true.
        An empty window can still have older history; use ``to=page.from_`` then.
        Coarser boundary bars may be partial, including under the server's
        default window; align ``from_`` and ``to`` for complete bars.
        The server rejects windows wider than roughly 50,000 resolution widths.
        This is an indexer read, not a witnessed finalized-state proof.
        """
        params = candle_history_params(market, resolution, from_, to, limit)
        body = _response_json(self._get("/v1/history/candles", params))
        return decode_candle_history(body, market=market, resolution=resolution, limit=limit)

    def history_fills(
        self,
        owner: bytes | str,
        cursor: str | None = None,
        limit: int = 100,
    ) -> CursorPage:
        return self._cursor_page(
            "GET", "/v1/history/fills", locals(), data_key="fills"
        )

    def history_funding(
        self,
        owner: bytes | str,
        after_height: int | None = None,
        limit: int = 100,
        *,
        cursor: str | None = None,
    ) -> CursorPage:
        """Indexed funding payments for this account. Continue with next_cursor until None."""
        owner_hex = canonical_owner(owner)
        return self._account_history_rows(
            f"/v1/history/funding-payments/{owner_hex}", "funding_payments",
            owner_hex, {"limit": limit, "cursor": cursor}, after_height, max_limit=1000,
        )

    def history_positions(
        self,
        owner: bytes | str,
        after_height: int | None = None,
        limit: int = 100,
        *,
        cursor: str | None = None,
    ) -> CursorPage:
        """Position history for this account. Continue with next_cursor until None."""
        owner_hex = canonical_owner(owner)
        return self._account_history_rows(
            "/v1/history/positions", "positions", owner_hex,
            {"owner": owner_hex, "limit": limit, "cursor": cursor}, after_height, max_limit=5000,
        )

    def _account_history_rows(
        self, path: str, key: str, owner: str, params: dict[str, t.Any], after_height: int | None,
        *, max_limit: int,
    ) -> CursorPage:
        if after_height is not None:
            raise ValueError("after_height is unsupported; paginate with cursor instead")
        limit = params["limit"]
        if type(limit) is not int or not 1 <= limit <= max_limit:
            raise ValueError(f"history limit must be between 1 and {max_limit}")
        if params["cursor"] == "":
            raise ValueError("cursor must be a nonempty continuation token")
        response = self._get(path, params={k: v for k, v in params.items() if v is not None})
        try:
            page = response.json()
        except ValueError as exc:
            raise TransportError("invalid JSON in account history", status_code=response.status_code) from exc
        if not isinstance(page, dict) or not isinstance(page.get(key), list):
            raise CodecError(f"expected an account history page with {key} rows")
        rows = page[key]
        if any(not isinstance(row, dict) or row.get("owner") != owner for row in rows):
            raise CodecError("unexpected account history row owner")
        token = page.get("next_cursor")
        if "next_cursor" not in page or (token is not None and not isinstance(token, str)):
            raise CodecError("invalid account history cursor")
        return CursorPage(data=rows, next_cursor=token or None, raw=page)

    def history_account_events(
        self,
        owner: bytes | str,
        after_id: int | None = None,
        limit: int = 100,
        *,
        order: t.Literal["asc", "desc"] = "desc",
        cursor: str | None = None,
    ) -> CursorPage:
        """Account events, newest first by default; reuse the returned cursor
        with the same owner and ordering until next_cursor is None.
        Each page accepts a limit of 1 to 5000 events.
        """
        owner_hex = canonical_owner(owner)
        if type(limit) is not int or not 1 <= limit <= 5000:
            raise ValueError("account event limit must be an integer between 1 and 5000")
        if after_id is not None:
            raise ValueError("after_id is unsupported; paginate with cursor instead")
        if cursor == "":
            raise ValueError("cursor must be a nonempty continuation token")
        if order not in ("asc", "desc"):
            raise ValueError("order must be 'asc' or 'desc'")
        page = self._cursor_page(
            "GET", "/v1/history/account-events",
            {"owner": owner_hex, "order": order, "limit": limit, "cursor": cursor},
            data_key="account_events",
        )
        if not isinstance(page.raw.get("account_events"), list):
            raise CodecError("expected account_events rows in account history page")
        if "next_cursor" not in page.raw or (page.next_cursor is not None and not isinstance(page.next_cursor, str)):
            raise CodecError("invalid account event cursor")
        if page.next_cursor == "":
            page.next_cursor = None
        return page

    def history_triggers(
        self,
        owner: bytes | str | None = None,
        *,
        market: int | None = None,
        from_: TriggerHistoryTime | None = None,
        to: TriggerHistoryTime | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> PositionTriggerHistoryPage:
        """Immutable owner-bearing trigger lifecycle history, newest first.

        The route is gateway/indexer-owned. Coordinates, market ids, and every
        numeric protocol value in ``payload`` remain decimal strings; callers
        must pass ``next_cursor`` back unchanged with the same filters.
        """
        route_owner = canonical_owner(self._own_owner() if owner is None else owner)
        params = history_params(
            market=market,
            from_=from_,
            to=to,
            limit=limit,
            cursor=cursor,
        )
        resp = self._get(
            f"/v1/history/triggers/{route_owner}", params=params or None
        )
        data = _response_object(resp)
        return decode_position_trigger_history_page(data, route_owner, market)

    def history_trigger_markets(
        self,
        market: int,
        *,
        from_: TriggerHistoryTime | None = None,
        to: TriggerHistoryTime | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> TriggerMarketHistoryPage:
        """Shared market deferred/resumed transitions, never owner-duplicated."""
        route_market = validate_market(market)
        params = history_params(
            from_=from_,
            to=to,
            limit=limit,
            cursor=cursor,
        )
        resp = self._get(
            f"/v1/history/trigger-markets/{route_market}", params=params or None
        )
        data = _response_object(resp)
        return decode_trigger_market_history_page(data, route_market)

    def history_status(self) -> dict[str, t.Any]:
        resp = self._get("/v1/history/status")
        return _response_object(resp)

    # ── Health & status ──────────────────────────────────────────────────

    def health(self) -> dict[str, t.Any]:
        """Gateway health check: ``GET /v1/health``."""
        resp = self._get("/v1/health")
        return _response_object(resp)

    def status(self) -> dict[str, t.Any]:
        """CometBFT node status via the gateway: ``GET /v1/status``.

        The gateway proxies CometBFT ``/status`` and returns it verbatim
        (``result.sync_info``, ``result.node_info``, etc.).
        """
        resp = self._get("/v1/status")
        return _response_object(resp)

    def get_block(self, height: int | None = None) -> dict[str, t.Any]:
        """CometBFT block at *height* (latest if omitted) via ``GET /v1/block``."""
        params = {"height": height} if height is not None else None
        resp = self._get("/v1/block", params=params)
        return _response_object(resp)

    def finalized_account_state(
        self, owner: bytes | str, *, timeout: float = 5.0,
    ) -> FinalizedAccountState:
        """Raw settled account facts with a height-bound gateway witness.

        Reads only ``/v1/account/{owner}/state?witness=1``. No valuation,
        fallback or automatic header request. To check H+1 consistency, call
        ``block_header`` with an explicit chain pin and then ``verify_witness``.
        The same gateway supplying both is not independent authentication.
        HTTP bounds and synchronous timeout limitations match ``block_header``.
        """
        from proof_trading_sdk._bounded_read import bounded_gateway_json

        bound_owner = account_state_owner(owner)
        response = bounded_gateway_json(
            self._http, urljoin(self._gateway_url, f"/v1/account/{bound_owner}/state"),
            {"witness": "1"}, timeout=timeout, on_response=self._parse_rate_limits,
            check_response=self._check_response,
        )
        return decode_finalized_account_state(response, bound_owner)
    def _finalized_account_read(self, path: str, params: dict[str, str], timeout: float) -> dict[str, t.Any]:
        from proof_trading_sdk._bounded_read import bounded_gateway_json

        return bounded_gateway_json(
            self._http, urljoin(self._gateway_url, path), params, timeout=timeout,
            on_response=self._parse_rate_limits, check_response=self._check_response,
        )

    def finalized_account(self, owner: bytes | str, *, timeout: float = 5.0) -> FinalizedAccountInfo:
        """Engine-valued account and gateway witness; no recomputation or authorization guarantee."""
        owner = _address(owner)
        return decode_finalized_account(self._finalized_account_read(
            f"/v1/account/{owner}", {"witness": "1"}, timeout,
        ), owner)

    def finalized_agent_authorization(self, owner: bytes | str, agent: bytes | str, *, timeout: float = 5.0) -> FinalizedAgentAuthorization:
        """Bare authorization fact; owner, agent and height rely on the gateway."""
        owner, agent = _address(owner), _address(agent)
        return decode_finalized_agent_authorization(self._finalized_account_read(
            f"/v1/account/{owner}/agents/{agent}", {"witness": "1"}, timeout,
        ), owner, agent)

    def finalized_recent_nonces(self, signer: bytes | str, *, timeout: float = 5.0) -> FinalizedRecentNonces:
        """Prunable retained nonces, never a lifetime floor or absence proof."""
        signer = _address(signer)
        return decode_finalized_recent_nonces(self._finalized_account_read(
            f"/v1/account/{signer}/recent-nonces", {"witness": "1"}, timeout,
        ), signer)

    def finalized_open_orders(self, owner: bytes | str, *, limit: int = 101, timeout: float = 5.0) -> FinalizedOpenOrders:
        """Owner-bound current 14-field orders; complete is false at the requested limit."""
        owner, limit = _address(owner), _limit(limit)
        return decode_finalized_open_orders(self._finalized_account_read(
            f"/v1/orders/{owner}", {"limit": str(limit), "witness": "1"}, timeout,
        ), owner, limit)

    def finalized_orderbook(self, market: int, *, depth: int = 20, timeout: float = 5.0) -> FinalizedOrderbook:
        """Height-bound book at depth 1, 20 or 100; never a full-book assertion."""
        from proof_trading_sdk._bounded_read import bounded_gateway_json
        orderbook_request(market, depth)
        body = bounded_gateway_json(
            self._http, urljoin(self._gateway_url, f"/v1/orderbook-snapshot/{market}"),
            {"depth": str(depth)}, timeout=timeout, on_response=self._parse_rate_limits,
            check_response=self._check_response,
        )
        return decode_finalized_orderbook(body, market, depth)

    def finalized_markets_snapshot(self, *, chain_id: str | bytes, timeout: float = 10.0) -> FinalizedMarketsSnapshot:
        """Existing atomic snapshot plus witness; an explicit chain pin is required.

        Uses bounded HTTP without fallback. Witness comparison does not prove
        payload contents, validator signatures, freshness or action permission.
        """
        from proof_trading_sdk._bounded_read import bounded_gateway_json
        chain = _chain_pin(chain_id)
        body = bounded_gateway_json(
            self._http, urljoin(self._gateway_url, "/v1/markets-snapshot"), {},
            timeout=timeout, on_response=self._parse_rate_limits, check_response=self._check_response,
        )
        return decode_finalized_markets_snapshot(body, chain_id=chain)

    def block_header(
        self, height: int, *, chain_id: str | bytes, timeout: float = 5.0,
    ) -> BlockEvidenceHeader:
        """Chain-pinned gateway header, without validator-signature verification.

        ``chain_id`` must be supplied explicitly; constructor/env defaults are
        not used as a trust pin. The full ``/v1/block`` response is fetched and
        capped at 1 MiB, 4096 nonempty chunks and JSON depth 32. Duplicate keys
        at any depth, malformed UTF-8 and compressed bodies are refused.

        ``timeout`` is in seconds (default 5, minimum 0.001, maximum 60). It
        bounds network waits and elapsed time between chunks, not the whole
        call: slowly arriving headers or custom transports may run longer.
        HTTP refusals retain existing exception types; their bodies are not
        read. There is no retry, redirect, unheighted or direct-node fallback.
        """
        from proof_trading_sdk._bounded_read import bounded_gateway_json

        chain = _chain_pin(chain_id)
        _requested_height(height)
        response = bounded_gateway_json(
            self._http, urljoin(self._gateway_url, "/v1/block"), {"height": str(height)},
            timeout=timeout, on_response=self._parse_rate_limits,
            check_response=self._check_response,
        )
        return decode_block_evidence_header(response, height=height, chain_id=chain)

    def transaction_evidence(
        self, tx_hash: str, signed_bytes: bytes, *, chain_id: str | bytes, timeout: float = 5.0,
    ) -> TransactionEvidence:
        """Read one exact transaction occurrence and bind it to its block.

        Two bounded GETs share one timeout; no polling, signing or submission.
        Checks SHA256, transaction index, block data hash and explicit chain pin.
        Gateway execution codes/events remain trusted observations. Validator
        signatures and the block header's own hash are not verified. A replay
        rejection cannot rule out earlier admission of the same signed bytes.
        """
        return read_transaction_evidence(self, tx_hash, signed_bytes, chain_id=chain_id, timeout=timeout)

    def block_results_range(
        self, from_height: int, through_height: int, *, chain_id: str | bytes,
        timeout: float = 5.0, max_heights: int = 32,
        max_decoded_bytes: int = 8 * 1024 * 1024, max_transactions: int = 10_000,
        max_events: int = 16_384, max_attributes: int = 65_536,
    ) -> BlockResultsRange:
        """Read an exact inclusive height range, including rejected transactions.

        Binds contiguous headers, transaction roots/counts and H+1 post-state.
        All requests share one timeout and aggregate limits; no partial success.
        Gateway trust and synchronous timeout limits match ``block_header``.
        """
        return read_block_results(
            self, through_height, from_height=from_height, chain_id=chain_id, timeout=timeout,
            max_heights=max_heights, max_decoded_bytes=max_decoded_bytes,
            max_transactions=max_transactions, max_events=max_events, max_attributes=max_attributes,
        )

    def block_results_window(
        self, from_ms: int, to_ms: int, through_height: int, *, chain_id: str | bytes,
        timeout: float = 5.0, max_heights: int = 32,
        max_decoded_bytes: int = 8 * 1024 * 1024, max_transactions: int = 10_000,
        max_events: int = 16_384, max_attributes: int = 65_536,
    ) -> BlockResultsWindow:
        """Scan backwards until before ``from_ms`` or genesis, retaining boundaries.

        ``through_height`` must reach ``to_ms``. Results are ascending and may
        include blocks outside [from_ms,to_ms); apply that filter explicitly.
        Equal/sub-millisecond block times remain exact. No partial success when
        a budget is exhausted; gateway trust remains essential.
        """
        result = read_block_results(
            self, through_height, from_ms=from_ms, to_ms=to_ms, chain_id=chain_id, timeout=timeout,
            max_heights=max_heights, max_decoded_bytes=max_decoded_bytes,
            max_transactions=max_transactions, max_events=max_events, max_attributes=max_attributes,
        )
        assert isinstance(result, BlockResultsWindow)
        return result

    def get_block_results(self, height: int) -> dict[str, t.Any]:
        """CometBFT block results at *height* via ``GET /v1/block_results``."""
        resp = self._get("/v1/block_results", params={"height": height})
        return _response_object(resp)

    # ── Market data ──────────────────────────────────────────────────────

    def ticker(self, market: int) -> dict[str, t.Any] | None:
        """One-round-trip market summary: ``GET /v1/ticker/{market}``.

        Returns ``None`` if the market is unknown or the endpoint 404s.
        """
        try:
            resp = self._get(f"/v1/ticker/{market}")
            return _response_object(resp)
        except TransportError as e:
            if e.status_code == 404:
                return None
            raise

    def orderbook(self, market: int) -> dict[str, t.Any]:
        """L2 orderbook snapshot via ``GET /v1/orderbook/{market}``.

        Decodes the msgpack ``[bids, asks]`` envelope into
        ``{"bids": [...], "asks": [...]}`` where each level is
        ``{price, total_qty, order_count}`` (mirrors TS ``queryOrderbook``).
        """
        raw = self._get_data(f"/v1/orderbook/{market}")
        if not isinstance(raw, (list, tuple)) or len(raw) < 2:
            return {"bids": [], "asks": []}

        def level(lv: t.Sequence[t.Any]) -> dict[str, int]:
            return {
                "price": int(lv[0]),
                "total_qty": int(lv[1]),
                "order_count": int(lv[2]),
            }

        return {
            "bids": [
                level(lv) for lv in (raw[0] or []) if isinstance(lv, (list, tuple))
            ],
            "asks": [
                level(lv) for lv in (raw[1] or []) if isinstance(lv, (list, tuple))
            ],
        }

    def adl_queue(self, market: int) -> list[dict[str, t.Any]]:
        """ADL (auto-deleveraging) queue for *market* via ``GET /v1/adl/queue/{market}``.

        Decodes the msgpack 6-tuples ``[owner, market, side, size, upnl_now,
        adl_score]`` (mirrors TS ``queryAdlQueue``).
        """
        raw = self._get_data(f"/v1/adl/queue/{market}")
        if not isinstance(raw, (list, tuple)):
            return []
        return [
            {
                "owner": self._to_bytes(r[0]),
                "market": int(r[1]),
                "side": r[2],
                "size": int(r[3]),
                "upnl_now": int(r[4]),
                "adl_score": int(r[5]),
            }
            for r in raw
            if isinstance(r, (list, tuple)) and len(r) >= 6
        ]

    # ── History (per-owner, time-windowed) ──────────────────────────────

    def history_deposits(
        self,
        owner: bytes | str,
        from_ms: int | None = None,
        to_ms: int | None = None,
        limit: int | None = None,
    ) -> list[dict[str, t.Any]]:
        """Raw deposit account-event records for *owner*, newest first.

        Returns a bounded merged head (default 200), not the complete history.
        Amounts remain in the original event payload.
        """
        return self._history_cashflow("deposits", owner, from_ms, to_ms, limit)

    def history_withdrawals(
        self,
        owner: bytes | str,
        from_ms: int | None = None,
        to_ms: int | None = None,
        limit: int | None = None,
    ) -> list[dict[str, t.Any]]:
        """Raw withdrawal account-event records for *owner*, newest first.

        This method returns up to ``limit`` records across event types (default 200).
        A ``withdrawal_confirmed`` event appears only when indexed under this
        owner. A confirmation without an owner cannot appear in this account
        history. Use ``withdrawal_status(withdrawal_id)`` to check its current status.
        Request/refund amounts omit custody fees, so do not infer cash deltas.
        """
        return self._history_cashflow("withdrawals", owner, from_ms, to_ms, limit)

    def history_resolutions(
        self,
        owner: bytes | str,
        event_id: int | None = None,
        from_ms: int | None = None,
        to_ms: int | None = None,
        limit: int | None = None,
    ) -> list[dict[str, t.Any]]:
        """Position-at-resolution log for *owner*: ``GET /v1/history/resolutions/{hex}``."""
        if isinstance(owner, bytes):
            owner = owner.hex()
        params: dict[str, t.Any] = {}
        if event_id is not None:
            params["event_id"] = event_id
        if from_ms is not None:
            params["from"] = from_ms
        if to_ms is not None:
            params["to"] = to_ms
        if limit is not None:
            params["limit"] = limit
        resp = self._get(f"/v1/history/resolutions/{owner}", params=params or None)
        data = _response_json(resp)
        return data if isinstance(data, list) else []

    # ── System ───────────────────────────────────────────────────────────

    def system_status(self) -> dict[str, t.Any]:
        resp = self._get("/system/status")
        return _response_object(resp)

    def maintenance_status(self) -> dict[str, t.Any]:
        resp = self._get("/maintenance/status")
        return _response_object(resp)

    # ── Account event stream ─────────────────────────────────────────────

    def account_auth(
        self, owner: bytes | str | None = None, after_id: int = 0,
    ) -> dict[str, t.Any]:
        """Fresh signed authentication for the signer's account-events feed.

        Uses the configured chain binding and the current timestamp. Only the
        signer's own account is supported; trading-agent grants do not authorize
        another owner's private feed. ``after_id`` is an integer from zero to
        ``2**53 - 1``, matching TypeScript's JSON-safe cursor domain. Zero is
        signed but omitted from the returned params. Default stream recovery
        uses history reads and leaves this legacy cursor at zero.
        """
        try:
            if type(after_id) is not int or not 0 <= after_id <= (1 << 53) - 1:
                raise SigningError("invalid account auth cursor")
            if self._chain_id == UNBOUND_CHAIN_ID:
                raise SigningError("chain_id not configured for account authentication")
            with self._signer_lock:
                signer, revision = self._external_signer, self._signer_revision
                key_handle, secret_key = self._key_handle, self._secret_key
                chain_id = self._chain_id
                signer_owner = self._own_owner()
            if owner is not None and canonical_owner(owner) != signer_owner.hex():
                raise SigningError("account auth owner does not match signer")
            timestamp_ms = time.time_ns() // 1_000_000
            if signer is not None:
                public_key = signer.public_key
                message = account_ws_auth_message(chain_id, public_key, timestamp_ms, after_id)
                signature = self._sign_external(signer, revision, message)
            elif key_handle is not None:
                public_key = key_handle.public_key
                signature = key_handle.sign_account_ws_auth(chain_id, timestamp_ms, after_id)
            else:
                public_key = generate_keypair(secret_key)["public_key"]
                signature = sign_account_ws_auth(chain_id, timestamp_ms, secret_key, after_id)
            self._check_signer_revision(revision)
        except SigningError:
            raise
        except Exception as err:
            raise SigningError("account-stream authentication signing failed") from err
        return {
            "public_key": public_key.hex(),
            "signature": signature.hex(),
            "timestamp_ms": timestamp_ms,
            **({"after_id": after_id} if after_id > 0 else {}),
        }

    def account_event_stream(
        self, owner: bytes | str, *, ws_url: str | None = None, **kwargs: t.Any
    ) -> AccountEventStream:
        """An :class:`~proof_trading_sdk.streams.AccountEventStream` for ``owner``.

        Sends this client's API key when present. A configured secret key,
        opaque handle or external signer also signs fresh auth on every attempt, matching
        TypeScript even when an API key is configured.
        Only the signer's own account can use this signed-auth path. Signing
        failures yield error frames and retry within the stream's bounded
        first-subscription retry budget, without an unsigned fallback.
        Uses the client's gateway URL for the history reads
        that reconnect recovery makes, so recovery works when ``/ws`` is
        served on its own port (pass that as ``ws_url``). Other keyword
        arguments go to the stream.
        """
        from proof_trading_sdk.streams import AccountEventStream

        def current_auth() -> dict[str, t.Any]:
            with self._signer_lock:
                has_signer = (
                    self._secret_key is not None or self._key_handle is not None
                    or self._external_signer is not None
                )
            return self.account_auth(owner) if has_signer else {}

        kwargs.setdefault("history_url", self._gateway_url)
        kwargs.setdefault("auth", current_auth)
        return AccountEventStream(
            ws_url or self._gateway_url.replace("http", "ws", 1),
            owner,
            self._api_key,
            **kwargs,
        )

    # ── Orderbook snapshot (WS convenience) ──────────────────────────────

    def orderbook_snapshot(self, market: int, timeout: float = 10.0) -> dict[str, t.Any]:
        """Fetch a one-shot orderbook snapshot via a temporary WS connection.

        Subscribes to the ``orderbook`` channel of the gateway's ``/ws`` feed,
        reads the first ``snapshot`` frame (``bids`` / ``asks`` levels),
        closes the connection, and returns that frame. Raises
        :class:`TransportError` when the gateway refuses the subscription
        (``status_code`` is the gateway's code), when the connection fails, or
        when no snapshot arrives within ``timeout`` seconds (default 10).
        """
        import websockets.sync.client as ws_client

        deadline = time.monotonic() + timeout
        url = self._gateway_url.replace("http", "ws", 1).rstrip("/") + "/ws"
        try:
            ws = ws_client.connect(url, open_timeout=timeout)
        except Exception as err:
            raise TransportError(f"orderbook snapshot: cannot connect to {url}: {err}") from err
        try:
            ws.send(
                json.dumps(
                    {
                        "method": "subscribe",
                        "id": 1,
                        "params": {"channel": "orderbook", "market": market},
                    }
                )
            )
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                event = json.loads(ws.recv(timeout=remaining))
                if event.get("type") == "snapshot":
                    return event
                if event.get("type") == "error":
                    raise TransportError(
                        f"orderbook subscription refused: {event.get('error')}",
                        status_code=event.get("code"),
                    )
        except TimeoutError as err:
            raise TransportError(
                f"orderbook snapshot for market {market} timed out after {timeout}s"
            ) from err
        finally:
            ws.close()

    # ── Internal helpers ─────────────────────────────────────────────────

    def _history_cashflow(
        self,
        kind: str,
        owner: bytes | str,
        from_ms: int | None = None,
        to_ms: int | None = None,
        limit: int | None = None,
    ) -> list[dict[str, t.Any]]:
        owner = canonical_owner(owner)
        limit = 200 if limit is None else limit
        if type(limit) is not int or not 1 <= limit <= 5000:
            raise ValueError("history limit must be between 1 and 5000")
        for value in (from_ms, to_ms):
            if value is not None and (type(value) is not int or value < 0):
                raise ValueError("history time bounds must be nonnegative milliseconds")
        if from_ms is not None and to_ms is not None and from_ms >= to_ms:
            raise ValueError("history from_ms must be less than to_ms")
        params: dict[str, t.Any] = {"owner": owner, "order": "desc", "limit": limit}
        if from_ms is not None:
            params["from"] = from_ms
        if to_ms is not None:
            params["to"] = to_ms
        kinds = (
            ("deposited", "deposit_confirmed") if kind == "deposits" else
            ("withdrawn", "withdraw_requested", "withdrawal_confirmed", "withdrawal_failed")
        )
        events = []
        for event_type in kinds:
            resp = self._get(
                "/v1/history/account-events", params={**params, "event_type": event_type}
            )
            data = _response_json(resp)
            if (not isinstance(data, dict)
                    or not isinstance(data.get("account_events"), list)
                    or not isinstance(data.get("next_cursor"), str)):
                raise CodecError("invalid cashflow account-event page")
            for row in data["account_events"]:
                if (not isinstance(row, dict) or row.get("owner") != owner
                        or row.get("event_type") != event_type
                        or not isinstance(row.get("payload"), dict)
                        or row["payload"].get("owner", owner) != owner):
                    raise CodecError("cashflow account-event scope mismatch")
                # Preserve the gateway's nanosecond ordering before applying
                # the merged limit. Millisecond truncation can select wrong rows.
                match = re.fullmatch(
                    r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z",
                    str(row.get("block_time", "")),
                )
                event_id = row.get("event_id")
                if (match is None or isinstance(event_id, bool)
                        or not isinstance(event_id, (int, str))
                        or not re.fullmatch(r"[0-9]+", str(event_id))):
                    raise CodecError("invalid cashflow event time or id")
                try:
                    seconds = datetime.fromisoformat(match[1])
                except ValueError as exc:
                    raise CodecError("invalid cashflow event time") from exc
                key = (seconds, int((match[2] or "").ljust(9, "0")), int(event_id))
                events.append((key, row))
        events.sort(key=lambda item: item[0], reverse=True)
        return [row for _, row in events[:limit]]

    def _cursor_page(
        self,
        method: str,
        path: str,
        params: dict[str, t.Any],
        *,
        data_key: str = "data",
    ) -> CursorPage:
        owner = params.pop("owner", None)
        if owner is not None:
            params["owner"] = _to_hex(owner)

        query = {k: v for k, v in params.items() if v is not None and k != "self"}
        resp = self._get(path, params=query)
        data: dict[str, t.Any] = _response_object(resp)
        return CursorPage(
            data=data.get(data_key, []),
            next_cursor=data.get("next_cursor"),
            raw=data,
        )

    def close(self) -> None:
        self._http.close()
