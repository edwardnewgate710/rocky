import type { Clock } from './clock';
import type { RateLimit, RateLimiter, RateLimitResult } from './rate-limiter';

interface Bucket {
  count: number;
  windowStart: number;
  /** windowStart + the limit's windowMs — when this bucket becomes stale. */
  expiresAt: number;
}

/** Sweep expired buckets every this many `check()` calls. */
const SWEEP_INTERVAL_CALLS = 500;

/**
 * A fixed-window rate limiter that stores request counts in memory.
 * Uses an injected Clock to ensure deterministic behavior in tests.
 *
 * Buckets for keys that are never checked again (e.g. one-off IPs) would
 * otherwise accumulate forever. Every {@link SWEEP_INTERVAL_CALLS} calls,
 * `check()` opportunistically evicts buckets whose window has already
 * lapsed — no timer/lifecycle to manage, safe to call from short-lived
 * processes (tests, the e2e harness) that never explicitly dispose it.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private callsSinceSweep = 0;

  constructor(private readonly clock: Clock) {}

  check(key: string, limit: RateLimit): RateLimitResult {
    const now = this.clock.now();
    let bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.expiresAt) {
      bucket = { count: 0, windowStart: now, expiresAt: now + limit.windowMs };
      this.buckets.set(key, bucket);
    }

    this.callsSinceSweep += 1;
    if (this.callsSinceSweep >= SWEEP_INTERVAL_CALLS) {
      this.callsSinceSweep = 0;
      this.sweep(now);
    }

    if (bucket.count < limit.maxRequests) {
      bucket.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const resetMs = bucket.windowStart + limit.windowMs - now;
    const retryAfterSeconds = Math.ceil(resetMs / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Remove buckets whose window has already lapsed. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.expiresAt) this.buckets.delete(key);
    }
  }

  /** Number of tracked keys (diagnostics/tests). */
  get size(): number {
    return this.buckets.size;
  }
}
