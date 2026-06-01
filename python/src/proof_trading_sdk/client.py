from __future__ import annotations

import json
import logging
import time
import typing as t
from dataclasses import dataclass, field
from urllib.parse import urljoin

import httpx

from proof_trading_sdk._native import sign_and_encode
from proof_trading_sdk.config import SdkConfig, load_config
from proof_trading_sdk.errors import (
    CodecError,
    EngineError,
    ProofTradingSdkError,
    RateLimited,
    TransportError,
)
from proof_trading_sdk.nonce import NonceAllocator

log = logging.getLogger("proof_trading_sdk")

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
            Rust core for signing — Python never inspects the key bytes.
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
        self._chain_id = chain_id if chain_id is not None else UNBOUND_CHAIN_ID
        self._secret_key = secret_key

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
    ) -> httpx.Response:
        url = urljoin(self._gateway_url, path)
        try:
            resp = self._http.request(method, url, content=content, params=params)
        except httpx.RequestError as e:
            raise TransportError(f"request failed: {e}") from e

        self._parse_rate_limits(resp)

        if resp.status_code == 429:
            retry_after = float(resp.headers.get("Retry-After", "5"))
            bucket = resp.headers.get("X-RateLimit-Bucket", "")
            raise RateLimited(retry_after_secs=retry_after, bucket=bucket)

        if resp.status_code == 401:
            raise ProofTradingSdkError("unauthorized — check your API key")

        if resp.status_code == 413:
            raise ProofTradingSdkError("payload too large")

        if resp.status_code >= 500:
            raise TransportError(f"gateway error: {resp.status_code} {resp.text[:200]}")

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
        if self._secret_key is None:
            raise SigningError("no secret key set")

        seq = self._nonce.allocate()
        try:
            return sign_and_encode(
                self._chain_id,
                action_type,
                action_payload,
                seq,
                self._secret_key,
            )
        except ValueError as e:
            raise CodecError(str(e)) from e

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

    def account(self, owner: bytes | str) -> AccountState:
        """Fetch account state: balances, positions, open orders, margin."""
        if isinstance(owner, bytes):
            owner = owner.hex()
        resp = self._get(f"/v1/account/{owner}")
        data: dict[str, t.Any] = resp.json()
        return AccountState(
            balances=data.get("balances", {}),
            positions=data.get("positions", []),
            open_orders=data.get("open_orders", []),
            margin=data.get("margin", {}),
            raw=data,
        )

    def open_orders(self, owner: bytes | str) -> list[dict[str, t.Any]]:
        if isinstance(owner, bytes):
            owner = owner.hex()
        resp = self._get(f"/v1/orders/{owner}")
        return resp.json()

    def withdrawal_status(self, withdrawal_id: int) -> dict[str, t.Any]:
        resp = self._get(f"/v1/withdrawal/{withdrawal_id}")
        return resp.json()

    def nonce_info(self, owner: bytes | str) -> dict[str, t.Any]:
        if isinstance(owner, bytes):
            owner = owner.hex()
        resp = self._get(f"/v1/nonce/{owner}")
        return resp.json()

    def markets(self) -> list[dict[str, t.Any]]:
        resp = self._get("/v1/markets")
        return resp.json()

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

    def _cursor_page(
        self,
        method: str,
        path: str,
        params: dict[str, t.Any],
    ) -> CursorPage:
        owner = params.pop("owner", None)
        if isinstance(owner, bytes):
            params["owner"] = owner.hex()

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
