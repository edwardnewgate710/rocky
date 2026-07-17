import type { Pool } from 'pg';
import type { RateLimit, RateLimiter, RateLimitResult } from './rate-limiter';

interface BucketResult {
  count: number;
  retry_after_seconds: number;
}

/** Fixed-window limiter shared by every API replica through PostgreSQL. */
export class PgRateLimiter implements RateLimiter {
  private checks = 0;

  constructor(private readonly pool: Pool) {}

  async check(key: string, limit: RateLimit): Promise<RateLimitResult> {
    const result = await this.pool.query<BucketResult>(
      `INSERT INTO rate_limit_buckets (bucket_key, request_count, window_started_at, expires_at)
       VALUES ($1, 1, now(), now() + ($2 * interval '1 millisecond'))
       ON CONFLICT (bucket_key) DO UPDATE SET
         request_count = CASE
           WHEN rate_limit_buckets.expires_at <= now() THEN 1
           ELSE rate_limit_buckets.request_count + 1
         END,
         window_started_at = CASE
           WHEN rate_limit_buckets.expires_at <= now() THEN now()
           ELSE rate_limit_buckets.window_started_at
         END,
         expires_at = CASE
           WHEN rate_limit_buckets.expires_at <= now()
             THEN now() + ($2 * interval '1 millisecond')
           ELSE rate_limit_buckets.expires_at
         END
       RETURNING request_count AS count,
         GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::int AS retry_after_seconds`,
      [key, limit.windowMs],
    );
    const bucket = result.rows[0]!;

    this.checks += 1;
    if (this.checks % 1000 === 0) {
      void this.pool.query(
        `DELETE FROM rate_limit_buckets
         WHERE expires_at < now() - interval '1 hour'`,
      ).catch(() => undefined);
    }

    const allowed = Number(bucket.count) <= limit.maxRequests;
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : Number(bucket.retry_after_seconds),
    };
  }

  async reset(key: string): Promise<void> {
    await this.pool.query('DELETE FROM rate_limit_buckets WHERE bucket_key = $1', [key]);
  }
}
