from __future__ import annotations

from typing import Optional

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

    Upgraded engines use code 50 for ``SlippageExceeded`` and code 51 for
    ``OpenInterestLimitExceeded``. During a rolling upgrade, a legacy engine
    may still emit code 50 for open interest; the canonical non-empty DeliverTx
    log distinguishes it. Missing or unknown code-50 text returns
    ``AmbiguousCode50`` rather than guessing. Code 51 never relies on the log.
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


class SigningError(ProofTradingSdkError):
    """Ed25519 signing or key-loading failure."""


class TransportError(ProofTradingSdkError):
    """HTTP or WebSocket transport failure — connection, DNS, or timeout."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        self.status_code = status_code
        super().__init__(message)


class GatewayError(TransportError):
    """Gateway returned a 5xx response — retry with backoff."""

    def __init__(self, status_code: int, body: str) -> None:
        self.status_code = status_code
        self.body = body
        super().__init__(
            f"gateway error: {status_code} {body[:200]}", status_code=status_code
        )


class AuthenticationError(ProofTradingSdkError):
    """HTTP 401 — API key missing, invalid, or expired."""


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


class RateLimited(ProofTradingSdkError):
    """HTTP 429 — rate limit exceeded.

    Attributes:
        retry_after_secs: Seconds to wait before retrying.
        bucket: The rate-limit bucket that was exceeded.
    """

    def __init__(self, retry_after_secs: float, bucket: str = "") -> None:
        self.retry_after_secs = retry_after_secs
        self.bucket = bucket
        super().__init__(
            f"rate_limited bucket={bucket!r} retry_after={retry_after_secs}s"
        )
