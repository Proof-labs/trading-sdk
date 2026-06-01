from __future__ import annotations

from typing import Optional

# Delay imports to avoid circular access during proof_trading_sdk init
_ERROR_CODES: list[dict[str, object]] = []
_ERROR_CODE_MAP: dict[int, str] = {}
_ERROR_CODES_LOADED = False


def _ensure_loaded() -> None:
    global _ERROR_CODES, _ERROR_CODE_MAP, _ERROR_CODES_LOADED
    if _ERROR_CODES_LOADED:
        return
    import proof_trading_sdk._native as _native

    _ERROR_CODES = _native.get_error_code_table()
    _ERROR_CODE_MAP = {entry["code"]: entry["name"] for entry in _ERROR_CODES}  # type: ignore[arg-type]
    _ERROR_CODES_LOADED = True


def get_error_name(code: int) -> Optional[str]:
    """Return the canonical error name for a code, or ``None`` if unknown.

    E.g. ``get_error_name(21)`` returns ``"InvalidNonce"``.
    """
    _ensure_loaded()
    return _ERROR_CODE_MAP.get(code)


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
    """HTTP or WebSocket transport failure."""


class EngineError(ProofTradingSdkError):
    """Engine rejection with a typed error code.

    Attributes:
        code: The engine error code (e.g. 21 for InvalidNonce).
        name: Canonical error name from the manifest.
        message: Human-readable description.
    """

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.name = get_error_name(code) or "Unknown"
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
        super().__init__(f"rate_limited bucket={bucket!r} retry_after={retry_after_secs}s")
