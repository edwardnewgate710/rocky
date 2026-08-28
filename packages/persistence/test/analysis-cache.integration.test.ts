/**
 * The durable analysis cache against a real PostgreSQL server. These tests exist because the
 * satisfaction and replacement rules live in SQL — in the read predicate and in the
 * `ON CONFLICT DO UPDATE ... WHERE` guard — and neither can be exercised by a fake pool.
 *
 * Every test namespaces its rows with a unique fingerprint, so the file is safe to run against a
 * database shared with the other integration suites and against itself.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { AnalysisKey, EngineResult } from '@chess-platform/engine';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { ANALYSIS_CACHE_PAYLOAD_VERSION, encodeAnalysisPayload } from '../src/analysis-cache';
import { PgAnalysisCache, type AnalysisCacheFault } from '../src/pg/analysis-cache';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** A result whose fields are distinctive enough that a round trip cannot accidentally pass. */
function line(multipv: number): EngineResult {
  return {
    multipv,
    evaluation: { type: 'cp', value: 35 - multipv },
    evaluationBound: 'lowerbound',
    principalVariation: ['e2e4', 'c7c5', 'g1f3'],
    depth: 20,
    selDepth: 28,
    nodes: 1_000_000,
    nps: 850_000,
    timeMs: 1200,
  };
}


/**
 * A second, clearly distinguishable single-line analysis. Still multipv 1: a lone line(2) would
 * be a set whose only line claims to be the second-best, which the payload contract refuses.
 */
function otherLine(): EngineResult {
  return {
    ...line(1),
    evaluation: { type: 'cp', value: -60 },
    principalVariation: ['d2d4', 'd7d5'],
  };
}

/** A fresh identity per test, so suites sharing one database cannot collide. */
function freshKey(overrides: Partial<AnalysisKey> = {}): AnalysisKey {
  return {
    fingerprint: `fp-${randomUUID()}`,
    fen: START_FEN,
    variant: 'standard',
    multiPv: 1,
    ...overrides,
  };
}

/**
 * Migrations are applied once for the whole file, not once per test. The runner is safe either
 * way — it holds an advisory lock — but re-walking every migration for each of twenty-odd tests
 * buys nothing and slows the Postgres CI job for no reason.
 */
let migrated: Promise<void> | undefined;

function ensureMigrated(pool: Pool): Promise<void> {
  migrated ??= migrate(pool, join(process.cwd(), 'migrations')).then(() => undefined);
  return migrated;
}

async function withCache(
  run: (cache: PgAnalysisCache, pool: Pool, faults: AnalysisCacheFault[]) => Promise<void>,
): Promise<void> {
  // A small pool per test: these suites share a server with every other integration file, and
  // the default of ten connections each is pressure none of them needs.
  const pool = createPool({ max: 2 });
  const faults: AnalysisCacheFault[] = [];
  try {
    await ensureMigrated(pool);
    await run(new PgAnalysisCache(pool, { onError: (fault) => faults.push(fault) }), pool, faults);
  } finally {
    await pool.end();
  }
}

async function storedLimitsOf(pool: Pool, key: AnalysisKey): Promise<Record<string, unknown>> {
  const result = await pool.query(
    `SELECT achieved_depth, achieved_nodes, achieved_time_ms, payload_version
       FROM engine_analysis_cache
      WHERE fingerprint = $1 AND variant = $2 AND multi_pv = $3 AND fen = $4`,
    [key.fingerprint, key.variant, key.multiPv, key.fen],
  );
  assert.equal(result.rowCount, 1, 'exactly one row should carry an identity');
  return result.rows[0] as Record<string, unknown>;
}

describe('PgAnalysisCache satisfaction semantics', { skip }, () => {
  it('misses when nothing was ever stored for the identity', async () => {
    await withCache(async (cache) => {
      assert.equal(await cache.get(freshKey(), { depth: 10 }), undefined);
    });
  });

  it('returns the stored analysis for the request it exactly satisfies', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20, nodes: 1_000_000 } });
      assert.deepEqual(await cache.get(key, { depth: 20, nodes: 1_000_000 }), [line(1)]);
    });
  });

  it('serves a deeper stored search to a shallower request', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20 } });
      assert.deepEqual(await cache.get(key, { depth: 12 }), [line(1)]);
    });
  });

  it('refuses a shallower stored search to a deeper request', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 12 } });
      assert.equal(await cache.get(key, { depth: 20 }), undefined);
    });
  });

  it('compares nodes the same way it compares depth', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { nodes: 1_000_000 } });
      assert.deepEqual(await cache.get(key, { nodes: 900_000 }), [line(1)]);
      assert.equal(await cache.get(key, { nodes: 1_000_001 }), undefined);
    });
  });

  it('compares time the same way it compares depth', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { timeMs: 5000 } });
      assert.deepEqual(await cache.get(key, { timeMs: 5000 }), [line(1)]);
      assert.equal(await cache.get(key, { timeMs: 5001 }), undefined);
    });
  });

  it('requires every stated dimension, not merely one of them', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20, nodes: 500_000 } });

      assert.deepEqual(await cache.get(key, { depth: 20, nodes: 500_000 }), [line(1)]);
      assert.equal(
        await cache.get(key, { depth: 20, nodes: 900_000 }),
        undefined,
        'satisfying depth must not excuse falling short on nodes',
      );
      assert.equal(
        await cache.get(key, { depth: 30, nodes: 500_000 }),
        undefined,
        'satisfying nodes must not excuse falling short on depth',
      );
    });
  });

  it('treats a dimension the stored search never bounded as unsatisfied, not as satisfied', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20 } });
      assert.equal(
        await cache.get(key, { nodes: 1 }),
        undefined,
        'an absent measurement is not an adequate one',
      );
    });
  });
});

describe('PgAnalysisCache identity isolation', { skip }, () => {
  it('never serves a result from one engine build for another', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20 } });

      const otherBuild = { ...key, fingerprint: `fp-${randomUUID()}` };
      assert.equal(await cache.get(otherBuild, { depth: 20 }), undefined);
    });
  });

  it('never serves a result for one position as another', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20 } });

      const afterE4 = { ...key, fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1' };
      assert.equal(await cache.get(afterE4, { depth: 20 }), undefined);
    });
  });

  it('never leaks a result across variants', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20 } });

      assert.equal(await cache.get({ ...key, variant: 'crazyhouse' }, { depth: 20 }), undefined);
    });
  });

  it('never lets one MultiPV width answer for another', async () => {
    await withCache(async (cache) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20 } });

      assert.equal(
        await cache.get({ ...key, multiPv: 3 }, { depth: 20 }),
        undefined,
        'a one-line search is not a three-line search',
      );
    });
  });
});

describe('PgAnalysisCache round trip', { skip }, () => {
  it('returns every contractually meaningful field exactly as stored', async () => {
    await withCache(async (cache) => {
      const key = freshKey({ multiPv: 3 });
      const lean: EngineResult = {
        multipv: 3,
        evaluation: { type: 'mate', value: -4 },
        principalVariation: [],
        depth: 20,
        nodes: 9_007_199_254_740_990,
        nps: 0,
        timeMs: 0,
      };
      const stored = [line(1), line(2), lean];

      await cache.set(key, stored, { limits: { depth: 20 } });
      const loaded = await cache.get(key, { depth: 20 });

      assert.deepEqual(loaded, stored);
      const [, , third] = loaded ?? [];
      assert.ok(third);
      assert.equal('selDepth' in third, false, 'an absent optional must not come back as null');
      assert.equal('evaluationBound' in third, false);
    });
  });
});

describe('PgAnalysisCache replacement semantics', { skip }, () => {
  it('does not let a weaker search that finishes later destroy a stronger entry', async () => {
    await withCache(async (cache, pool) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20, nodes: 1_000_000 } });
      await cache.set(key, [otherLine()], { limits: { depth: 10, nodes: 100_000 } });

      const row = await storedLimitsOf(pool, key);
      assert.equal(row['achieved_depth'], 20);
      assert.deepEqual(
        await cache.get(key, { depth: 20 }),
        [line(1)],
        'the depth-20 request must still hit the depth-20 analysis',
      );
    });
  });

  it('lets a stronger search replace a weaker entry', async () => {
    await withCache(async (cache, pool) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 10, nodes: 100_000 } });
      await cache.set(key, [otherLine()], { limits: { depth: 20, nodes: 1_000_000 } });

      assert.equal((await storedLimitsOf(pool, key))['achieved_depth'], 20);
      assert.deepEqual(await cache.get(key, { depth: 20 }), [otherLine()]);
    });
  });

  it('keeps the incumbent when neither search could serve the other request', async () => {
    await withCache(async (cache, pool) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20, nodes: 1_000_000 } });
      // Deeper, but on fewer nodes: it cannot serve the incumbent's nodes:1000000 request.
      await cache.set(key, [otherLine()], { limits: { depth: 22, nodes: 900_000 } });

      const row = await storedLimitsOf(pool, key);
      assert.equal(row['achieved_depth'], 20, 'a non-dominating write must not evict');
      // BIGINT arrives from pg as a string, which is why this package reads such columns
      // through Number() everywhere else; comparing that way keeps the assertion about the
      // value rather than about the driver's representation of it.
      assert.equal(Number(row['achieved_nodes']), 1_000_000);
    });
  });

  it('keeps one row per identity however many times it is written', async () => {
    await withCache(async (cache, pool) => {
      const key = freshKey();
      for (const depth of [10, 20, 15, 20]) {
        await cache.set(key, [line(1)], { limits: { depth } });
      }
      await storedLimitsOf(pool, key); // asserts exactly one row
    });
  });

  it('is unchanged by writing the identical entry twice', async () => {
    await withCache(async (cache, pool) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 20 } });
      await cache.set(key, [line(1)], { limits: { depth: 20 } });

      assert.equal((await storedLimitsOf(pool, key))['achieved_depth'], 20);
      assert.deepEqual(await cache.get(key, { depth: 20 }), [line(1)]);
    });
  });

  it('never lets a build that speaks an older payload version overwrite a newer one', async () => {
    await withCache(async (cache, pool) => {
      const key = freshKey();
      const now = new Date();
      await pool.query(
        `INSERT INTO engine_analysis_cache (
           fingerprint, variant, multi_pv, fen, achieved_depth,
           payload_version, results, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 5, $5, $6::jsonb, $7, $7)`,
        [
          key.fingerprint,
          key.variant,
          key.multiPv,
          key.fen,
          ANALYSIS_CACHE_PAYLOAD_VERSION + 1,
          JSON.stringify(encodeAnalysisPayload([line(1)])),
          now,
        ],
      );

      // Dominating on depth, but written by a build that cannot read what is already there.
      await cache.set(key, [otherLine()], { limits: { depth: 99 } });

      const row = await storedLimitsOf(pool, key);
      assert.equal(
        row['payload_version'],
        ANALYSIS_CACHE_PAYLOAD_VERSION + 1,
        'a rolling deploy must not let the older build destroy the newer payload',
      );
      assert.equal(row['achieved_depth'], 5);
    });
  });

  /*
   * The version gates a dominating write; it is never a way past the dominance check. So no branch
   * here can replace a row without comparing limits — which is exactly what a newer version used to
   * be able to do. What remains unreachable from this build is only the benign direction: it writes
   * exactly ANALYSIS_CACHE_PAYLOAD_VERSION, so no write presents a version above an incumbent's,
   * and a version 2 taking over a version 1 row becomes exercisable when that version exists.
   * Every case that could lose a stronger result is covered above.
   */

  it('treats the row it refused to overwrite as unreadable rather than as results', async () => {
    await withCache(async (cache, pool, faults) => {
      const key = freshKey();
      const now = new Date();
      await pool.query(
        `INSERT INTO engine_analysis_cache (
           fingerprint, variant, multi_pv, fen, achieved_depth,
           payload_version, results, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 20, $5, $6::jsonb, $7, $7)`,
        [
          key.fingerprint,
          key.variant,
          key.multiPv,
          key.fen,
          ANALYSIS_CACHE_PAYLOAD_VERSION + 1,
          JSON.stringify(encodeAnalysisPayload([line(1)])),
          now,
        ],
      );

      assert.equal(await cache.get(key, { depth: 20 }), undefined);
      assert.deepEqual(faults, ['payload'], 'a version it cannot read is a miss, not a guess');
    });
  });
});

describe('PgAnalysisCache under concurrency', { skip }, () => {
  it('cannot be downgraded by weaker writes racing a stronger one', async () => {
    await withCache(async (cache, pool) => {
      const key = freshKey();
      const depths = [4, 30, 8, 12, 30, 6, 21, 2];

      // The outcome is order-independent: whichever order these land in, the strongest
      // dominates every other, so the strongest must be what remains.
      await Promise.all(
        depths.map((depth) => cache.set(key, [line(1)], { limits: { depth, nodes: depth * 1000 } })),
      );

      const row = await storedLimitsOf(pool, key);
      assert.equal(row['achieved_depth'], 30);
      assert.equal(Number(row['achieved_nodes']), 30_000);
    });
  });

  it('serializes concurrent writes to one identity into exactly one row', async () => {
    await withCache(async (cache, pool) => {
      const key = freshKey();
      await Promise.all(
        Array.from({ length: 16 }, (_, i) =>
          cache.set(key, [line(1)], { limits: { depth: 10 + (i % 4) } }),
        ),
      );
      await storedLimitsOf(pool, key); // asserts exactly one row survives the race
    });
  });

  it('never shows a reader a half-written entry while writers replace it', async () => {
    await withCache(async (cache, _pool, faults) => {
      const key = freshKey();
      await cache.set(key, [line(1)], { limits: { depth: 10 } });

      // Every write dominates the seed, so the row's depth only ever climbs: a request for
      // depth 10 is satisfied at every instant, and so every one of these reads must hit.
      // Skipping undefined values instead of forbidding them would let this pass while the
      // cache returned nothing at all.
      const writes = Array.from({ length: 12 }, (_, i) =>
        cache.set(key, [line(1), line(2)], { limits: { depth: 11 + i } }),
      );
      const reads = Array.from({ length: 12 }, () => cache.get(key, { depth: 10 }));

      const observed = await Promise.all(reads);
      await Promise.all(writes);

      assert.equal(observed.length, 12);
      for (const value of observed) {
        assert.ok(value !== undefined, 'a read missed a key that always satisfied the request');
        // One line from the seed, two from any replacement — never a mixture of the two.
        assert.ok(value.length === 1 || value.length === 2, 'a read saw a torn line count');
        assert.deepEqual(
          value,
          value.length === 1 ? [line(1)] : [line(1), line(2)],
          'a decoded entry must be exactly one of the values actually written',
        );
      }
      assert.deepEqual(faults, [], 'no read or write should have faulted');
    });
  });
});

describe('engine_analysis_cache schema constraints', { skip }, () => {
  async function insert(pool: Pool, columns: string, values: unknown[]): Promise<void> {
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(
      `INSERT INTO engine_analysis_cache (${columns}) VALUES (${placeholders})`,
      values,
    );
  }

  const BASE = 'fingerprint, variant, multi_pv, fen, payload_version, results, created_at, updated_at';

  it('refuses a row that states no achieved dimension at all', async () => {
    await withCache(async (_cache, pool) => {
      const key = freshKey();
      await assert.rejects(
        insert(pool, BASE, [
          key.fingerprint,
          key.variant,
          key.multiPv,
          key.fen,
          ANALYSIS_CACHE_PAYLOAD_VERSION,
          JSON.stringify(encodeAnalysisPayload([line(1)])),
          new Date(),
          new Date(),
        ]),
        /check constraint/i,
      );
    });
  });

  it('refuses a negative achieved dimension', async () => {
    await withCache(async (_cache, pool) => {
      const key = freshKey();
      await assert.rejects(
        insert(pool, `${BASE}, achieved_depth`, [
          key.fingerprint,
          key.variant,
          key.multiPv,
          key.fen,
          ANALYSIS_CACHE_PAYLOAD_VERSION,
          JSON.stringify(encodeAnalysisPayload([line(1)])),
          new Date(),
          new Date(),
          -1,
        ]),
        /check constraint/i,
      );
    });
  });

  it('refuses a MultiPV width below one', async () => {
    await withCache(async (_cache, pool) => {
      const key = freshKey();
      await assert.rejects(
        insert(pool, `${BASE}, achieved_depth`, [
          key.fingerprint,
          key.variant,
          0,
          key.fen,
          ANALYSIS_CACHE_PAYLOAD_VERSION,
          JSON.stringify(encodeAnalysisPayload([line(1)])),
          new Date(),
          new Date(),
          20,
        ]),
        /check constraint/i,
      );
    });
  });

  it('refuses a payload that is not a JSON array', async () => {
    await withCache(async (_cache, pool) => {
      const key = freshKey();
      await assert.rejects(
        insert(pool, `${BASE}, achieved_depth`, [
          key.fingerprint,
          key.variant,
          key.multiPv,
          key.fen,
          ANALYSIS_CACHE_PAYLOAD_VERSION,
          JSON.stringify({ multipv: 1 }),
          new Date(),
          new Date(),
          20,
        ]),
        /check constraint/i,
      );
    });
  });

  it('refuses a FEN too long to be a position', async () => {
    await withCache(async (_cache, pool) => {
      const key = freshKey();
      await assert.rejects(
        insert(pool, `${BASE}, achieved_depth`, [
          key.fingerprint,
          key.variant,
          key.multiPv,
          'x'.repeat(257),
          ANALYSIS_CACHE_PAYLOAD_VERSION,
          JSON.stringify(encodeAnalysisPayload([line(1)])),
          new Date(),
          new Date(),
          20,
        ]),
        /check constraint/i,
      );
    });
  });
});

describe('PgAnalysisCache against a corrupt row', { skip }, () => {
  it('treats an undecodable stored payload as a miss and reports it', async () => {
    await withCache(async (cache, pool, faults) => {
      const key = freshKey();
      const now = new Date();
      await pool.query(
        `INSERT INTO engine_analysis_cache (
           fingerprint, variant, multi_pv, fen, achieved_depth,
           payload_version, results, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 20, $5, $6::jsonb, $7, $7)`,
        [
          key.fingerprint,
          key.variant,
          key.multiPv,
          key.fen,
          ANALYSIS_CACHE_PAYLOAD_VERSION,
          JSON.stringify([{ multipv: 'first', evaluation: null }]),
          now,
        ],
      );

      assert.equal(await cache.get(key, { depth: 20 }), undefined);
      assert.deepEqual(faults, ['payload']);
    });
  });
});
