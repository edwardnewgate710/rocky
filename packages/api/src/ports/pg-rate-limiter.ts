import type { Pool, PoolClient } from 'pg';
import { assertDistinctKeys } from './in-memory-rate-limiter';
import type { RateLimit, RateLimiter, RateLimitRequest, RateLimitResult } from './rate-limiter';

/**
 * Admit one bucket, writing **only** if the request fits.
 *
 * The `WHERE` on the conflict action is what makes a refusal free. `ON CONFLICT DO UPDATE` locks
 * the conflicting row and then evaluates that clause; when it is false no update happens and the
 * statement returns no rows, so a refused request leaves the counter exactly as it found it. The
 * lock is still taken, which is what serialises two concurrent requests racing for one slot.
 *
 * An earlier version incremented unconditionally and decided afterwards, which left a refusal
 * persisting `maxRequests + 1` — a stored charge for a request that never ran, contradicting the
 * port's own "rejection is free" clause and disagreeing with `InMemoryRateLimiter`, which writes
 * nothing. Raised in the Qodo review of PR #137.
 *
 * This statement reports **only** whether the request was admitted. The version before it also
 * carried a trailing `SELECT` for the retry wait, and that was wrong in a way only a real server
 * shows: `ON CONFLICT DO UPDATE` can inspect a row committed by a concurrent transaction after
 * this statement began — Postgres steps outside the statement snapshot for exactly that purpose —
 * while an ordinary `SELECT` in the same statement cannot. So a request that lost a race to create
 * the bucket was refused by a row its own `SELECT` could not see, and reported the `COALESCE`
 * fallback of one second for a bucket that was full for the rest of its window. Reproduced against
 * PostgreSQL 16 before the fix. Raised independently by both the Qodo and CodeRabbit reviews of
 * PR #137.
 */
const ADMIT_ONE = `
  INSERT INTO rate_limit_buckets AS b (bucket_key, request_count, window_started_at, expires_at)
  VALUES ($1, 1, now(), now() + ($2 * interval '1 millisecond'))
  ON CONFLICT (bucket_key) DO UPDATE SET
    request_count = CASE
      WHEN b.expires_at <= now() THEN 1
      ELSE b.request_count + 1
    END,
    window_started_at = CASE
      WHEN b.expires_at <= now() THEN now()
      ELSE b.window_started_at
    END,
    expires_at = CASE
      WHEN b.expires_at <= now() THEN now() + ($2 * interval '1 millisecond')
      ELSE b.expires_at
    END
  WHERE b.expires_at <= now() OR b.request_count < $3::int
  RETURNING 1`;

/**
 * How long the caller must wait for a bucket that just refused them.
 *
 * A separate statement, and that is the whole point: under READ COMMITTED every statement takes a
 * fresh snapshot, so this one sees the row that refused the admission even when it was committed
 * by a concurrent transaction after the upsert began. Issued before any `ROLLBACK`, so the value
 * describes the bucket as it stands rather than as this transaction briefly left it.
 */
const RETRY_AFTER = `
  SELECT GREATEST(1, CEIL(EXTRACT(EPOCH FROM (expires_at - now()))))::int AS retry_after_seconds
    FROM rate_limit_buckets
   WHERE bucket_key = $1`;

const ADMITTED: RateLimitResult = { allowed: true, retryAfterSeconds: 0 };

/**
 * How long a multi-bucket admission may wait on a row lock, and run in total.
 *
 * The critical section is one upsert per bucket and should finish in microseconds. These bound the
 * pathological case rather than letting it run: a transaction stuck behind a saturated hot key
 * holds a pooled client, and that pool is shared with every repository in the process, so an
 * unbounded wait turns contention on one rate-limit row into connection starvation everywhere.
 * Failing fast surfaces as a 500 on the affected request — fail-closed, and recoverable — instead
 * of as a stalled process. Raised in the Qodo review of PR #137.
 */
const LOCK_TIMEOUT_MS = 2_000;
const STATEMENT_TIMEOUT_MS = 5_000;

/** Fixed-window limiter shared by every API replica through PostgreSQL. */
export class PgRateLimiter implements RateLimiter {
  private admissions = 0;

  constructor(private readonly pool: Pool) {}

  async admit(requests: readonly RateLimitRequest[]): Promise<RateLimitResult> {
    if (requests.length === 0) return ADMITTED;
    assertDistinctKeys(requests);

    this.admissions += 1;
    if (this.admissions % 1000 === 0) this.sweep();

    // One bucket needs no transaction: the upsert is atomic on its own, it writes nothing when it
    // refuses, and there is no second bucket that could refuse after this one has been charged. It
    // also takes no pooled client, which matters — five of the eleven limited routes are
    // single-bucket, and `/v1/auth/refresh` is the hottest of them.
    if (requests.length === 1) {
      const request = requests[0]!;
      if (await this.admitOne(this.pool, request)) return ADMITTED;
      return { allowed: false, retryAfterSeconds: await this.retryAfter(this.pool, request) };
    }

    // Two or more buckets: all-or-nothing, so they move inside one transaction and a refusal rolls
    // back whatever the earlier buckets committed.
    //
    // The keys are **sorted** first. `ON CONFLICT DO UPDATE` locks the conflicting row, so two
    // concurrent transactions touching the same pair of keys in opposite orders would each hold
    // what the other needs and Postgres would break the tie by killing one with a deadlock error.
    // A total order over the keys removes the cycle: every transaction takes the same locks in the
    // same sequence, so the second simply waits.
    //
    // Those same row locks are what make the count correct rather than merely all-or-nothing. A
    // concurrent transaction blocks on the locked row until this one ends and then re-reads it, so
    // two requests racing for one remaining slot cannot both see it free.
    const ordered = [...requests].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const client = await this.pool.connect();
    // Set while the connection may still be inside a transaction. Releasing such a client returns
    // it to the pool mid-transaction and the next borrower inherits it — its writes join a
    // transaction it cannot see, and a later ROLLBACK silently discards them. Destroying the
    // connection instead costs one reconnect on a path that is already failing.
    let poisoned = false;
    try {
      await client.query('BEGIN');
      poisoned = true;
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);

      let worstRetry = 0;
      for (const request of ordered) {
        if (await this.admitOne(client, request)) continue;
        // Read the wait before the rollback, and in its own statement so it sees the row that
        // actually refused this request rather than the snapshot the upsert started with.
        worstRetry = Math.max(worstRetry, await this.retryAfter(client, request));
      }

      // Every bucket is measured before anything is decided, so `retryAfterSeconds` is the longest
      // of the refusals rather than whichever key happened to sort first.
      await client.query(worstRetry > 0 ? 'ROLLBACK' : 'COMMIT');
      poisoned = false;
      return worstRetry > 0 ? { allowed: false, retryAfterSeconds: worstRetry } : ADMITTED;
    } catch (err: unknown) {
      // A failed transaction must not leave a charged bucket behind. If the rollback itself fails
      // the connection is not known to be clean, so it is destroyed rather than reused.
      try {
        await client.query('ROLLBACK');
        poisoned = false;
      } catch {
        poisoned = true;
      }
      throw err;
    } finally {
      client.release(poisoned || undefined);
    }
  }

  async reset(key: string): Promise<void> {
    await this.pool.query('DELETE FROM rate_limit_buckets WHERE bucket_key = $1', [key]);
  }

  /** True when the bucket admitted and was charged; false when it refused and wrote nothing. */
  private async admitOne(
    executor: Pool | PoolClient,
    request: RateLimitRequest,
  ): Promise<boolean> {
    // A limit of zero admits nothing, and the insert branch cannot say so: with no existing row
    // there is no conflict, so the `WHERE` never runs and a first request would be admitted
    // against a cap it already exceeds.
    if (request.limit.maxRequests < 1) return false;
    const result = await executor.query(ADMIT_ONE, [
      request.key,
      request.limit.windowMs,
      request.limit.maxRequests,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  private async retryAfter(
    executor: Pool | PoolClient,
    request: RateLimitRequest,
  ): Promise<number> {
    const result = await executor.query<{ retry_after_seconds: number }>(RETRY_AFTER, [request.key]);
    const row = result.rows[0];
    // No row means the bucket was swept or expired between the refusal and this read, which leaves
    // the window length as the only honest answer. It is the conservative one too: advising a wait
    // that is too long costs the caller a delay, while one that is too short costs them a request
    // and returns them to the same refusal.
    return row === undefined ? fullWindowSeconds(request.limit) : Number(row.retry_after_seconds);
  }

  /** Opportunistically evict long-dead buckets. Fire-and-forget: never blocks admission. */
  private sweep(): void {
    void this.pool
      .query(`DELETE FROM rate_limit_buckets WHERE expires_at < now() - interval '1 hour'`)
      .catch(() => undefined);
  }
}

function fullWindowSeconds(limit: RateLimit): number {
  return Math.max(1, Math.ceil(limit.windowMs / 1000));
}
