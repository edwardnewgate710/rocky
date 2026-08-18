import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { DuplicateUserError, uuidv7 } from '@chess-platform/persistence';
import {
  createPool,
  migrate,
  PgSessionsRepository,
  PgUsersRepository,
} from '@chess-platform/persistence/pg';
import { PgRateLimiter } from '../src/ports/pg-rate-limiter';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

test('Postgres registration transaction allows one concurrent case-insensitive handle', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const users = new PgUsersRepository(pool);
    const suffix = uuidv7().replaceAll('-', '').slice(0, 12);
    const attempts = await Promise.allSettled([
      users.createWithPasswordAndRole({ id: uuidv7(), handle: `Race${suffix}` }, 'hash-a', 'user'),
      users.createWithPasswordAndRole({ id: uuidv7(), handle: `race${suffix}` }, 'hash-b', 'user'),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof DuplicateUserError);
    const winner = await users.findByHandle(`RACE${suffix}`);
    assert.ok(winner);
    assert.ok(await users.getPasswordHash(winner.id));
    assert.deepEqual(await users.rolesOf(winner.id), ['user']);
  } finally {
    await pool.end();
  }
});

test('Postgres refresh rotation has exactly one winner under concurrency', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const user = await users.createWithPasswordAndRole(
      { id: uuidv7(), handle: `rotate${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const oldId = uuidv7();
    await sessions.create({
      id: oldId,
      userId: user.id,
      refreshHash: `old-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const oldHash = (await pool.query<{ refresh_hash: string }>(
      'SELECT refresh_hash FROM sessions WHERE id = $1', [oldId],
    )).rows[0]!.refresh_hash;
    const now = new Date();
    const rotations = await Promise.all([
      sessions.rotate(oldHash, {
        id: uuidv7(), userId: user.id, refreshHash: `new-a-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000), rotatedFrom: oldId,
      }, now),
      sessions.rotate(oldHash, {
        id: uuidv7(), userId: user.id, refreshHash: `new-b-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000), rotatedFrom: oldId,
      }, now),
    ]);
    assert.deepEqual(rotations.map((result) => result.status).sort(), ['revoked', 'rotated']);
    const children = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM sessions WHERE rotated_from = $1', [oldId],
    );
    assert.equal(children.rows[0]!.count, '1');
  } finally {
    await pool.end();
  }
});

/**
 * `AuthService.revokeSession` audits only when its own call performed the revocation, which is only
 * true if the repository resolves the race rather than the service. The in-memory fake mirrors the
 * contract but cannot prove it — a single JavaScript turn has no interleaving to lose.
 */
test('Postgres session revocation has exactly one winner under concurrency', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const user = await users.createWithPasswordAndRole(
      { id: uuidv7(), handle: `revoke${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const id = uuidv7();
    await sessions.create({
      id,
      userId: user.id,
      refreshHash: `rev-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const at = new Date();
    const outcomes = await Promise.all([
      sessions.revoke(id, at),
      sessions.revoke(id, at),
      sessions.revoke(id, at),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1, 'one caller performed the transition');

    const later = await sessions.revoke(id, new Date(Date.now() + 1_000));
    assert.equal(later, false, 'a revoked session cannot be revoked again');

    const row = (await pool.query<{ revoked_at: Date }>(
      'SELECT revoked_at FROM sessions WHERE id = $1', [id],
    )).rows[0]!;
    assert.equal(row.revoked_at.getTime(), at.getTime(), 'the first revocation time stands');
  } finally {
    await pool.end();
  }
});

/**
 * The account-security screen identifies sessions by their created metadata, so it has to survive
 * the round trip: the columns are written by `create` but were absent from the read projection.
 */
test('Postgres session rows carry the request metadata they were created with', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const user = await users.createWithPasswordAndRole(
      { id: uuidv7(), handle: `meta${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const id = uuidv7();
    await sessions.create({
      id,
      userId: user.id,
      refreshHash: `meta-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121',
    });

    const listed = (await sessions.listForUser(user.id)).find((s) => s.id === id);
    assert.equal(listed?.createdIp, '203.0.113.7');
    assert.equal(listed?.createdUserAgent, 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121');
    assert.equal(listed?.lastIp, null, 'nothing writes the last-seen fields');
  } finally {
    await pool.end();
  }
});

test('Postgres rate limiting is shared and atomic across limiter instances', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const a = new PgRateLimiter(pool);
    const b = new PgRateLimiter(pool);
    const key = `integration:${uuidv7()}`;
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      (index % 2 === 0 ? a : b).admit([{ key, limit: { maxRequests: 5, windowMs: 60_000 } }])));
    assert.equal(results.filter((result) => result.allowed).length, 5);
  } finally {
    await pool.end();
  }
});

/**
 * The all-or-nothing invariant against the real database, where it is actually at risk.
 *
 * The in-memory limiter gets atomicity for free by being synchronous. Postgres does not: two
 * buckets are two statements, so the guarantee has to come from a transaction that rolls back
 * when any of them refuses. Nothing about that is visible to a single-threaded fake, which is why
 * this runs against a live server with real concurrency.
 */
test('Postgres multi-bucket admission charges every bucket or none', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const limiter = new PgRateLimiter(pool);
    const run = uuidv7();
    const full = { key: `integration:full:${run}`, limit: { maxRequests: 1, windowMs: 60_000 } };
    const roomy = { key: `integration:roomy:${run}`, limit: { maxRequests: 5, windowMs: 60_000 } };

    assert.equal((await limiter.admit([full])).allowed, true, "fill the tight bucket");

    // Four refusals, driven concurrently so the transactions genuinely overlap.
    const refusals = await Promise.all(
      Array.from({ length: 4 }, () => limiter.admit([roomy, full])),
    );
    assert.equal(refusals.filter((r) => r.allowed).length, 0);
    assert.ok(refusals.every((r) => r.retryAfterSeconds > 0), "a refusal carries a wait");

    // If any of those had committed its half of the work, the roomy bucket would be short.
    const survivors = [];
    for (let i = 0; i < 5; i += 1) survivors.push(await limiter.admit([roomy]));
    assert.equal(survivors.filter((r) => r.allowed).length, 5, "all five slots were preserved");
    assert.equal((await limiter.admit([roomy])).allowed, false, "and the sixth is refused");
  } finally {
    await pool.end();
  }
});

/**
 * The documented `Retry-After` policy, against the real limiter.
 *
 * When several buckets refuse at once the answer is the longest of their waits. The short bucket
 * is named so that it sorts first, because the transaction visits keys in sorted order — an
 * implementation that reported whichever refusal it met first would return five seconds here, and
 * the caller would come back to a second refusal having learned nothing.
 */
test('Postgres reports the longest wait when several buckets refuse', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const limiter = new PgRateLimiter(pool);
    const run = uuidv7();
    const short = { key: `integration:a-short:${run}`, limit: { maxRequests: 1, windowMs: 5_000 } };
    const long = { key: `integration:z-long:${run}`, limit: { maxRequests: 1, windowMs: 600_000 } };

    assert.equal((await limiter.admit([short, long])).allowed, true);

    const refused = await limiter.admit([short, long]);
    assert.equal(refused.allowed, false);
    assert.ok(
      refused.retryAfterSeconds > 300,
      `expected the 10-minute bucket to set the wait, got ${refused.retryAfterSeconds}s`,
    );
    assert.ok(refused.retryAfterSeconds <= 600);
  } finally {
    await pool.end();
  }
});

/**
 * A refused single-bucket admission must leave the stored counter exactly as it found it.
 *
 * The first implementation incremented unconditionally and decided afterwards, so a refusal
 * persisted `maxRequests + 1` — a charge recorded against a request that never ran. It
 * contradicted the port's own "rejection is free" clause and disagreed with the in-memory
 * limiter, which writes nothing; raising the limit underneath it, as during a rolling
 * configuration change, then handed the next caller a bucket that had already spent a slot on a
 * request it refused. Only a real server can show this, because the evidence is a stored row.
 */
test('Postgres single-bucket refusals leave the stored counter untouched', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const limiter = new PgRateLimiter(pool);
    const key = `integration:refusal:${uuidv7()}`;
    const tight = { key, limit: { maxRequests: 2, windowMs: 600_000 } };

    assert.equal((await limiter.admit([tight])).allowed, true);
    assert.equal((await limiter.admit([tight])).allowed, true);

    // Five refusals against a full bucket.
    for (let i = 0; i < 5; i += 1) {
      const refused = await limiter.admit([tight]);
      assert.equal(refused.allowed, false, `refusal ${i}`);
      assert.ok(refused.retryAfterSeconds > 0, `refusal ${i} carries a wait`);
    }

    const stored = await pool.query<{ request_count: number }>(
      'SELECT request_count FROM rate_limit_buckets WHERE bucket_key = $1',
      [key],
    );
    assert.equal(
      Number(stored.rows[0]!.request_count),
      2,
      'the counter must record the two admissions and none of the five refusals',
    );

    // The observable consequence: raising the limit hands over exactly the slots it promises.
    const raised = { key, limit: { maxRequests: 4, windowMs: 600_000 } };
    assert.equal((await limiter.admit([raised])).allowed, true);
    assert.equal((await limiter.admit([raised])).allowed, true);
    assert.equal((await limiter.admit([raised])).allowed, false);
  } finally {
    await pool.end();
  }
});

/**
 * The wait a losing request is told to observe, when it lost a race to create the bucket.
 *
 * `ON CONFLICT DO UPDATE` can inspect a row committed by a concurrent transaction after the
 * statement began — Postgres steps outside the statement snapshot for exactly that purpose — but
 * an ordinary `SELECT` in the same statement cannot. The first version of the conditional upsert
 * carried its retry lookup in that trailing `SELECT`, so a request refused by a row it could not
 * see reported the one-second fallback for a bucket that was full for the rest of its window.
 * Against a ten-minute window it advised 1s instead of 600s, and the client would have come
 * straight back to the same refusal.
 *
 * The race is forced rather than hoped for: A inserts inside an open transaction, B starts its
 * statement (taking its snapshot) and blocks on the uncommitted unique key, then A commits and B
 * proceeds. Nothing about this is visible without a real server. Raised independently by both the
 * Qodo and CodeRabbit reviews of PR #137.
 */
test('Postgres tells the loser of a bucket-creation race the real remaining window', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const limiter = new PgRateLimiter(pool);
    const key = `integration:create-race:${uuidv7()}`;
    const windowMs = 600_000;
    const bucket = { key, limit: { maxRequests: 1, windowMs } };

    // A holds the row uncommitted; B then starts and blocks on the unique key.
    const holder = await pool.connect();
    let loser;
    try {
      await holder.query('BEGIN');
      await holder.query(
        `INSERT INTO rate_limit_buckets (bucket_key, request_count, window_started_at, expires_at)
         VALUES ($1, 1, now(), now() + ($2 * interval '1 millisecond'))`,
        [key, windowMs],
      );

      const pending = limiter.admit([bucket]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await holder.query('COMMIT');
      loser = await pending;
    } finally {
      holder.release();
    }

    assert.equal(loser.allowed, false, 'the bucket was already full when the race resolved');
    assert.ok(
      loser.retryAfterSeconds > 300,
      `expected the real remaining window, got ${loser.retryAfterSeconds}s`,
    );
    assert.ok(loser.retryAfterSeconds <= 600);
  } finally {
    await pool.end();
  }
});

/**
 * A key may appear at most once, in this implementation as in the in-memory one. Two entries
 * for one key with different limits had no order-independent answer in either.
 */
test('Postgres refuses a duplicate bucket key rather than charging it twice', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const limiter = new PgRateLimiter(pool);
    const key = `integration:dup:${uuidv7()}`;

    await assert.rejects(
      () =>
        limiter.admit([
          { key, limit: { maxRequests: 5, windowMs: 60_000 } },
          { key, limit: { maxRequests: 1, windowMs: 60_000 } },
        ]),
      /duplicate bucket key/,
    );

    const stored = await pool.query(
      'SELECT 1 FROM rate_limit_buckets WHERE bucket_key = $1',
      [key],
    );
    assert.equal(stored.rowCount, 0, 'a refused request must not have created the bucket');
  } finally {
    await pool.end();
  }
});

/**
 * Two concurrent requests, one remaining slot, and a bucket ordering that would deadlock if the
 * limiter took its row locks in the order the caller happened to list them. Both are handed the
 * same pair of keys in opposite orders; the limiter sorts them, so one transaction simply waits
 * for the other instead of the pair being killed as a cycle.
 */
test('Postgres combined admission is deadlock-free and hands the last slot to exactly one', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const limiter = new PgRateLimiter(pool);
    const run = uuidv7();
    // Deliberately named so that "user" sorts before "zip" — the reversed call below hands them
    // over the other way round.
    const user = { key: `integration:auser:${run}`, limit: { maxRequests: 1, windowMs: 60_000 } };
    const zip = { key: `integration:zip:${run}`, limit: { maxRequests: 20, windowMs: 60_000 } };

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? limiter.admit([user, zip]) : limiter.admit([zip, user]),
      ),
    );

    assert.equal(results.filter((r) => r.allowed).length, 1, "exactly one took the single slot");

    // The seven losers charged nothing to the shared bucket: 19 of its 20 slots remain.
    let remaining = 0;
    for (;;) {
      if (!(await limiter.admit([zip])).allowed) break;
      remaining += 1;
      if (remaining > 25) break;
    }
    assert.equal(remaining, 19);
  } finally {
    await pool.end();
  }
});
