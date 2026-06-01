from __future__ import annotations

import threading
import time


class NonceAllocator:
    """Thread-safe timestamp nonce allocator.

    Allocation algorithm::

        allocate() = max(now_ms, last_seen + 1)

    Pure in-memory, no persistence, no I/O. On restart the counter resets
    to ``0`` and the first call returns ``now_ms`` — always ahead of any
    pre-crash nonce.

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
