/**
 * The production composition root actually builds the durable cache tier (ADR-0138).
 *
 * The sibling of `bootstrap-analysis.test.ts`, and for the same reason. That file exists because
 * every unit test passed while `createPgDependencies` never called `createAnalysisFromEnv`, so
 * `POST /v1/analysis` answered "analysis is not configured" forever and nothing failed. The durable
 * cache has exactly that failure mode available to it: the adapter, the retention sweep and the
 * telemetry could all be perfect and fully tested while the composition root quietly went on handing
 * the engine an in-process LRU — a deployment where every replica starts cold, no analysis outlives a
 * deploy, and the only symptom is a bill.
 *
 * Nothing here connects. `pg.Pool` is lazy, so the assertion is on what the composition root *built*,
 * observed through the logger it was given.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createPgDependencies } from '../src/bootstrap';
import { JsonLogger } from '../src/ports/logger';

interface Record_ {
  readonly msg: string;
  readonly [field: string]: unknown;
}

/** `createPgDependencies` needs a token secret; it never connects the pool in these tests. */
function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const saved = new Map<string, string | undefined>();
  const applied = {
    ACCESS_TOKEN_SECRET: 'test-secret-at-least-32-chars-long-12345',
    NODE_ENV: 'test',
    EMAIL_PROVIDER: 'console',
    ...overrides,
  };
  for (const [key, value] of Object.entries(applied)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Boot the real composition root and hand back what it logged, having shut the analysis subsystem
 * down again — which is also how this file proves the shutdown handle releases the cache pool and
 * the sweeper rather than leaking a timer into the rest of the suite.
 *
 * A `connectionString` is passed explicitly wherever the durable tier is expected. These tests inject
 * their own `pool` so nothing connects, and an injected pool is the caller taking over connection
 * management — so the cache does not reach past it to `DATABASE_URL`. Production injects no pool and
 * resolves the same string from the environment.
 */
async function boot(
  overrides: Record<string, string | undefined>,
  connectionString?: string,
): Promise<Record_[]> {
  const records: Record_[] = [];
  const logger = new JsonLogger(
    {},
    { level: 'debug', sink: (line) => records.push(JSON.parse(line) as Record_) },
  );
  const pool = new Pool();
  const { shutdownAnalysis } = withEnv(overrides, () =>
    createPgDependencies({
      pool,
      logger,
      ...(connectionString !== undefined ? { connectionString } : {}),
    }),
  );
  await shutdownAnalysis();
  await pool.end();
  return records;
}

const UNUSED_DSN = 'postgres://unused:unused@127.0.0.1:1/none';

const cacheLines = (records: Record_[]): Record_[] =>
  records.filter((r) => r.msg.startsWith('analysis cache:'));

test('createPgDependencies: composes the durable cache when an engine and a database are configured', async () => {
  const records = await boot({ STOCKFISH_PATH: '/usr/local/bin/stockfish' }, UNUSED_DSN);

  const composed = cacheLines(records);
  assert.equal(composed.length, 1, 'exactly one cache tier is built, not one per request');
  assert.match(
    String(composed[0]?.msg),
    /durable tier composed/,
    'the engine must be handed the durable cache, not the in-process LRU',
  );
  // The retention window reaches the tier from configuration rather than being left at a default
  // the sweeper invented for itself.
  assert.equal(composed[0]?.ttlMs, 30 * 86_400_000);
  assert.equal(composed[0]?.statementTimeoutMs, 250, 'the bound ADR-0135 §7 required is applied');
});

test('createPgDependencies: honours the durable cache off switch', async () => {
  const records = await boot(
    { STOCKFISH_PATH: '/usr/local/bin/stockfish', ANALYSIS_CACHE_DURABLE: '0' },
    UNUSED_DSN,
  );

  assert.match(String(cacheLines(records)[0]?.msg), /durable tier off/);
  assert.equal(cacheLines(records)[0]?.reason, 'disabled by configuration');
});

test('createPgDependencies: the retention window is configurable at the composition root', async () => {
  const records = await boot(
    { STOCKFISH_PATH: '/usr/local/bin/stockfish', ANALYSIS_CACHE_TTL_DAYS: '7' },
    UNUSED_DSN,
  );

  assert.equal(cacheLines(records)[0]?.ttlMs, 7 * 86_400_000);
});

/**
 * No engine, no cache. The tier is passed to `createAnalysisFromEnv` as a factory precisely so a
 * deployment with no engine binary opens no second connection pool and starts no sweeper for a table
 * nothing in the process would ever read.
 */
test('createPgDependencies: builds no cache tier at all when no engine is configured', async () => {
  const records = await boot(
    { STOCKFISH_PATH: undefined, FAIRY_STOCKFISH_PATH: undefined },
    UNUSED_DSN,
  );

  assert.deepEqual(cacheLines(records), [], 'a pool built here would never be used or closed');
});

/**
 * The one case that is not production: a caller supplying its own pool without a connection string.
 * The main pool would already have thrown on a real deployment, so this is reachable only from a
 * test — and it is reported rather than assumed.
 */
test('createPgDependencies: says why the durable tier is absent instead of leaving it unexplained', async () => {
  const records = await boot({ STOCKFISH_PATH: '/usr/local/bin/stockfish', DATABASE_URL: undefined });

  assert.match(String(cacheLines(records)[0]?.msg), /durable tier off/);
  assert.equal(cacheLines(records)[0]?.reason, 'no connection string');
});

/**
 * An injected pool is the caller taking over connection management, and the cache respects that
 * rather than reaching past it to the environment.
 *
 * Without this rule the durable tier would open a second, real pool underneath any caller that
 * supplied its own — which in a test suite means silently connecting to whatever database happens to
 * be configured, on a code path the caller went out of its way to keep off the network.
 */
test('createPgDependencies: an injected pool is not overridden by DATABASE_URL', async () => {
  const records = await boot({
    STOCKFISH_PATH: '/usr/local/bin/stockfish',
    DATABASE_URL: UNUSED_DSN,
  });

  assert.equal(cacheLines(records)[0]?.reason, 'no connection string');
});
