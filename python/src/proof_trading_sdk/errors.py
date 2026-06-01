from __future__ import annotations


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
        message: Human-readable description.
    """

    def __init__(self, code: int, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")

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
