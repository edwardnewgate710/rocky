/**
 * Rate limiter.  Token-bucket per user and global, configurable via
 * {@link RateLimitConfig}.  The orchestrator checks the limiter before
 * dispatching a request.
 */

import type { RateLimitConfig } from './config.js';
import { DEFAULTS } from './config.js';
import { AiError } from './errors.js';

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Sliding-window rate limiter.  Tracks request counts per user and
 * globally over a 1-minute window.
 */
export class RateLimiter {
  private readonly perUserBuckets = new Map<string, Bucket>();
  private globalBucket: Bucket;
  private readonly perUserPerMinute: number;
  private readonly globalPerMinute: number;
  private readonly enabled: boolean;

  constructor(config?: RateLimitConfig) {
    this.enabled = config?.enabled ?? DEFAULTS.rateLimit.enabled;
    this.perUserPerMinute = config?.perUserPerMinute ?? DEFAULTS.rateLimit.perUserPerMinute;
    this.globalPerMinute = config?.globalPerMinute ?? DEFAULTS.rateLimit.globalPerMinute;
    this.globalBucket = { tokens: this.globalPerMinute, lastRefill: Date.now() };
  }

  /** Check if a request is allowed.  Throws if not. */
  check(userId?: string): void {
    if (!this.enabled) return;
    const now = Date.now();
    this.refill(this.globalBucket, this.globalPerMinute, now);
    if (this.globalBucket.tokens < 1) {
      throw new AiError(
        'rate_limited',
        'Global rate limit exceeded. Please retry shortly.',
      );
    }
    if (userId) {
      let bucket = this.perUserBuckets.get(userId);
      if (!bucket) {
        bucket = { tokens: this.perUserPerMinute, lastRefill: now };
        this.perUserBuckets.set(userId, bucket);
      }
      this.refill(bucket, this.perUserPerMinute, now);
      if (bucket.tokens < 1) {
        throw new AiError(
          'rate_limited',
          `Rate limit exceeded for user "${userId}". Please retry shortly.`,
        );
      }
      bucket.tokens -= 1;
    }
    this.globalBucket.tokens -= 1;
  }

  /** Reset all buckets. */
  reset(): void {
    this.perUserBuckets.clear();
    this.globalBucket = { tokens: this.globalPerMinute, lastRefill: Date.now() };
  }

  private refill(bucket: Bucket, capacity: number, now: number): void {
    const elapsed = now - bucket.lastRefill;
    const refillRate = capacity / 60_000; // tokens per ms
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillRate);
    bucket.lastRefill = now;
  }
}
