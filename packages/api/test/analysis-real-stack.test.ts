/**
 * The whole stack, once: a real engine subprocess, a real PostgreSQL server, and the production
 * durable-cache composition, in one execution (ADR-0138).
 *
 * ADR-0138 shipped the wiring with one gap written into its own consequences section: no CI job had
 * both an engine binary and a database. `analysis-smoke` installed Stockfish and had no
 * `DATABASE_URL`; `postgres-integration` had a database and no binary. So the composed path was
 * proven with the engine package's `FakeEngineTransport` against a real database — every line of the
 * wiring except the one boundary a double cannot fail the way a subprocess fails. That left the
 * single claim the durable tier exists to make — *a replica that never ran this search still answers
 * it* — resting on a fake.
 *
 * This file is that claim, executed. Composition A is built by the production entrypoint, runs a
 * real search through a real binary, and stores the result. It is then shut down. Composition B is
 * built the same way, sharing nothing with A but the database, and answers the same request without
 * searching.
 *
 * **What makes "without searching" an assertion rather than a hope.** `engine_computation_started`
 * is emitted by `AnalysisOrchestrator.compute`, which a cache hit never reaches — `resolve()` is
 * `cached ?? this.compute(...)`. It is a production signal an operator scrapes, not a test hook.
 * Note what it does *not* say: composition B still spawns both engine binaries, because the cache
 * key's fingerprint comes from the UCI handshake and must be known before a lookup can happen. B
 * therefore crosses the subprocess boundary too, and then does not search.
 *
 * Nothing here asserts on elapsed time. A cache is faster than a search, but "faster" is a property
 * of the runner and the counters are a property of the code.
 *
 * Env-gated on both binaries and `DATABASE_URL`, in the same shape as its two neighbours in the
 * smoke script. CI supplies all three and asserts they are present before running the job, because
 * a self-skipping proof is indistinguishable from a passing one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineResult } from '@chess-platform/engine';
import { createPool, migrate } from '@chess-platform/persistence/pg';
import { createAnalysisFromEnv, type AnalysisComposition } from '../src/analysis/composition';
import { createAnalysisCacheComposition } from '../src/analysis/durable-cache';
import { JsonLogger } from '../src/ports/logger';
import { InMemoryMetrics } from '../src/ports/metrics';

const DATABASE_URL = process.env['DATABASE_URL'];

function binaryPresent(variable: string): boolean {
  const path = process.env[variable];
  return path !== undefined && path !== '' && existsSync(path);
}

const skip =
  binaryPresent('STOCKFISH_PATH') && binaryPresent('FAIRY_STOCKFISH_PATH') && DATABASE_URL
    ? false
    : 'needs STOCKFISH_PATH, FAIRY_STOCKFISH_PATH and DATABASE_URL — the analysis-smoke CI job';

/**
 * The Ruy Lopez after 3.Bb5: a fixed, quiet, thoroughly non-terminal position.
 *
 * Fixed rather than randomised, because isolation here comes from a clean fixture rather than from
 * hoping not to collide — the rows for this placement are deleted before the test and again after
 * it, so "composition A missed" is a fact established by the fixture instead of a probability. It is
 * a different position from the one either neighbouring smoke file uses, which is what keeps that
 * delete from touching anything else while the three files run concurrently.
 */
const PLACEMENT = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R';
const FEN = `${PLACEMENT} b KQkq - 3 3`;

/**
 * Both requests are identical, in both compositions, and that is the point: this is one caller
 * asking the same question twice with a restart in between.
 *
 * `depth: 2` is not an optimisation, it is what makes the second lookup deterministic. The stored
 * row records the depth the search *achieved*, and a row satisfies a request only if it reached the
 * request's bound — so leaving depth to its default of 16 would store whatever a loaded runner
 * managed inside the movetime ceiling, perhaps 13, and composition B asking for 16 again would
 * legitimately miss. A depth the engine reaches in under a millisecond is a bound both compositions
 * are certain to clear.
 */
const REQUEST = { depth: 2, movetimeMs: 1_000, multiPv: 1 } as const;

/** One counter, read out of the rendered exposition rather than out of the registry. */
function counter(metrics: InMemoryMetrics, series: string): number {
  const match = new RegExp(`^${series} (\\d+(?:\\.\\d+)?)$`, 'm').exec(metrics.render());
  return match ? Number(match[1]) : 0;
}

const event = (name: string): string => `analysis_cache_events_total{event="${name}"}`;

interface Node_ {
  readonly composition: AnalysisComposition;
  readonly metrics: InMemoryMetrics;
}

/**
 * One process's worth of production: the composition root's own call, with the durable tier built by
 * the same factory `createPgDependencies` uses and pointed at the same database.
 *
 * The engine half is not constructed here at all — `createAnalysisFromEnv` reads `STOCKFISH_PATH`
 * and `FAIRY_STOCKFISH_PATH` from the environment and spawns real binaries, which is the whole
 * reason this file can only run in the job that installs them.
 */
function compose(): Node_ {
  const metrics = new InMemoryMetrics();
  const logger = new JsonLogger({}, { level: 'error', sink: () => {} });
  const composition = createAnalysisFromEnv(process.env, () =>
    createAnalysisCacheComposition({
      settings: { durable: true, ttlMs: 30 * 86_400_000 },
      logger,
      metrics,
      // Guarded by `skip`: this test does not run without one.
      connectionString: DATABASE_URL!,
    }),
  );
  assert.ok(composition !== undefined, 'both engine paths are configured, so a composition must be built');
  return { composition, metrics };
}

/** A search result that could only have come from an engine that actually looked at the board. */
function assertRealSearch(lines: readonly EngineResult[]): void {
  assert.equal(lines.length, 1, 'multiPv: 1 yields one line');
  const best = lines[0];
  assert.ok(best !== undefined);
  assert.ok(best.depth >= 2, `the requested depth must be reached, got ${best.depth}`);
  assert.match(
    best.principalVariation[0] ?? '',
    /^[a-h][1-8][a-h][1-8][qrbn]?$/,
    'a principal variation in UCI long algebraic form is what proves the FEN reached the engine and the reply was parsed',
  );
  assert.ok(['cp', 'mate'].includes(best.evaluation.type));
  assert.ok(Number.isFinite(best.evaluation.value));
}

test('the durable cache serves a real engine search back to a second composition', { skip }, async () => {
  // Not capped at one connection: `migrate` holds the advisory lock on a dedicated client and runs
  // every statement on another, so a single-connection pool deadlocks against itself.
  const admin = createPool({ connectionString: DATABASE_URL });

  // Declared out here so the teardown below can reach them however the body exits. An assertion
  // failing inside the first composition must not also leak two engine subprocesses and a
  // connection pool — open stdio pipes keep the event loop alive, so `node --test` would stop
  // reporting the failure and start hanging until the job timeout.
  let first: Node_ | undefined;
  let second: Node_ | undefined;

  try {
    // The canonical runner, from the package that owns the migrations — never a test-only CREATE
    // TABLE. 0027's index is part of what is under test, and a schema this file invented for itself
    // would prove the production schema nothing at all.
    await migrate(admin, join(process.cwd(), '../persistence/migrations'));

    // A clean fixture, by prefix: this covers both the FEN as written and the seven-field spelling
    // `engineFenFor` rewrites a Three-Check position into, without this file having to reproduce
    // that canonicalisation and get it subtly wrong.
    await admin.query('DELETE FROM engine_analysis_cache WHERE fen LIKE $1', [`${PLACEMENT} %`]);

    // ---------------------------------------------------------------- composition A: cold
    first = compose();
    const cold = {
      standard: await first.composition.service.analyze({ fen: FEN, variant: 'standard', ...REQUEST }),
      threecheck: await first.composition.service.analyze({ fen: FEN, variant: 'threecheck', ...REQUEST }),
    };

    assertRealSearch(cold.standard.lines);
    assertRealSearch(cold.threecheck.lines);
    assert.equal(counter(first.metrics, event('cache_miss')), 2, 'a clean fixture is a miss on both engines');
    assert.equal(
      counter(first.metrics, event('engine_computation_started')),
      2,
      'both searches must have crossed the subprocess boundary',
    );
    assert.equal(counter(first.metrics, event('cache_hit')), 0);

    // The rows exist in PostgreSQL, not merely in the process that wrote them. Two, because
    // `variant` is part of the primary key — and their FENs differ, because Three-Check is
    // canonicalised before it becomes a key.
    const stored = await admin.query<{ variant: string; achieved_depth: number | null }>(
      'SELECT variant, achieved_depth FROM engine_analysis_cache WHERE fen LIKE $1 ORDER BY variant',
      [`${PLACEMENT} %`],
    );
    assert.deepEqual(
      stored.rows.map((row) => row.variant),
      ['standard', 'threecheck'],
      'a real search through each engine family leaves exactly one durable row each',
    );
    for (const row of stored.rows) assert.ok((row.achieved_depth ?? 0) >= 2);

    // Drain everything: engine subprocesses, the retention sweeper, the cache pool. What survives
    // this is the database, and nothing else.
    const coldMetrics = first.metrics;
    await first.composition.shutdown({ deadlineMs: 10_000 });
    first = undefined;

    // ---------------------------------------------------------------- composition B: warm
    second = compose();
    const warm = {
      standard: await second.composition.service.analyze({ fen: FEN, variant: 'standard', ...REQUEST }),
      threecheck: await second.composition.service.analyze({ fen: FEN, variant: 'threecheck', ...REQUEST }),
    };

    assert.equal(
      counter(second.metrics, event('engine_computation_started')),
      0,
      'the second composition must answer from the database without searching',
    );
    assert.equal(counter(second.metrics, event('cache_hit')), 2);
    assert.equal(counter(second.metrics, event('cache_miss')), 0);
    assert.deepEqual(warm.standard.lines, cold.standard.lines, 'the cached analysis is the analysis');
    assert.deepEqual(warm.threecheck.lines, cold.threecheck.lines);

    // A sanity check on the database rather than a proof of the fault hook, which
    // `analysis-cache-durable.integration.test.ts` owns: absorbed faults would have turned every
    // read above into a miss, so this only rules out a hit that arrived alongside a reported fault.
    for (const metrics of [coldMetrics, second.metrics]) {
      for (const fault of ['read', 'write']) {
        assert.equal(counter(metrics, `analysis_cache_faults_total{fault="${fault}"}`), 0);
      }
    }
  } finally {
    await Promise.allSettled([
      first?.composition.shutdown({ deadlineMs: 10_000 }),
      second?.composition.shutdown({ deadlineMs: 10_000 }),
    ]);
    await admin
      .query('DELETE FROM engine_analysis_cache WHERE fen LIKE $1', [`${PLACEMENT} %`])
      .catch(() => {});
    await admin.end();
  }
});
