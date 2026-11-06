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

    In-memory only: restart resets the high-water mark. The first allocation
    uses the wall clock, which may repeat a nonce or lag a previous burst.
    Independent allocator instances can also choose the same millisecond.
    Coordinate workers sharing an account; the instance lock does not provide
    process-wide uniqueness. Reconcile an unknown submission by its original
    hash before signing a replacement. A confirmed code-21 rejection permits
    a fresh allocation, but does not guarantee that its first retry is unique.

    Thread safety: uses a lock, suitable for concurrent callers.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last: int = 0

    @staticmethod
    def _now_ms() -> int:
        return int(time.time_ns() // 1_000_000)

    @staticmethod
    def step(last: int, now_ms: int) -> int:
        """Pure nonce transition: ``max(now_ms, last + 1)``.

        Clock-free and side-effect-free, so the cross-language nonce
        conformance vectors (``conformance/nonce.ndjson``) can pin it
        directly. :meth:`allocate` is this composed with the wall clock.
        """
        return max(now_ms, last + 1)

    def allocate(self) -> int:
        """Return the next nonce value.

        Returns:
            A monotonically non-decreasing millisecond timestamp.
        """
        now = self._now_ms()
        with self._lock:
            candidate = self.step(self._last, now)
            self._last = candidate
            return candidate

    def peek(self) -> int:
        """Return the last allocated nonce without allocating."""
        return self._last
