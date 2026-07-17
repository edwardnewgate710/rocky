/**
 * @packageDocumentation
 * A port for rate limiting. Abstracting this behind a port allows us to
 * use an in-memory implementation for single-instance deployments or testing,
 * and a Redis-backed implementation for multi-instance deployments.
 */

export interface RateLimit {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  /** 0 when allowed, otherwise the number of seconds the client should wait. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  check(key: string, limit: RateLimit): RateLimitResult | Promise<RateLimitResult>;
  /**
   * Reset the limit for a given key.
   * Useful for testing or administrative actions.
   */
  reset?(key: string): void | Promise<void>;
}
