from __future__ import annotations

from typing import Literal, Optional

# Delay imports to avoid circular access during proof_trading_sdk init
_ERROR_CODES: list[dict[str, object]] = []
_ERROR_CODES_LOADED = False


def _ensure_loaded() -> None:
    global _ERROR_CODES, _ERROR_CODES_LOADED
    if _ERROR_CODES_LOADED:
        return
    import proof_trading_sdk._native as _native

    _ERROR_CODES = _native.get_error_code_table()
    _ERROR_CODES_LOADED = True


def get_error_name(code: int, message: str | None = None) -> Optional[str]:
    """Return the safe error classification for a code and DeliverTx log.

    E.g. ``get_error_name(21)`` returns ``"InvalidNonce"``.

    Code 50 is ``SlippageExceeded`` and code 51 ``OpenInterestLimitExceeded``.
    Receipts from before the renumbering carry 50 for open interest; pass the
    DeliverTx log and its text classifies them. Code 51 never reads the log.
    """
    _ensure_loaded()
    return _native_error_name(code, message)


def _native_error_name(code: int, message: str | None) -> Optional[str]:
    import proof_trading_sdk._native as _native

    return _native.classify_error_name(code, message)  # type: ignore[no-any-return]


def get_error_code_table() -> list[dict[str, object]]:
    """Return the complete error-code manifest from the Rust core.

    Each entry is ``{code: int, name: str, meaning: str}``.
    """
    _ensure_loaded()
    return list(_ERROR_CODES)


# ── Exception hierarchy ──────────────────────────────────────────────────────


class ProofTradingSdkError(Exception):
    """Base exception for all Proof SDK errors."""


class CodecError(ProofTradingSdkError):
    """MessagePack codec encoding or decoding failure."""


GatewayReadErrorKind = Literal["configuration", "malformed", "binding", "limit", "deadline"]


class GatewayReadError(ProofTradingSdkError):
    """Bounded read failure, with TypeScript-compatible ``kind`` and ``field``.

    Kinds: ``configuration``, ``malformed``, ``binding``, ``limit``, ``deadline``.
    HTTP refusals retain the existing SDK transport/auth/rate-limit exceptions.
    """

    def __init__(self, kind: GatewayReadErrorKind, field: str, message: str | None = None) -> None:
        self.kind = kind
        self.field = field
        super().__init__(message or f"invalid gateway read: {field}")


class SigningError(ProofTradingSdkError):
    """Ed25519 signing or key-loading failure."""


class TransportError(ProofTradingSdkError):
    """HTTP or WebSocket transport failure — connection, DNS, or timeout."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        self.status_code = status_code
        super().__init__(message)


class GatewayError(TransportError):
    """Gateway returned a 5xx response. Read-only calls can retry with backoff."""

    def __init__(self, status_code: int, body: str) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(
            f"gateway error: {status_code} {body[:200]}", status_code=status_code
        )


class SubmissionPending(ProofTradingSdkError):
    """The transaction's admission or execution outcome is unknown.

    This is **not** a rejection. The gateway may report a broadcast without a
    final result, or a transport failure after sending may hide whether the
    request was admitted at all. The transaction may still commit, so the caller must
    reconcile by ``tx_hash`` — re-submitting an order that is still in flight
    risks a double fill.

    Attributes:
        tx_hash: Transaction hash to reconcile the submission against.
        message: The gateway or client's explanation of the unknown outcome.
    """

    def __init__(self, tx_hash: str, message: str = "") -> None:
        self.tx_hash = tx_hash
        self.message = message
        detail = message or "gateway returned no on-chain result"
        super().__init__(
            f"submission pending: {detail} — reconcile by tx_hash={tx_hash}; "
            "do NOT re-submit"
        )


class AuthenticationError(ProofTradingSdkError):
    """HTTP or WebSocket authentication was refused (API key or signed auth)."""


class EngineError(ProofTradingSdkError):
    """Engine rejection with a typed error code.

    Attributes:
        code: The engine error code (e.g. 21 for InvalidNonce).
        name: Canonical error name from the manifest.
        message: Human-readable description.
    """

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.name = get_error_name(code, message) or "Unknown"
        self.message = message
        super().__init__(f"[{code}] {self.name}: {message}")

    def is_terminal(self) -> bool:
        return False

    def reopens_at(self) -> int | None:
        return None


class PreAdmissionRefusal(ProofTradingSdkError):
    """The gateway refused the request before admitting it (``status: refused``).

    Nothing was broadcast: there is no transaction hash to reconcile, no
    engine verdict, and no on-chain outcome to wait for. The gateway's
    ``error_code`` names why — ``InvalidRequest`` means the request must be
    corrected and ``EncodingError`` is a gateway-internal encoding failure.

    Refusals at HTTP 401, 403, 429 and 5xx other than ``EncodingError`` keep
    their own exceptions: :class:`AuthenticationError`, :class:`RateLimited` and
    :class:`GatewayError`. ``Unauthorized``, ``RateLimited``, ``Maintenance``,
    ``Overloaded`` and ``Unavailable`` therefore reach this class only on a
    legacy HTTP 200.

    Attributes:
        error_code: The gateway's machine-readable ``errorCode``, never empty.
        message: The gateway's own explanation, if it gave one.
        status_code: The HTTP status the refusal arrived with, such as legacy
            200, admission 400 or 413, and internal encoding failure 500.
    """

    def __init__(self, error_code: str, message: str, status_code: int) -> None:
        self.error_code = error_code
        self.message = message
        self.status_code = status_code
        detail = message or error_code
        super().__init__(f"gateway refused the request: {detail}")


class RateLimited(ProofTradingSdkError):
    """HTTP 429 — rate limit exceeded.

    Attributes:
        retry_after_secs: Seconds to wait before retrying.
        bucket: The rate-limit bucket that was exceeded. ExchangeClient uses
            ``"default"`` when the response omits ``X-RateLimit-Bucket``;
            pass this value to ``client.rate_limit_state`` for the bucket's latest
            cached state. Later responses in that bucket replace earlier state.
    """

    def __init__(self, retry_after_secs: float, bucket: str = "") -> None:
        self.retry_after_secs = retry_after_secs
        self.bucket = bucket
        super().__init__(
            f"rate_limited bucket={bucket!r} retry_after={retry_after_secs}s"
        )
