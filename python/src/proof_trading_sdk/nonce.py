from __future__ import annotations

import threading
import time


class NonceAllocator:
    """Thread-safe timestamp nonce allocator for the Proof Exchange.

    Every signed transaction carries a ``seq`` field — a millisecond Unix
    timestamp chosen by the client. The engine validates each nonce against a
    per-account sliding window:

    ========================================  ============================
    Condition                                Result
    ========================================  ============================
    ``nonce < block_time - 2 days``           ``InvalidNonce`` (21)
    ``nonce > block_time + 1 day``            ``InvalidNonce`` (21)
    ``nonce`` already in recent set (100 cap)  ``InvalidNonce`` (21)
    recent set full and ``nonce <= oldest``   ``InvalidNonce`` (21)
    ========================================  ============================

    All four map to code 21. Nonces are burned on success — only invalid
    signatures skip the burn.

    Allocation algorithm::

        allocate() = max(now_ms, last_seen + 1)

    Pure in-memory, no persistence, no I/O. On restart the counter resets
    to ``0`` and the first call returns ``now_ms`` — always ahead of any
    pre-crash nonce. The only edge case (restart within the same millisecond)
    produces a duplicate nonce; the engine rejects it with code 21 (not
    burned), the caller retries, and the second call returns ``now_ms + 1``.

    Thread safety: uses a lock, suitable for concurrent callers.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last: int = 0

    @staticmethod
    def _now_ms() -> int:
        return int(time.time_ns() // 1_000_000)

    def allocate(self) -> int:
        """Return the next nonce value.

        Returns:
            A monotonically non-decreasing millisecond timestamp.
        """
        now = self._now_ms()
        with self._lock:
            candidate = max(now, self._last + 1)
            self._last = candidate
            return candidate

    def peek(self) -> int:
        """Return the last allocated nonce without allocating."""
        return self._last
