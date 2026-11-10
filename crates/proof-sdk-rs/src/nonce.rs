//! Timestamp nonce allocation.
//!
//! The engine accepts any `seq` inside a sliding window around its block time
//! and refuses one it has already seen (code 21, `InvalidNonce`). It does not
//! require a strict sequence. A wall-clock-millisecond nonce, bumped past the
//! last one this process handed out, is therefore unique without any round
//! trip. This is the same rule the TypeScript and Python SDKs use.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};

/// How far ahead of the wall clock an allocation may run before it is
/// refused: past this, the engine's window would reject the nonce anyway.
pub const MAX_CLOCK_LEAD_MS: u64 = 60_000;

/// Lock-free, monotonic timestamp nonce allocator.
///
/// Each call returns `max(now_ms, last + 1, floor + 1)`. Concurrent callers
/// (one client shared across tasks) always get distinct values. Nonces are
/// burned: a rejected transaction never hands its nonce back.
///
/// Two *processes* signing with one key each need their own allocator, and
/// they can collide inside one millisecond. Give each process its own key (or
/// trading agent) rather than sharing one.
#[derive(Debug, Default)]
pub struct NonceAllocator {
    last: AtomicU64,
}

impl NonceAllocator {
    /// A fresh allocator. Its first nonce is the current wall-clock ms.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The next nonce.
    pub fn next(&self) -> Result<u64> {
        self.next_after(0)
    }

    /// The next nonce, strictly above `floor`. Use the floor to stay ahead of
    /// nonces a previous process signed with the same key (for example the
    /// highest value from [`crate::InfoClient::recent_nonces`]).
    pub fn next_after(&self, floor: u64) -> Result<u64> {
        let now = now_ms();
        let mut prev = self.last.load(Ordering::Relaxed);
        loop {
            let next = now.max(prev.saturating_add(1)).max(floor.saturating_add(1));
            if next > now.saturating_add(MAX_CLOCK_LEAD_MS) {
                return Err(Error::NonceWindow { next, now_ms: now });
            }
            match self
                .last
                .compare_exchange_weak(prev, next, Ordering::AcqRel, Ordering::Relaxed)
            {
                Ok(_) => return Ok(next),
                Err(actual) => prev = actual,
            }
        }
    }

    /// The highest nonce handed out so far (0 before the first).
    #[must_use]
    pub fn current(&self) -> u64 {
        self.last.load(Ordering::Acquire)
    }
}

/// Milliseconds since the Unix epoch (0 if the clock is before it).
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    #[test]
    fn strictly_increasing_and_near_the_clock() {
        let n = NonceAllocator::new();
        let before = now_ms();
        let a = n.next().unwrap();
        let b = n.next().unwrap();
        assert!(a >= before);
        assert!(b > a);
        assert_eq!(n.current(), b);
    }

    #[test]
    fn floor_is_exclusive() {
        let n = NonceAllocator::new();
        let floor = now_ms() + 10_000;
        assert_eq!(n.next_after(floor).unwrap(), floor + 1);
        assert_eq!(n.next().unwrap(), floor + 2);
    }

    #[test]
    fn refuses_to_run_past_the_clock_window_without_moving() {
        let n = NonceAllocator::new();
        let last = n.next().unwrap();
        let err = n
            .next_after(now_ms() + MAX_CLOCK_LEAD_MS + 5_000)
            .unwrap_err();
        assert!(matches!(err, Error::NonceWindow { .. }));
        assert_eq!(
            n.current(),
            last,
            "a refused allocation must not burn state"
        );
    }

    #[test]
    fn concurrent_callers_never_share_a_nonce() {
        let n = Arc::new(NonceAllocator::new());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let n = Arc::clone(&n);
                std::thread::spawn(move || (0..500).map(|_| n.next().unwrap()).collect::<Vec<_>>())
            })
            .collect();
        let mut seen = HashSet::new();
        for t in threads {
            for v in t.join().unwrap() {
                assert!(seen.insert(v), "duplicate nonce {v}");
            }
        }
        assert_eq!(seen.len(), 4_000);
    }
}
