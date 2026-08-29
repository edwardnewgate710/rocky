/**
 * The durable analysis cache as production actually composes it, against a real PostgreSQL server
 * (ADR-0138).
 *
 * This is the test that the pieces are *connected*, which is the whole of what Phase B2 adds and the
 * one thing neither side's own suite can show. The engine's suite proves the orchestrator against
 * fake caches; the persistence suite proves the adapter against a real database. Between them sits
 * the wiring — and ADR-0113's own history is the argument for testing it: every unit test passed
 * while `createPgDependencies` never called `createAnalysisFromEnv`, so the endpoint was dead in
 * production and nothing failed.
 *
 * So the cache here is built by the production factory, `createAnalysisCacheComposition` — the same
 * call `createPgDependencies` makes, with the same pool settings — and it is driven through a real
 * `EngineManager`. Only the engine subprocess is a double, because a UCI binary is the one thing
 * this job cannot install; `FakeEngineTransport` is the engine package's own, and counting its `go`
 * commands is what makes "the engine did not run again" an assertion rather than a hope.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import {
  EngineManager,
  FakeEngineTransport,
  stockfishPlugin,
  type EngineResult,
} from '@chess-platform/engine';
import { createPool } from '@chess-platform/persistence/pg';
import { createAnalysisCacheComposition } from '../src/analysis/durable-cache';
import type { AnalysisCacheComposition } from '../src/analysis/composition';
import { JsonLogger } from '../src/ports/logger';
import { InMemoryMetrics } from '../src/ports/metrics';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

const STOCKFISH_OPTIONS = [
  'option name Threads type spin default 1 min 1 max 512',
  'option name Hash type spin default 16 min 1 max 1024',
  'option name MultiPV type spin default 1 min 1 max 256',
  'option name UCI_Chess960 type check default false',
];

const INFO = 'info depth 10 seldepth 12 nodes 12345 nps 50000 time 200 score cp 20 multipv 1 pv e2e4';

/**
 * A position unique to this run.
 *
 * The cache identity includes the FEN, and these suites share a database with every other
 * integration file and with previous runs of themselves. Varying the fullmove counter keeps the FEN
 * structurally valid while making each test's identity its own, so a leftover row can neither
 * satisfy a request this test meant to miss nor be mistaken for one it wrote.
 */
function freshFen(): string {
  return `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 ${randomInt(1, 2_000_000)}`;
}

interface Instance {
  readonly manager: EngineManager;
  readonly tier: AnalysisCacheComposition;
  readonly metrics: InMemoryMetrics;
  /** How many times a worker was actually asked to search. */
  searches(): number;
  shutdown(): Promise<void>;
}

/**
 * One process's worth of the production composition: a cache tier from the real factory, and an
 * `EngineManager` wired to it exactly as `createAnalysisEngine` wires one.
 */
function instance(options: { engineName?: string; connectionString?: string } = {}): Instance {
  const metrics = new InMemoryMetrics();
  const logger = new JsonLogger({}, { level: 'error', sink: () => {} });
  const tier = createAnalysisCacheComposition({
    settings: { durable: true, ttlMs: 30 * 86_400_000 },
    logger,
    metrics,
    connectionString: options.connectionString ?? DATABASE_URL,
  });

  let searches = 0;
  const manager = new EngineManager({
    transportFactory: () =>
      new FakeEngineTransport({
        name: options.engineName ?? 'Stockfish 16',
        optionLines: STOCKFISH_OPTIONS,
        go: () => {
          searches += 1;
          return { info: [INFO], bestmove: 'e2e4' };
        },
      }),
    ...(tier.cache !== undefined ? { cache: tier.cache } : {}),
    observer: tier.observer,
    minWorkers: 0,
    maxWorkers: 1,
  });
  manager.register(stockfishPlugin);

  return {
    manager,
    tier,
    metrics,
    searches: () => searches,
    shutdown: async () => {
      // The same order the composition uses: drain the engine, then release the cache, so a search
      // finishing during shutdown can still store what it found.
      await manager.shutdown({ deadlineMs: 2_000 });
      await tier.shutdown();
    },
  };
}

async function analyze(node: Instance, fen: string): Promise<readonly EngineResult[]> {
  return node.manager.analyze({ fen, variant: 'standard', limits: { depth: 10 } });
}

function counter(metrics: InMemoryMetrics, series: string): number {
  const match = new RegExp(`^${series} (\\d+(?:\\.\\d+)?)$`, 'm').exec(metrics.render());
  return match ? Number(match[1]) : 0;
}

test('a cold position is computed once and then served from the database', { skip }, async () => {
  const node = instance();
  const fen = freshFen();
  try {
    const first = await analyze(node, fen);
    assert.equal(node.searches(), 1, 'a cold identity must reach the engine');

    const second = await analyze(node, fen);
    assert.deepEqual(second, first, 'the cached analysis is the analysis, not an approximation');
    assert.equal(node.searches(), 1, 'the second request must not run a search');

    assert.equal(counter(node.metrics, 'analysis_cache_events_total{event="cache_hit"}'), 1);
    assert.equal(counter(node.metrics, 'analysis_cache_events_total{event="cache_miss"}'), 1);
    assert.equal(counter(node.metrics, 'analysis_cache_faults_total{fault="read"}'), 0);
  } finally {
    await node.shutdown();
  }
});

/**
 * The reason the cache is durable at all.
 *
 * An in-process cache cannot do this: its entries die with the process that made them, so every
 * replica starts cold and every deploy throws the fleet's accumulated analysis away. Instance B here
 * has its own pool, its own manager and its own workers, and shares nothing with A but the table.
 */
test('a second instance reuses what the first stored, with no engine of its own', { skip }, async () => {
  const fen = freshFen();
  const first = instance();
  try {
    await analyze(first, fen);
    assert.equal(first.searches(), 1);
  } finally {
    await first.shutdown();
  }

  const second = instance();
  try {
    const results = await analyze(second, fen);
    assert.equal(second.searches(), 0, 'the durable row must answer without a search');
    assert.equal(results[0]?.depth, 10, 'and must carry the analysis the first instance found');
    assert.equal(counter(second.metrics, 'analysis_cache_events_total{event="cache_hit"}'), 1);
  } finally {
    await second.shutdown();
  }
});

/**
 * Identity survives the composition, which was ADR-0135 §7's first precondition for wiring this up.
 * A different engine build advertises different options, which changes its fingerprint, which is a
 * different row — so an upgrade cannot serve yesterday's analysis as today's.
 */
test('a different engine build does not read the first build\'s rows', { skip }, async () => {
  const fen = freshFen();
  const sixteen = instance({ engineName: 'Stockfish 16' });
  try {
    await analyze(sixteen, fen);
    assert.equal(sixteen.searches(), 1);
  } finally {
    await sixteen.shutdown();
  }

  const seventeen = instance({ engineName: 'Stockfish 17' });
  try {
    await analyze(seventeen, fen);
    assert.equal(seventeen.searches(), 1, 'a new build must compute rather than inherit');
    assert.equal(counter(seventeen.metrics, 'analysis_cache_events_total{event="cache_hit"}'), 0);
  } finally {
    await seventeen.shutdown();
  }
});

/**
 * The failure ADR-0135 §6 promised: a database outage costs recomputation, never an error, and never
 * silence.
 *
 * The last assertion is the subtle one and the reason the fault counter exists at all. A failed
 * write still resolves, so the engine records `cache_write_completed` — an operator watching engine
 * events alone would see a perfectly healthy cache throughout a total outage. Only the fault counter
 * can tell those apart.
 */
test('a dead database costs a recomputation, not a failed analysis', { skip }, async () => {
  const node = instance();
  const fen = freshFen();
  try {
    // Kill the cache underneath a live manager: every subsequent get and set fails.
    await node.tier.shutdown();

    const results = await analyze(node, fen);

    assert.equal(results.length, 1, 'the caller still gets a real analysis');
    assert.equal(results[0]?.evaluation.value, 20);
    assert.equal(node.searches(), 1, 'exactly one search, from the one request');
    assert.equal(counter(node.metrics, 'analysis_cache_faults_total{fault="read"}'), 1);
    assert.equal(counter(node.metrics, 'analysis_cache_faults_total{fault="write"}'), 1);
    assert.equal(
      counter(node.metrics, 'analysis_cache_events_total{event="cache_write_completed"}'),
      1,
      'the engine cannot see that the write failed — which is precisely why the fault counter exists',
    );
  } finally {
    await node.manager.shutdown({ deadlineMs: 2_000 });
  }
});

test('a storm of identical requests against a dead cache still runs one search', { skip }, async () => {
  const node = instance();
  const fen = freshFen();
  try {
    await node.tier.shutdown();

    const results = await Promise.all(Array.from({ length: 8 }, () => analyze(node, fen)));

    // Single-flight is process-local and unaffected by the cache being gone: eight callers that ask
    // for the same identity join one flight, so a cache outage cannot turn request volume into
    // engine volume.
    assert.equal(node.searches(), 1, 'eight callers, one search');
    assert.equal(counter(node.metrics, 'analysis_cache_events_total{event="request_coalesced"}'), 7);
    for (const result of results) assert.equal(result[0]?.depth, 10);
  } finally {
    await node.manager.shutdown({ deadlineMs: 2_000 });
  }
});

/**
 * What the durable cache does *not* provide, asserted so the claim in the docs is checked rather
 * than merely written down.
 *
 * Single-flight is a map inside one `AnalysisOrchestrator`. Two processes racing on the same cold
 * position therefore both compute it: nothing in PostgreSQL coordinates them, because nothing was
 * asked to. Both results are correct and the stronger survives the upsert; the cost is one duplicated
 * search on a cold miss, which is the price of not adding a distributed lock.
 */
test('two live instances racing a cold position both compute it', { skip }, async () => {
  const fen = freshFen();
  const a = instance();
  const b = instance();
  try {
    await Promise.all([analyze(a, fen), analyze(b, fen)]);

    assert.equal(a.searches() + b.searches(), 2, 'cross-process single-flight does not exist');

    // And the race resolves to one row that either of them can then read.
    const reader = instance();
    try {
      await analyze(reader, fen);
      assert.equal(reader.searches(), 0, 'the duplicated work still leaves one usable row');
    } finally {
      await reader.shutdown();
    }
  } finally {
    await a.shutdown();
    await b.shutdown();
  }
});

test('a cache pool that cannot connect degrades to computing, and says so', { skip }, async () => {
  // Port 1 is not a PostgreSQL server, so every statement fails at connection time — the shape of a
  // misconfigured or unreachable database, as opposed to one that was closed.
  const node = instance({ connectionString: 'postgres://nobody:nobody@127.0.0.1:1/none' });
  try {
    const results = await analyze(node, freshFen());

    assert.equal(results.length, 1, 'analysis is unaffected by a cache it cannot reach');
    assert.equal(node.searches(), 1);
    assert.ok(
      counter(node.metrics, 'analysis_cache_faults_total{fault="read"}') >= 1,
      'an unreachable cache must be reported, not merely missed',
    );
  } finally {
    await node.shutdown();
  }
});

test('the retention sweep runs against the composed cache without disturbing it', { skip }, async () => {
  const node = instance();
  const fen = freshFen();
  const pool = createPool({ max: 1 });
  try {
    await analyze(node, fen);
    assert.equal(node.searches(), 1);

    // Age the row past any plausible window, then sweep through the same adapter production uses.
    await pool.query(
      `UPDATE engine_analysis_cache SET updated_at = now() - interval '400 days' WHERE fen = $1`,
      [fen],
    );
    const cache = node.tier.cache as unknown as {
      deleteExpired(before: Date, limit: number): Promise<number>;
    };
    assert.equal(await cache.deleteExpired(new Date(Date.now() - 86_400_000), 100), 1);

    // The identity is gone, so the next request recomputes and stores it again — an expired entry
    // costs one search, and the cache heals itself.
    await analyze(node, fen);
    assert.equal(node.searches(), 2, 'an expired row must not still answer');
    await analyze(node, fen);
    assert.equal(node.searches(), 2, 'and the recomputed row must be cached again');
  } finally {
    await pool.query('DELETE FROM engine_analysis_cache WHERE fen = $1', [fen]).catch(() => {});
    await pool.end();
    await node.shutdown();
  }
});
