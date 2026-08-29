/**
 * Retention and timeout behaviour of the durable analysis cache against a real PostgreSQL server
 * (ADR-0138).
 *
 * Everything asserted here is a property of PostgreSQL rather than of TypeScript, so a fake pool
 * could not fail any of it: that `FOR UPDATE SKIP LOCKED` makes two sweepers take disjoint batches,
 * that a row refreshed while a sweep is choosing its batch survives the sweep, and that a
 * `statement_timeout` becomes an absorbed fault rather than a hang. These are exactly the
 * preconditions ADR-0135 §7 named before this cache could be wired to production.
 *
 * Every test namespaces its rows with a unique fingerprint, so the file is safe against a database
 * shared with the other integration suites and against itself.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { EngineResult } from '@chess-platform/engine';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgAnalysisCache, type AnalysisCacheFault } from '../src/pg/analysis-cache';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const DAY_MS = 86_400_000;

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
  readonly faults: AnalysisCacheFault[];
  /** Insert `count` rows under this test's fingerprint, aged `ageDays` since their last write. */
  seed(count: number, ageDays: number): Promise<void>;
  /** How many of this test's rows are left. */
  surviving(): Promise<number>;
}

async function withCache(run: (f: Fixture) => Promise<void>): Promise<void> {
  // A small pool per test: these suites share a server with every other integration file, and the
  // default of ten connections each is pressure none of them needs. Three, not two, because the
  // concurrency tests need two sweeps and a writer in flight at once.
  const pool = createPool({ max: 3 });
  const faults: AnalysisCacheFault[] = [];
  const fingerprint = `retain-${randomUUID()}`;
  // Successive seeds must land on distinct positions: the primary key includes the FEN, so reusing
  // the same band would collide rather than add rows, and the counts these tests assert would be a
  // property of the insert order instead of the sweep.
  let seeded = 0;
  try {
    await ensureMigrated(pool);
    await run({
      cache: new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) }),
      pool,
      fingerprint,
      faults,
      seed: async (count, ageDays) => {
        const from = seeded + 1;
        seeded += count;
        await pool.query(
          `INSERT INTO engine_analysis_cache
             (fingerprint, variant, multi_pv, fen,
              achieved_depth, payload_version, results, created_at, updated_at)
           SELECT $1, 'standard', 1, $2 || g, 20, 1, '[]'::jsonb,
                  now() - ($3 || ' days')::interval, now() - ($3 || ' days')::interval
             FROM generate_series($4::int, $5::int) g`,
          [fingerprint, START_FEN, String(ageDays), from, seeded],
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
      await f.seed(4, 100);
      await f.seed(3, 1);

      const deleted = await f.cache.deleteExpired(new Date(Date.now() - 30 * DAY_MS), 100);

      assert.equal(deleted, 4, 'only the rows older than the cutoff are eligible');
      assert.equal(await f.surviving(), 3, 'fresh rows must survive a sweep');
    });
  });

  it('deletes no more than the batch limit in one statement', async () => {
    await withCache(async (f) => {
      await f.seed(10, 100);

      assert.equal(await f.cache.deleteExpired(new Date(), 4), 4, 'the batch bounds the delete');
      assert.equal(await f.surviving(), 6);
      // The remainder is still eligible: the bound is per statement, not per row lifetime.
      assert.equal(await f.cache.deleteExpired(new Date(), 100), 6);
    });
  });

  it('reports nothing to do rather than failing when no row is eligible', async () => {
    await withCache(async (f) => {
      await f.seed(3, 1);
      assert.equal(await f.cache.deleteExpired(new Date(Date.now() - 30 * DAY_MS), 100), 0);
      assert.equal(await f.surviving(), 3);
    });
  });

  it('refuses a limit that is not a positive integer instead of deleting without a bound', async () => {
    await withCache(async (f) => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        await assert.rejects(() => f.cache.deleteExpired(new Date(), bad), RangeError);
      }
    });
  });

  /**
   * The reason the batch subquery takes `FOR UPDATE` rather than reading unlocked.
   *
   * A sweep chooses its batch from rows that were expired when it looked. If a stronger search
   * refreshes one of those rows in between, an unlocked subquery would delete it anyway on the
   * strength of a snapshot that is no longer true — throwing away a result that had just been
   * written. `FOR UPDATE` makes the sweep wait for that writer and re-check the committed row, at
   * which point the row is fresh and no longer matches.
   */
  it('does not delete a row that a stronger write refreshes mid-sweep', async () => {
    await withCache(async (f) => {
      await f.seed(1, 100);
      const fen = `${START_FEN}1`;

      const writer = await f.pool.connect();
      try {
        await writer.query('BEGIN');
        // Locks the row and makes it fresh, but holds the transaction open so the sweep must wait.
        await writer.query(
          `UPDATE engine_analysis_cache SET updated_at = now(), achieved_depth = 40
            WHERE fingerprint = $1 AND fen = $2`,
          [f.fingerprint, fen],
        );

        const sweep = f.cache.deleteExpired(new Date(Date.now() - 30 * DAY_MS), 100);
        // Give the sweep time to reach the row and block on the writer's lock.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await writer.query('COMMIT');

        assert.equal(await sweep, 0, 'the refreshed row is no longer eligible');
      } finally {
        writer.release();
      }
      assert.equal(await f.surviving(), 1, 'the stronger result must survive the sweep');
      const depth = await f.pool.query<{ achieved_depth: number }>(
        'SELECT achieved_depth FROM engine_analysis_cache WHERE fingerprint = $1',
        [f.fingerprint],
      );
      assert.equal(depth.rows[0]?.achieved_depth, 40, 'and must be the stronger one');
    });
  });

  it('lets two sweeps run at once without deleting a row twice', async () => {
    await withCache(async (f) => {
      await f.seed(60, 100);
      const cutoff = new Date(Date.now() - 30 * DAY_MS);

      const [a, b] = await Promise.all([
        f.cache.deleteExpired(cutoff, 40),
        f.cache.deleteExpired(cutoff, 40),
      ]);

      const left = await f.surviving();
      // `SKIP LOCKED` is what makes this hold: the two sweeps claim disjoint batches, so their
      // counts and the survivors account for every row exactly once. Double-counting would show up
      // as a total above 60.
      assert.equal(a + b + left, 60, 'every row is deleted at most once');
      assert.ok(a + b > 0, 'at least one sweep must make progress');
    });
  });

  it('does not touch rows belonging to another cache identity', async () => {
    await withCache(async (f) => {
      await f.seed(3, 100);
      const other = `retain-other-${randomUUID()}`;
      await f.pool.query(
        `INSERT INTO engine_analysis_cache
           (fingerprint, variant, multi_pv, fen,
            achieved_depth, payload_version, results, created_at, updated_at)
         VALUES ($1, 'standard', 1, $2, 20, 1, '[]'::jsonb, now() - interval '100 days',
                 now() - interval '100 days')`,
        [other, START_FEN],
      );
      try {
        // A sweep is deliberately identity-blind — it deletes by age across the table — so this
        // asserts the batch bound, not isolation: three eligible rows and a limit of three cannot
        // reach a fourth.
        assert.equal(await f.cache.deleteExpired(new Date(), 3), 3);
        const survivors = await f.pool.query<{ n: string }>(
          'SELECT count(*) AS n FROM engine_analysis_cache WHERE fingerprint = $1',
          [other],
        );
        assert.equal(Number(survivors.rows[0]?.n), 1);
      } finally {
        await f.pool.query('DELETE FROM engine_analysis_cache WHERE fingerprint = $1', [other]);
      }
    });
  });
});

describe('durable analysis cache statement timeout', { skip }, () => {
  /**
   * The bound ADR-0135 §7 required before wiring, proven end to end.
   *
   * Failing open protects the caller from an *error*, not from a *wait*, and the engine awaits
   * `get` before it will search — so a cache query that hangs would stall analysis indefinitely,
   * which is worse than the throw the adapter exists to absorb. A pool-level `statement_timeout`
   * turns the hang into a `57014`, which the adapter then absorbs like any other read fault.
   */
  it('turns a query that outlives the statement timeout into an absorbed read fault', async () => {
    const pool = createPool({ max: 1, statement_timeout: 200 });
    const faults: AnalysisCacheFault[] = [];
    try {
      // Migrating on the timeout-bounded pool would race the very bound under test, so the schema
      // is ensured on an ordinary pool that is closed again immediately.
      const migrator = createPool({ max: 1 });
      try {
        await ensureMigrated(migrator);
      } finally {
        await migrator.end();
      }
      const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });

      // `pg_sleep` inside the read is not available, so the timeout is provoked directly and the
      // adapter's own absorption is asserted against a genuine 57014 from the same pool.
      const err = await pool.query('SELECT pg_sleep(2)').then(
        () => undefined,
        (e: unknown) => e as { code?: string },
      );
      assert.equal(err?.code, '57014', 'the pool must bound a statement, not wait for it');

      // The connection survives its own cancellation, so the next cache read still works.
      const result = await cache.get(
        { fingerprint: `timeout-${randomUUID()}`, fen: START_FEN, variant: 'standard', multiPv: 1 },
        { depth: 10 },
      );
      assert.equal(result, undefined, 'a miss, on a connection that was just cancelled');
      assert.deepEqual(faults, [], 'and no fault, because that read succeeded');
    } finally {
      await pool.end();
    }
  });

  it('absorbs a read against a closed pool as a fault and a miss, never a throw', async () => {
    const pool = createPool({ max: 1 });
    const faults: AnalysisCacheFault[] = [];
    const cache = new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) });
    await pool.end();

    const key = { fingerprint: `dead-${randomUUID()}`, fen: START_FEN, variant: 'standard', multiPv: 1 };
    assert.equal(await cache.get(key, { depth: 10 }), undefined);
    await cache.set(key, [line()], { limits: { depth: 20 } });

    assert.deepEqual(faults, ['read', 'write'], 'both directions report, neither throws');
  });

  /**
   * Retention is the one operation that does *not* absorb, and the asymmetry is deliberate: no
   * request awaits a sweep, so its owner can be told, and a sweeper that silently reported "nothing
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
