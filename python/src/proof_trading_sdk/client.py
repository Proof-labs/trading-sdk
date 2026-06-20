from __future__ import annotations

import base64
import json
import logging
import time
import typing as t
from dataclasses import dataclass, field
from urllib.parse import urljoin

import httpx
import msgpack

from proof_trading_sdk._native import SigningHandle, chain_id_from_string, generate_keypair, pubkey_to_owner, sign_and_encode
from proof_trading_sdk.actions import Action, encode_action
from proof_trading_sdk.config import SdkConfig, load_config
from proof_trading_sdk.errors import (
    AuthenticationError,
    CodecError,
    EngineError,
    GatewayError,
    ProofTradingSdkError,
    RateLimited,
    SigningError,
    TransportError,
)
from proof_trading_sdk.nonce import NonceAllocator

log = logging.getLogger("proof_trading_sdk")

# ── Helpers ───────────────────────────────────────────────────────────────────


def _to_hex(owner: bytes | str) -> str:
    """Normalise *owner* to a hex string (with or without ``0x`` prefix).

    Accepts either raw 20-byte ``bytes`` or any hex string. Strips ``0x``
    prefix if present so the caller doesn't need to check.
    """
    if isinstance(owner, bytes):
        return owner.hex()
    return owner.removeprefix("0x")

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
            cfg = load_config(
                gateway_url=gateway_url,
                api_key=api_key,
                timeout_secs=timeout_secs,
            )

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
        bucket = resp.headers.get("X-RateLimit-Bucket", "default")
        state = RateLimitState(
            limit=int(resp.headers.get("X-RateLimit-Limit", 0)),
            remaining=int(resp.headers.get("X-RateLimit-Remaining", 0)),
            reset=int(resp.headers.get("X-RateLimit-Reset", 0)),
            tier=resp.headers.get("X-RateLimit-Tier", ""),
            bucket=bucket,
        )
        self._rate_limits[bucket] = state

    def rate_limit_remaining(self, bucket: str = "orders") -> int:
        """Return the remaining rate-limit tokens for *bucket*.

        This is a synchronous, local check — the authoritative value is
        in the response headers.
        """
        state = self._rate_limits.get(bucket)
        return state.remaining if state else 0

    def rate_limit_state(self, bucket: str = "orders") -> RateLimitState:
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
        return self._check_response(resp)

    def _check_response(self, resp: httpx.Response) -> httpx.Response:
        if resp.status_code == 429:
            retry_after = float(resp.headers.get("Retry-After", "5"))
            bucket = resp.headers.get("X-RateLimit-Bucket", "")
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
    ) -> httpx.Response:
        return self._request("POST", path, content=content)

    # ── Signing ──────────────────────────────────────────────────────────

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
        seq = self._nonce.allocate()
        try:
            if self._key_handle is not None:
                # Hardware-isolated path: the key never enters Python memory.
                return self._key_handle.sign_and_encode(
                    self._chain_id,
                    action_type,
                    action_payload,
                    seq,
                )
            if self._secret_key is not None:
                return sign_and_encode(
                    self._chain_id,
                    action_type,
                    action_payload,
                    seq,
                    self._secret_key,
                )
        except ValueError as e:
            raise CodecError(str(e)) from e

        raise SigningError("no signing key set (pass secret_key or key_handle)")

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

    # ── Write action ─────────────────────────────────────────────────────

    def submit_action(self, envelope: bytes) -> dict[str, t.Any]:
        """Submit a signed action envelope to the gateway.

        Args:
            envelope: Wire-ready signed envelope bytes (from
                :meth:`sign_and_encode_action`).

        Returns:
            The engine's response dict with keys like ``code``,
            ``tx_hash``, etc.
        """
        resp = self._post("/exchange", content=envelope)
        data: dict[str, t.Any] = resp.json()
        code = data.get("code", 0)
        if code != 0:
            raise EngineError(code, data.get("message", ""))
        return data

    # ── Info queries ─────────────────────────────────────────────────────

    def _own_owner(self) -> bytes:
        """Derive the 20-byte owner from whichever signing key is configured."""
        if self._key_handle is not None:
            return self._key_handle.owner
        if self._secret_key is not None:
            return pubkey_to_owner(generate_keypair(self._secret_key)["public_key"])
        msg = "No signing key configured — pass an explicit `owner` or set `secret_key`/`key_handle`."
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
        return msgpack.unpackb(
            base64.b64decode(data_b64), raw=False, strict_map_key=False
        )

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
        return self._decode_envelope(resp.json(), source="/info", require_data=True)

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
        Indices 6-12 are optional enrichments older gateways may omit."""

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

        Each order decodes from a msgpack 6-tuple
        ``[id, market, owner, side, price, quantity]`` (mirrors TS
        ``queryOpenOrders``).
        """
        raw = self._post_info({"type": "openOrders", "user": _to_hex(owner)})
        if not isinstance(raw, (list, tuple)):
            return []
        return [
            {
                "id": int(o[0]),
                "market": int(o[1]),
                "owner": self._to_bytes(o[2]),
                "side": o[3],
                "price": int(o[4]),
                "quantity": int(o[5]),
            }
            for o in raw
            if isinstance(o, (list, tuple)) and len(o) >= 6
        ]

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
        return resp.json()

    def _get_data(self, path: str, params: dict[str, t.Any] | None = None) -> t.Any:
        """GET a ``/v1/*`` read endpoint and decode the ``{data: base64 msgpack}``
        envelope the gateway returns (markets, orderbook, adl-queue, …). Raises
        on a JSON ``{"error": …}`` body; a missing envelope yields ``None`` (the
        callers default to an empty list)."""
        resp = self._get(path, params=params)
        return self._decode_envelope(resp.json(), source=path, require_data=False)

    @staticmethod
    def _decode_market_config(raw: t.Sequence[t.Any]) -> dict[str, t.Any]:
        """Decode a market-config tuple (mirrors the TS ``decodeMarketConfig``)."""

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
            "partial_liquidation_enabled": flag(21),
            "sz_decimals": opt(22),
            "ticker": None if len(raw) <= 23 or raw[23] is None else str(raw[23]),
        }

    def markets(self) -> list[dict[str, t.Any]]:
        """All registered market configs, decoded from the msgpack envelope."""
        raw = self._get_data("/v1/markets")
        if not isinstance(raw, (list, tuple)):
            return []
        return [
            self._decode_market_config(m) for m in raw if isinstance(m, (list, tuple))
        ]

    def market_status(self, market: int) -> dict[str, t.Any]:
        resp = self._get(f"/v1/market-status/{market}")
        return resp.json()

    def trades(self, market: int) -> list[dict[str, t.Any]]:
        resp = self._get(f"/v1/trades/{market}")
        return resp.json()

    # ── History (cursor-paginated) ───────────────────────────────────────

    def history_fills(
        self,
        owner: bytes | str,
        after_id: int | None = None,
        limit: int = 100,
    ) -> CursorPage:
        return self._cursor_page("GET", f"/v1/history/fills", locals())

    def history_funding(
        self,
        owner: bytes | str,
        after_height: int | None = None,
        limit: int = 100,
    ) -> CursorPage:
        return self._cursor_page("GET", f"/v1/history/funding", locals())

    def history_positions(
        self,
        owner: bytes | str,
        after_height: int | None = None,
        limit: int = 100,
    ) -> CursorPage:
        return self._cursor_page("GET", f"/v1/history/positions", locals())

    def history_account_events(
        self,
        owner: bytes | str,
        after_id: int | None = None,
        limit: int = 100,
    ) -> CursorPage:
        return self._cursor_page("GET", f"/v1/history/account-events", locals())

    def history_status(self) -> dict[str, t.Any]:
        resp = self._get("/v1/history/status")
        return resp.json()

    # ── Health & status ──────────────────────────────────────────────────

    def health(self) -> dict[str, t.Any]:
        """Gateway health check: ``GET /v1/health``."""
        resp = self._get("/v1/health")
        return resp.json()

    def status(self) -> dict[str, t.Any]:
        """CometBFT node status via the gateway: ``GET /v1/status``.

        The gateway proxies CometBFT ``/status`` and returns it verbatim
        (``result.sync_info``, ``result.node_info``, etc.).
        """
        resp = self._get("/v1/status")
        return resp.json()

    def get_block(self, height: int | None = None) -> dict[str, t.Any]:
        """CometBFT block at *height* (latest if omitted) via ``GET /v1/block``."""
        params = {"height": height} if height is not None else None
        resp = self._get("/v1/block", params=params)
        return resp.json()

    def get_block_results(self, height: int) -> dict[str, t.Any]:
        """CometBFT block results at *height* via ``GET /v1/block_results``."""
        resp = self._get("/v1/block_results", params={"height": height})
        return resp.json()

    # ── Market data ──────────────────────────────────────────────────────

    def ticker(self, market: int) -> dict[str, t.Any] | None:
        """One-round-trip market summary: ``GET /v1/ticker/{market}``.

        Returns ``None`` if the market is unknown or the endpoint 404s.
        """
        try:
            resp = self._get(f"/v1/ticker/{market}")
            return resp.json()
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
        """Deposit log for *owner*: ``GET /v1/history/deposits/{hex}``."""
        return self._history_cashflow("deposits", owner, from_ms, to_ms, limit)

    def history_withdrawals(
        self,
        owner: bytes | str,
        from_ms: int | None = None,
        to_ms: int | None = None,
        limit: int | None = None,
    ) -> list[dict[str, t.Any]]:
        """Withdrawal log for *owner*: ``GET /v1/history/withdrawals/{hex}``."""
        return self._history_cashflow("withdrawals", owner, from_ms, to_ms, limit)

    def history_resolutions(
        self,
        owner: bytes | str,
        impact_market_id: int | None = None,
        from_ms: int | None = None,
        to_ms: int | None = None,
        limit: int | None = None,
    ) -> list[dict[str, t.Any]]:
        """Position-at-resolution log for *owner*: ``GET /v1/history/resolutions/{hex}``."""
        if isinstance(owner, bytes):
            owner = owner.hex()
        params: dict[str, t.Any] = {}
        if impact_market_id is not None:
            params["impact_market_id"] = impact_market_id
        if from_ms is not None:
            params["from"] = from_ms
        if to_ms is not None:
            params["to"] = to_ms
        if limit is not None:
            params["limit"] = limit
        resp = self._get(f"/v1/history/resolutions/{owner}", params=params or None)
        data = resp.json()
        return data if isinstance(data, list) else []

    # ── System ───────────────────────────────────────────────────────────

    def system_status(self) -> dict[str, t.Any]:
        resp = self._get("/system/status")
        return resp.json()

    def maintenance_status(self) -> dict[str, t.Any]:
        resp = self._get("/maintenance/status")
        return resp.json()

    # ── Orderbook snapshot (WS convenience) ──────────────────────────────

    def orderbook_snapshot(self, market: int) -> dict[str, t.Any]:
        """Fetch a one-shot L2 orderbook snapshot via a temporary WS connection.

        Opens a WebSocket to the orderbook delta stream, reads the first
        (snapshot) frame, closes the connection, and returns the L2 book.
        """
        from proof_trading_sdk.streams import OrderbookDeltaStream

        stream = OrderbookDeltaStream(
            ws_url=self._gateway_url.replace("http", "ws"),
            market=market,
        )
        try:
            for event in stream:
                if event.get("type") == "l2Book":
                    return event
        finally:
            stream.close()

    # ── Internal helpers ─────────────────────────────────────────────────

    def _history_cashflow(
        self,
        kind: str,
        owner: bytes | str,
        from_ms: int | None = None,
        to_ms: int | None = None,
        limit: int | None = None,
    ) -> list[dict[str, t.Any]]:
        owner = _to_hex(owner)
        params: dict[str, t.Any] = {}
        if from_ms is not None:
            params["from"] = from_ms
        if to_ms is not None:
            params["to"] = to_ms
        if limit is not None:
            params["limit"] = limit
        resp = self._get(f"/v1/history/{kind}/{owner}", params=params or None)
        data = resp.json()
        return data if isinstance(data, list) else []

    def _cursor_page(
        self,
        method: str,
        path: str,
        params: dict[str, t.Any],
    ) -> CursorPage:
        owner = params.pop("owner", None)
        if owner is not None:
            params["owner"] = _to_hex(owner)

        query = {k: v for k, v in params.items() if v is not None and k != "self"}
        resp = self._get(path, params=query)
        data: dict[str, t.Any] = resp.json()
        return CursorPage(
            data=data.get("data", []),
            next_cursor=data.get("next_cursor"),
            raw=data,
        )

    def close(self) -> None:
        self._http.close()
