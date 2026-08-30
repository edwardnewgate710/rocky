/**
 * Retention and timeout behaviour of the durable analysis cache against a real PostgreSQL server
 * (ADR-0138).
 *
 * Everything asserted here is a property of PostgreSQL rather than of TypeScript, so a fake pool
 * could not fail any of it: that `FOR UPDATE SKIP LOCKED` makes two sweepers take disjoint batches,
 * that a row refreshed while a sweep is choosing its batch survives the sweep, and that a query
 * which would otherwise hang becomes an absorbed fault. These are the preconditions ADR-0135 §7
 * named before this cache could be wired to production.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { AnalysisKey, EngineResult } from '@chess-platform/engine';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgAnalysisCache, type AnalysisCacheFault } from '../src/pg/analysis-cache';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * A sweep is deliberately identity-blind: it deletes by age across the whole table, because that is
 * what bounds the table's growth. So any assertion about *how many* rows a sweep removed is a
 * statement about the entire table — a row left behind by another suite, or by a crashed run of this
 * one, would change the answer.
 *
 * These tests therefore file their expired rows in the last century and sweep with a cutoff at the
 * millennium. Every row any other code path writes is stamped `now()` and is never eligible, so the
 * counts below are properties of the sweep rather than of whatever else is in the table.
 */
const ANCIENT = '1999-01-01T00:00:00Z';
const CUTOFF = new Date('2000-01-01T00:00:00Z');
const ANCIENT_ROWS = `updated_at < TIMESTAMPTZ '2000-01-01'`;

function line(): EngineResult {
  return {
    multipv: 1,
    evaluation: { type: 'cp', value: 24 },
    principalVariation: ['e2e4'],
    depth: 20,
    nodes: 1_000_000,
    nps: 800_000,
    timeMs: 1_200,
  };
}

/** An identity no other test or run can share, so a leftover row cannot answer for it. */
function freshKey(): AnalysisKey {
  return { fingerprint: `t-${randomUUID()}`, fen: START_FEN, variant: 'standard', multiPv: 1 };
}

let migrated = false;

async function ensureMigrated(pool: Pool): Promise<void> {
  if (migrated) return;
  await migrate(pool, join(process.cwd(), 'migrations'));
  migrated = true;
}

interface Fixture {
  readonly cache: PgAnalysisCache;
  readonly pool: Pool;
  readonly fingerprint: string;
  /** Insert `count` rows under this test's fingerprint, either past the cutoff or freshly written. */
  seed(count: number, when: 'expired' | 'fresh'): Promise<void>;
  /** How many of this test's rows are left. */
  surviving(): Promise<number>;
}

async function withCache(run: (f: Fixture) => Promise<void>): Promise<void> {
  // A small pool per test: these suites share a server with every other integration file, and the
  // default of ten connections each is pressure none of them needs. Three, not two, because the
  // concurrency tests need two sweeps and a writer in flight at once.
  const pool = createPool({ max: 3 });
  const fingerprint = `retain-${randomUUID()}`;
  let seeded = 0;
  try {
    await ensureMigrated(pool);
    // A previous run that crashed before its cleanup would leave eligible rows behind and change
    // every count in this file. Nothing else writes a row this old, so removing them is safe.
    await pool.query(`DELETE FROM engine_analysis_cache WHERE ${ANCIENT_ROWS}`);
    await run({
      cache: new PgAnalysisCache(pool),
      pool,
      fingerprint,
      seed: async (count, when) => {
        // Successive seeds must land on distinct positions: the primary key includes the FEN, so
        // reusing a band would collide rather than add rows, and the counts asserted below would be
        // a property of insert order instead of of the sweep.
        const from = seeded + 1;
        seeded += count;
        const stamp = when === 'expired' ? `TIMESTAMPTZ '${ANCIENT}'` : 'now()';
        await pool.query(
          `INSERT INTO engine_analysis_cache
             (fingerprint, variant, multi_pv, fen,
              achieved_depth, payload_version, results, created_at, updated_at)
           SELECT $1, 'standard', 1, $2 || g, 20, 1, '[]'::jsonb, ${stamp}, ${stamp}
             FROM generate_series($3::int, $4::int) g`,
          [fingerprint, START_FEN, from, seeded],
        );
      },
      surviving: async () => {
        const result = await pool.query<{ n: string }>(
          'SELECT count(*) AS n FROM engine_analysis_cache WHERE fingerprint = $1',
          [fingerprint],
        );
        return Number(result.rows[0]?.n ?? 0);
      },
    });
  } finally {
    await pool.query('DELETE FROM engine_analysis_cache WHERE fingerprint = $1', [fingerprint]);
    await pool.end();
  }
}

describe('durable analysis cache retention', { skip }, () => {
  it('deletes rows past the cutoff and leaves fresher ones alone', async () => {
    await withCache(async (f) => {
      await f.seed(4, 'expired');
      await f.seed(3, 'fresh');

      const deleted = await f.cache.deleteExpired(CUTOFF, 100);

      assert.equal(deleted, 4, 'only the rows older than the cutoff are eligible');
      assert.equal(await f.surviving(), 3, 'fresh rows must survive a sweep');
    });
  });

  it('deletes no more than the batch limit in one statement', async () => {
    await withCache(async (f) => {
      await f.seed(10, 'expired');

      assert.equal(await f.cache.deleteExpired(CUTOFF, 4), 4, 'the batch bounds the delete');
      assert.equal(await f.surviving(), 6);
      // The remainder is still eligible: the bound is per statement, not per row lifetime.
      assert.equal(await f.cache.deleteExpired(CUTOFF, 100), 6);
    });
  });

  it('reports nothing to do rather than failing when no row is eligible', async () => {
    await withCache(async (f) => {
      await f.seed(3, 'fresh');
      assert.equal(await f.cache.deleteExpired(CUTOFF, 100), 0);
      assert.equal(await f.surviving(), 3);
    });
  });

  it('refuses a limit that is not a positive integer instead of deleting without a bound', async () => {
    await withCache(async (f) => {
      await f.seed(2, 'expired');
      for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        await assert.rejects(() => f.cache.deleteExpired(CUTOFF, bad), RangeError);
      }
      assert.equal(await f.surviving(), 2, 'a refused sweep must not have deleted anything');
    });
  });

  /**
   * The reason the batch subquery locks rather than reading unlocked.
   *
   * A sweep chooses its batch from rows that were expired when it looked. If a stronger search is
   * refreshing one of those rows at that moment, an unlocked subquery would delete it anyway on the
   * strength of a snapshot that is about to be out of date — discarding a result that was being
   * written as it looked. `SKIP LOCKED` makes the sweep pass over a row another transaction is
   * holding instead, and the next tick sees the committed row and finds it fresh.
   *
   * No polling and no sleep: `SKIP LOCKED` means the sweep never waits, so it can simply be awaited
   * while the writer's transaction is still open. That makes the interleaving the test asserts the
   * only one it can observe.
   */
  it('skips a row a stronger write is holding rather than deleting it', async () => {
    await withCache(async (f) => {
      await f.seed(1, 'expired');
      const fen = `${START_FEN}1`;

      const writer = await f.pool.connect();
      try {
        await writer.query('BEGIN');
        // Locks the row and makes it fresh, and holds the transaction open across the sweep.
        await writer.query(
          `UPDATE engine_analysis_cache SET updated_at = now(), achieved_depth = 40
            WHERE fingerprint = $1 AND fen = $2`,
          [f.fingerprint, fen],
        );

        assert.equal(
          await f.cache.deleteExpired(CUTOFF, 100),
          0,
          'a row another transaction is writing must be skipped, not deleted',
        );
        await writer.query('COMMIT');
      } finally {
        writer.release();
      }

      assert.equal(await f.surviving(), 1, 'the stronger result must survive the sweep');
      const depth = await f.pool.query<{ achieved_depth: number }>(
        'SELECT achieved_depth FROM engine_analysis_cache WHERE fingerprint = $1',
        [f.fingerprint],
      );
      assert.equal(depth.rows[0]?.achieved_depth, 40, 'and must be the stronger one');

      // And once committed it is simply not eligible any more, so the next tick leaves it too.
      assert.equal(await f.cache.deleteExpired(CUTOFF, 100), 0);
      assert.equal(await f.surviving(), 1);
    });
  });

  it('lets two sweeps run at once without deleting a row twice', async () => {
    await withCache(async (f) => {
      await f.seed(60, 'expired');

      const [a, b] = await Promise.all([
        f.cache.deleteExpired(CUTOFF, 40),
        f.cache.deleteExpired(CUTOFF, 40),
      ]);

      const left = await f.surviving();
      // `SKIP LOCKED` is what makes this hold: the two sweeps claim disjoint batches, so their counts
      // and the survivors account for every row exactly once. Double-counting would show up as a
      // total above 60.
      assert.equal(a + b + left, 60, 'every row is deleted at most once');
      assert.ok(a + b > 0, 'at least one sweep must make progress');
    });
  });

  /**
   * What protects another identity's rows is the cutoff, not the identity. A sweep deletes by age
   * across the whole table — that is what bounds growth — so the guarantee worth asserting is that a
   * live row belonging to someone else is never in range, however much of the table is.
   */
  it('leaves a live row of another identity alone while clearing its own expired ones', async () => {
    await withCache(async (f) => {
      await f.seed(3, 'expired');
      const other = `retain-other-${randomUUID()}`;
      await f.pool.query(
        `INSERT INTO engine_analysis_cache
           (fingerprint, variant, multi_pv, fen,
            achieved_depth, payload_version, results, created_at, updated_at)
         VALUES ($1, 'standard', 1, $2, 20, 1, '[]'::jsonb, now(), now())`,
        [other, START_FEN],
      );
      try {
        assert.equal(await f.cache.deleteExpired(CUTOFF, 100), 3, 'only the expired rows go');
        const survivors = await f.pool.query<{ n: string }>(
          'SELECT count(*) AS n FROM engine_analysis_cache WHERE fingerprint = $1',
          [other],
        );
        assert.equal(Number(survivors.rows[0]?.n), 1, 'a live row is never eligible');
      } finally {
        await f.pool.query('DELETE FROM engine_analysis_cache WHERE fingerprint = $1', [other]);
      }
    });
  });
});

describe('durable analysis cache timeouts', { skip }, () => {
  /**
   * The bound ADR-0135 §7 required before wiring, proven through the adapter rather than beside it.
   *
   * Failing open protects the caller from an *error*, not from a *wait*, and the engine awaits `get`
   * before it will search — so a cache query that hangs would stall analysis indefinitely, which is
   * worse than the throw the adapter exists to absorb. An exclusive table lock makes the read hang
   * for real; `statement_timeout` is what turns that hang into a `57014` the adapter can absorb.
   */
  it('turns a read that would hang into an absorbed fault and a miss', async () => {
    const migrator = createPool({ max: 1 });
    try {
      await ensureMigrated(migrator);
    } finally {
      await migrator.end();
    }

    const blocker = createPool({ max: 1 });
    const pool = createPool({ max: 1, statement_timeout: 250 });
    const faults: AnalysisCacheFault[] = [];
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });
    const holder = await blocker.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE engine_analysis_cache IN ACCESS EXCLUSIVE MODE');

      const startedAt = Date.now();
      const result = await cache.get(freshKey(), { depth: 10 });
      const elapsed = Date.now() - startedAt;

      assert.equal(result, undefined, 'a read that cannot complete is a miss, never a throw');
      assert.deepEqual(faults, ['read'], 'and it is reported, so a dead cache is not a cold one');
      assert.ok(elapsed >= 200, `the read must actually have blocked (waited ${elapsed}ms)`);
      assert.ok(elapsed < 5_000, `and must not wait for the lock to clear (waited ${elapsed}ms)`);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      await blocker.end();
      await pool.end();
    }
  });

  it('turns a write that would hang into an absorbed fault, and still resolves', async () => {
    const blocker = createPool({ max: 1 });
    const pool = createPool({ max: 1, statement_timeout: 250 });
    const faults: AnalysisCacheFault[] = [];
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });
    const holder = await blocker.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE engine_analysis_cache IN ACCESS EXCLUSIVE MODE');

      // Resolves rather than rejecting: the caller already has its analysis, so losing the cache
      // write must cost a future recomputation, not this request.
      await cache.set(freshKey(), [line()], { limits: { depth: 20 } });

      assert.deepEqual(faults, ['write']);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      await blocker.end();
      await pool.end();
    }
  });

  /**
   * The half of the bound that `statement_timeout` cannot provide.
   *
   * PostgreSQL starts counting only once a statement is in flight. A saturated pool leaves
   * `pool.query` waiting in a queue inside Node, and `node-postgres` leaves that queue unbounded by
   * default — so a pool with every connection busy would stall analysis for as long as it stayed
   * busy, which is exactly the indefinite wait the statement timeout was added to prevent.
   */
  it('bounds waiting for a connection, not just waiting for a statement', async () => {
    const pool = createPool({ max: 1, statement_timeout: 250, connectionTimeoutMillis: 250 });
    const faults: AnalysisCacheFault[] = [];
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });
    const hog = await pool.connect();
    try {
      const startedAt = Date.now();
      const result = await cache.get(freshKey(), { depth: 10 });
      const elapsed = Date.now() - startedAt;

      assert.equal(result, undefined, 'a connection that never arrives is a miss');
      assert.deepEqual(faults, ['read']);
      assert.ok(elapsed < 5_000, `acquisition must be bounded (waited ${elapsed}ms)`);
    } finally {
      hog.release();
      await pool.end();
    }
  });

  it('absorbs a read against a closed pool as a fault and a miss, never a throw', async () => {
    const pool = createPool({ max: 1 });
    const faults: AnalysisCacheFault[] = [];
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });
    await pool.end();

    const key = freshKey();
    assert.equal(await cache.get(key, { depth: 10 }), undefined);
    await cache.set(key, [line()], { limits: { depth: 20 } });

    assert.deepEqual(faults, ['read', 'write'], 'both directions report, neither throws');
  });

  /**
   * Retention is the one operation that does *not* absorb, and the asymmetry is deliberate: no
   * request awaits a sweep, so its owner can be told — and a sweeper that silently reported "nothing
   * deleted" forever would be indistinguishable from a clean table while the table grew unbounded.
   */
  it('lets a retention failure surface instead of absorbing it', async () => {
    const pool = createPool({ max: 1 });
    const faults: AnalysisCacheFault[] = [];
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });
    await pool.end();

    await assert.rejects(() => cache.deleteExpired(new Date(), 10));
    assert.deepEqual(faults, [], 'and it is not reported through the request-path hook');
  });
});
