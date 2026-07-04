//! Dispatch rate + concurrency limits.
//!
//! UNLIKE the `launch` RPC's limits (opt-in via a policy file, unlimited by
//! default), dispatch is **non-permissive out of the box** — a single always-on
//! internet-facing dispatcher can trigger this path on demand, so "no limit" is
//! a resource-exhaustion risk regardless of how narrow the request is. Mirrors
//! `launcherd.ts`'s `DEFAULT_DISPATCH_RATE_LIMIT` / `DEFAULT_MAX_CONCURRENT_DISPATCHED`.

use std::collections::VecDeque;

/// Max dispatched boxes alive at once.
pub const MAX_CONCURRENT: usize = 5;
/// Rate window: at most `RATE_MAX` dispatches per `RATE_WINDOW_SECS`.
pub const RATE_MAX: usize = 20;
pub const RATE_WINDOW_SECS: u64 = 3600;

/// Dispatch limiter state. `now_secs` is injected (not read from the clock
/// inside) so the logic is unit-testable without sleeping — the serving loop
/// passes the real monotonic time.
#[derive(Debug, Default)]
pub struct Limits {
    /// Unix-ish timestamps (seconds) of recent dispatches, oldest first.
    times: VecDeque<u64>,
    /// Boxes currently alive (incremented on a successful spawn, decremented
    /// when the child process exits).
    active: usize,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    RateLimited { retry_after_secs: u64 },
    ConcurrentLimited,
}

impl Limits {
    pub fn new() -> Self {
        Self::default()
    }

    /// May a new dispatch proceed at `now_secs`? Prunes stale entries from the
    /// rate window as a side effect. Does NOT record the dispatch — call
    /// [`Limits::record`] only after the spawn actually succeeds (matching the
    /// TS, which records post-spawn so a failed spawn doesn't consume budget).
    pub fn check(&mut self, now_secs: u64) -> Decision {
        let cutoff = now_secs.saturating_sub(RATE_WINDOW_SECS);
        while self.times.front().is_some_and(|&t| t < cutoff) {
            self.times.pop_front();
        }
        if self.active >= MAX_CONCURRENT {
            return Decision::ConcurrentLimited;
        }
        if self.times.len() >= RATE_MAX {
            let oldest = *self.times.front().expect("len >= RATE_MAX > 0");
            let retry_after_secs = (oldest + RATE_WINDOW_SECS).saturating_sub(now_secs);
            return Decision::RateLimited { retry_after_secs };
        }
        Decision::Allow
    }

    /// Record a successful dispatch and mark one box active.
    pub fn record(&mut self, now_secs: u64) {
        self.times.push_back(now_secs);
        self.active += 1;
    }

    /// A dispatched box exited.
    pub fn release(&mut self) {
        self.active = self.active.saturating_sub(1);
    }

    pub fn active(&self) -> usize {
        self.active
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_under_both_ceilings() {
        let mut l = Limits::new();
        assert_eq!(l.check(1000), Decision::Allow);
    }

    #[test]
    fn concurrency_ceiling_blocks_at_max() {
        let mut l = Limits::new();
        for i in 0..MAX_CONCURRENT {
            assert_eq!(l.check(1000), Decision::Allow);
            l.record(1000 + i as u64);
        }
        assert_eq!(l.check(1000), Decision::ConcurrentLimited);
        l.release();
        assert_eq!(l.check(1000), Decision::Allow);
    }

    #[test]
    fn rate_ceiling_blocks_then_frees_after_window() {
        let mut l = Limits::new();
        // Record RATE_MAX dispatches at t=0, releasing each so concurrency
        // isn't what blocks us — we're isolating the rate limiter.
        for _ in 0..RATE_MAX {
            l.record(0);
            l.release();
        }
        match l.check(10) {
            Decision::RateLimited { retry_after_secs } => {
                assert_eq!(retry_after_secs, RATE_WINDOW_SECS - 10);
            }
            other => panic!("expected RateLimited, got {other:?}"),
        }
        // Past the window, the old entries prune and it allows again.
        assert_eq!(l.check(RATE_WINDOW_SECS + 1), Decision::Allow);
    }
}
