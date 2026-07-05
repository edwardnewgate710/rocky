/**
 * Retry policy — pure, deterministic, and independent of HTTP.
 *
 * Retries are only ever attempted for *safe/idempotent* methods (GET/PUT/DELETE)
 * on transiently-failing responses (network blips, timeouts, 429/502/503/504).
 * POST/PATCH are never auto-retried so we can't silently duplicate a write.
 *
 * Backoff is exponential with optional full jitter; `sleep` and `rng` are
 * injected so the whole thing is testable without real timers or randomness.
 */
import type { HttpMethod } from '../ports/http.js';

export interface RetryPolicy {
  /** Total attempts including the first. `1` disables retries. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: 'full' | 'none';
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  jitter: 'full',
};

/** HTTP methods safe to retry automatically (idempotent). */
export const RETRIABLE_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'DELETE']);

/**
 * Delay before the next attempt. `retryIndex` is 0-based (0 = first retry).
 * Exponential (`base * 2^index`) capped at `maxDelayMs`, with full jitter
 * spreading the delay across `[0, capped]` to avoid thundering herds.
 */
export function computeBackoff(
  retryIndex: number,
  policy: RetryPolicy,
  rng: () => number = Math.random,
): number {
  const exponential = policy.baseDelayMs * 2 ** retryIndex;
  const capped = Math.min(exponential, policy.maxDelayMs);
  if (policy.jitter === 'none') return capped;
  return Math.floor(rng() * capped);
}

export interface RetryContext {
  readonly policy: RetryPolicy;
  readonly sleep: (ms: number) => Promise<void>;
  readonly rng?: () => number;
  /** Decide whether `error` justifies another attempt (`nextAttempt` is 1-based). */
  isRetriable(error: unknown, nextAttempt: number): boolean;
  /** Optional per-error delay floor (e.g. from a `Retry-After` header). */
  delayHintMs?(error: unknown): number | undefined;
}

/**
 * Run `op` with retries governed by `ctx`. `op` receives the 1-based attempt
 * number. The last error is rethrown once attempts are exhausted or the error is
 * classified non-retriable.
 */
export async function withRetry<T>(op: (attempt: number) => Promise<T>, ctx: RetryContext): Promise<T> {
  const rng = ctx.rng ?? Math.random;
  let attempt = 1;
  for (;;) {
    try {
      return await op(attempt);
    } catch (error) {
      const nextAttempt = attempt + 1;
      if (nextAttempt > ctx.policy.maxAttempts || !ctx.isRetriable(error, nextAttempt)) {
        throw error;
      }
      const backoff = computeBackoff(attempt - 1, ctx.policy, rng);
      const hint = ctx.delayHintMs?.(error);
      await ctx.sleep(hint !== undefined ? Math.max(backoff, hint) : backoff);
      attempt = nextAttempt;
    }
  }
}
