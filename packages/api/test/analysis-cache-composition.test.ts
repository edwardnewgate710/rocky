/**
 * The durable analysis cache tier as the composition root assembles it (ADR-0138): its settings,
 * its observability, and its retention sweeper.
 *
 * Nothing here touches a database. The Postgres behaviour these pieces depend on is proven in
 * `packages/persistence/test/analysis-cache-retention.integration.test.ts` against a real server;
 * what is left — which tier gets built, what is counted, what is logged, and how the sweep loop
 * bounds itself — is decided entirely in this package and is worth testing without one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { analysisCacheSettingsFromEnv } from '../src/analysis/composition';
import {
  ANALYSIS_CACHE_POOL_CONFIG,
  createAnalysisCacheComposition,
} from '../src/analysis/durable-cache';
import {
  AnalysisCacheObservability,
  RETENTION_FAILURE_ESCALATION,
} from '../src/analysis/cache-observability';
import { AnalysisCacheRetention } from '../src/analysis/cache-retention';
import { JsonLogger } from '../src/ports/logger';
import { InMemoryMetrics } from '../src/ports/metrics';

const DAY_MS = 86_400_000;
// Two levels: at runtime this file lives in dist-test/test, so the package root is its grandparent.
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

interface Captured {
  readonly level: string;
  readonly msg: string;
  readonly [field: string]: unknown;
}

/** A logger that keeps every record, so level and fields can both be asserted. */
function capturingLogger(): { logger: JsonLogger; records: Captured[] } {
  const records: Captured[] = [];
  const logger = new JsonLogger(
    {},
    { level: 'debug', sink: (line) => records.push(JSON.parse(line) as Captured) },
  );
  return { logger, records };
}

function observability(): {
  telemetry: AnalysisCacheObservability;
  metrics: InMemoryMetrics;
  records: Captured[];
} {
  const metrics = new InMemoryMetrics();
  const { logger, records } = capturingLogger();
  return { telemetry: new AnalysisCacheObservability({ metrics, logger }), metrics, records };
}

/**
 * The durable cache actually reaches the engine.
 *
 * This is a source assertion because no behavioural one is available: `EngineManager` does not expose
 * the cache it was given, and reaching it through `createAnalysisFromEnv` would need a real engine
 * binary to spawn before the cache is ever consulted. Deleting the two spreads below would leave the
 * tier composed, its pool open, its sweeper running and its "durable tier composed" line in the log —
 * while the engine quietly went on using the in-process LRU. Every other test in this change would
 * still pass. The repository already guards this class of composition-root bug the same way, in
 * `ai-composition.test.ts`.
 */
test('createAnalysisFromEnv hands the tier\u2019s cache and observer to the engine', () => {
  const file = resolve(PACKAGE_ROOT, 'src/analysis/composition.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);

  let body: string | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'createAnalysisFromEnv') {
      body = node.body?.getText(source);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  assert.ok(body !== undefined, 'createAnalysisFromEnv must exist to be asserted about');
  const engineCall = /createAnalysisEngine\(env,\s*\{([\s\S]*?)\}\);/.exec(body);
  assert.ok(engineCall, 'the engine must still be built from within createAnalysisFromEnv');
  assert.match(
    engineCall[1] ?? '',
    /cache:\s*tier\.cache/,
    'the durable cache must be passed to the engine, or production silently keeps the LRU',
  );
  assert.match(
    engineCall[1] ?? '',
    /observer:\s*tier\.observer/,
    'the engine observer must be passed too, or cache telemetry is never emitted',
  );
});

/**
 * Both halves of the bound are actually on the pool.
 *
 * Neither is visible in behaviour until something goes wrong, which is exactly why they need an
 * assertion: dropping either leaves a pool that works, logs that say the tier was composed, and an
 * analysis path that can stall again — the failure ADR-0135 §7 named as a precondition. The values
 * are asserted as literals rather than against the constants they came from, so an edit to a
 * constant has to be a deliberate edit to this expectation too.
 */
test('the cache pool carries both timeouts and its connection bound', () => {
  assert.deepEqual(
    { ...ANALYSIS_CACHE_POOL_CONFIG },
    { max: 4, statement_timeout: 250, connectionTimeoutMillis: 250 },
  );
});

/**
 * `statement_timeout` bounds a statement already in flight. `connectionTimeoutMillis` bounds the
 * queue in front of it, which `node-postgres` leaves unbounded by default — so without it a
 * saturated pool stalls analysis for as long as it stays saturated, and the server-side timeout
 * never gets a chance to fire because the statement was never sent.
 */
test('the connection bound is set, because the statement bound cannot cover waiting for a connection', () => {
  assert.equal(
    ANALYSIS_CACHE_POOL_CONFIG.connectionTimeoutMillis,
    ANALYSIS_CACHE_POOL_CONFIG.statement_timeout,
    'both are ways of waiting, so both are bounded the same',
  );
});

test('analysisCacheSettingsFromEnv: durable by default, with a thirty-day window', () => {
  const settings = analysisCacheSettingsFromEnv({});
  assert.equal(settings.durable, true);
  assert.equal(settings.ttlMs, 30 * DAY_MS);
});

test('analysisCacheSettingsFromEnv: only the documented off switch turns the durable tier off', () => {
  assert.equal(analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_DURABLE: '0' }).durable, false);
  // Anything else is on, matching `SEARCH_ENABLED`. A deployment that means to disable the cache
  // must say so the same way it disables search; a typo must not silently drop durability.
  for (const value of ['1', 'true', 'false', 'no', '', 'off']) {
    assert.equal(
      analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_DURABLE: value }).durable,
      true,
      `${JSON.stringify(value)} must not disable the durable tier`,
    );
  }
});

test('analysisCacheSettingsFromEnv: the retention window is parsed, clamped, and never widened by junk', () => {
  assert.equal(analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_TTL_DAYS: '7' }).ttlMs, 7 * DAY_MS);
  // Clamped, not trusted: an unbounded window would make retention a no-op by configuration, which
  // is the one thing wiring this cache was required to rule out.
  assert.equal(
    analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_TTL_DAYS: '100000' }).ttlMs,
    365 * DAY_MS,
  );
  for (const bad of ['abc', '0', '-5', '', '2.5', '  ']) {
    assert.equal(
      analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_TTL_DAYS: bad }).ttlMs,
      30 * DAY_MS,
      `${JSON.stringify(bad)} must fall back to the default window`,
    );
  }
});

test('the tier keeps the in-process cache when there is no connection string', async () => {
  const metrics = new InMemoryMetrics();
  const { logger, records } = capturingLogger();

  const tier = createAnalysisCacheComposition({
    settings: analysisCacheSettingsFromEnv({}),
    logger,
    metrics,
  });

  // `undefined` rather than a cache that stores nothing: the caller's own LRU stays in place, so a
  // deployment without a database is not silently downgraded to no caching at all.
  assert.equal(tier.cache, undefined);
  assert.ok(tier.observer, 'engine cache telemetry is worth having whichever tier is behind it');
  await tier.shutdown();
  assert.ok(
    records.some((r) => r.msg.includes('durable tier off') && r.reason === 'no connection string'),
    'the reason must be stated, not left to be inferred from a missing metric',
  );
});

test('the tier can be switched off with a connection string present, and says so', async () => {
  const { logger, records } = capturingLogger();

  const tier = createAnalysisCacheComposition({
    settings: analysisCacheSettingsFromEnv({ ANALYSIS_CACHE_DURABLE: '0' }),
    logger,
    metrics: new InMemoryMetrics(),
    connectionString: 'postgres://unused:unused@127.0.0.1:1/none',
  });

  assert.equal(tier.cache, undefined, 'the switch must win over an available database');
  await tier.shutdown();
  assert.ok(
    records.some((r) => r.reason === 'disabled by configuration'),
    'a deliberately disabled cache must not read as a missing one',
  );
});

test('engine events are counted under a bounded label, with a latency series for lookups', () => {
  const { telemetry, metrics } = observability();

  telemetry.record({ type: 'cache_hit', durationMs: 4 });
  telemetry.record({ type: 'cache_hit', durationMs: 6 });
  telemetry.record({ type: 'cache_miss', durationMs: 3 });
  telemetry.record({ type: 'request_coalesced' });
  telemetry.record({ type: 'cancellation', scope: 'consumer' });

  const rendered = metrics.render();
  assert.match(rendered, /analysis_cache_events_total\{event="cache_hit"\} 2/);
  assert.match(rendered, /analysis_cache_events_total\{event="cache_miss"\} 1/);
  assert.match(rendered, /analysis_cache_events_total\{event="request_coalesced"\} 1/);
  assert.match(rendered, /analysis_cache_events_total\{event="cancellation"\} 1/);
  assert.match(rendered, /analysis_cache_lookup_seconds[_a-z]*\{[^}]*outcome="hit"/);
  // An event with no duration must not invent one.
  assert.equal(/outcome="coalesced"/.test(rendered), false);
});

test('an absorbed fault is counted and logged at a level that matches what it means', () => {
  const { telemetry, metrics, records } = observability();

  telemetry.reportFault('read', Object.assign(new Error('canceling statement'), { code: '57014' }));
  telemetry.reportFault('write', new Error('connection terminated'));
  telemetry.reportFault('payload', new Error('unusable cached analysis payload: bad depth'));

  const rendered = metrics.render();
  assert.match(rendered, /analysis_cache_faults_total\{fault="read"\} 1/);
  assert.match(rendered, /analysis_cache_faults_total\{fault="write"\} 1/);
  assert.match(rendered, /analysis_cache_faults_total\{fault="payload"\} 1/);

  const levels = records.map((r) => `${String(r.level)}:${String(r.fault)}`);
  // A degraded cache is a warning; a row that cannot be believed is an error, because corruption
  // and a payload version this build cannot read do not resolve on their own.
  assert.deepEqual(levels, ['warn:read', 'warn:write', 'error:payload']);
  assert.equal(records[0]?.code, '57014', 'the SQLSTATE is the field worth alerting on');
  assert.equal(records[1]?.code, 'none', 'an error without one must not invent a code');
});

test('a logged fault carries nothing unbounded and nothing identifying', () => {
  const { telemetry, metrics, records } = observability();
  const shouted = new Error(`x${'y'.repeat(5_000)}\nSELECT 1;\rmore`);

  telemetry.reportFault('read', shouted);

  const detail = String(records[0]?.detail);
  assert.ok(detail.length <= 200, 'one malformed error must not write an unbounded log line');
  assert.equal(/[\r\n]/.test(detail), false, 'newlines are flattened so a record stays one line');
  // The signals simply have no field for these, which is the real guarantee — this asserts the
  // guarantee survived: nothing that identifies a position, a game or a person can appear.
  const rendered = metrics.render();
  for (const forbidden of ['fen', 'rnbqkbnr', 'userId', 'gameId', 'requestId', 'key']) {
    assert.equal(
      rendered.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `metrics must not carry ${forbidden}`,
    );
  }
});

test('repeated retention failure escalates from warn to error', () => {
  const { telemetry, records } = observability();

  for (let attempt = 1; attempt <= RETENTION_FAILURE_ESCALATION; attempt++) {
    telemetry.reportRetentionFailure(new Error('nope'), attempt);
  }

  const levels = records.map((r) => String(r.level));
  assert.deepEqual(levels.slice(0, -1), Array(RETENTION_FAILURE_ESCALATION - 1).fill('warn'));
  assert.equal(
    levels.at(-1),
    'error',
    'a sweeper failing every tick means the table is growing and nothing else would say so',
  );
});

/** A sweeper double that reports how it was called and can be made to fail. */
function fakeStore(pages: number[], failAfter = Number.POSITIVE_INFINITY) {
  const calls: Array<{ before: Date; limit: number }> = [];
  let index = 0;
  return {
    calls,
    async deleteExpired(before: Date, limit: number): Promise<number> {
      calls.push({ before, limit });
      if (calls.length > failAfter) throw new Error('sweep failed');
      return pages[index++] ?? 0;
    },
  };
}

function retention(
  store: { deleteExpired(before: Date, limit: number): Promise<number> },
  telemetry: AnalysisCacheObservability,
  overrides: { batchSize?: number; maxBatchesPerSweep?: number } = {},
): AnalysisCacheRetention {
  return new AnalysisCacheRetention({
    cache: store,
    observability: telemetry,
    ttlMs: 30 * DAY_MS,
    intervalMs: 3_600_000,
    batchSize: overrides.batchSize ?? 500,
    maxBatchesPerSweep: overrides.maxBatchesPerSweep ?? 20,
  });
}

test('a sweep keeps deleting until a short batch says the expired rows are gone', async () => {
  const { telemetry, metrics } = observability();
  const store = fakeStore([500, 500, 120]);

  const deleted = await retention(store, telemetry).sweep();

  assert.equal(deleted, 1_120);
  assert.equal(store.calls.length, 3, 'a short batch ends the sweep rather than one more probe');
  assert.ok(store.calls.every((c) => c.limit === 500), 'every statement carries the batch bound');
  assert.match(metrics.render(), /analysis_cache_retention_deleted_total 1120/);
});

test('a sweep stops at its per-tick ceiling however much is expired', async () => {
  const { telemetry } = observability();
  const store = fakeStore(Array(50).fill(10));

  const deleted = await retention(store, telemetry, { batchSize: 10, maxBatchesPerSweep: 4 }).sweep();

  // A long-unswept table is drained over several ticks instead of one burst of write load.
  assert.equal(store.calls.length, 4);
  assert.equal(deleted, 40);
});

test('the cutoff is the retention window behind now, and the same for every batch of a sweep', async () => {
  const { telemetry } = observability();
  const store = fakeStore([500, 10]);
  const before = Date.now();

  await retention(store, telemetry).sweep();

  const cutoffs = store.calls.map((c) => c.before.getTime());
  assert.equal(new Set(cutoffs).size, 1, 'a sweep must not drift its own cutoff between batches');
  assert.ok(
    cutoffs[0]! >= before - 30 * DAY_MS - 5_000 && cutoffs[0]! <= Date.now() - 30 * DAY_MS + 5_000,
    'the cutoff is ttlMs behind the start of the sweep',
  );
});

test('a failed sweep is reported, keeps what earlier batches deleted, and never rejects', async () => {
  const { telemetry, metrics, records } = observability();
  // Fails on the second call, so one full batch is already committed when the sweep gives up.
  const store = fakeStore([500, 500], 1);

  const sweeper = retention(store, telemetry);
  assert.equal(await sweeper.sweep(), 500, 'the first batch is committed and still counts');
  assert.match(metrics.render(), /analysis_cache_faults_total\{fault="retention"\} 1/);
  assert.equal(records.at(-1)?.consecutiveFailures, 1);

  // The count is consecutive: a success in between must reset it, or a healthy sweeper would
  // eventually escalate on unrelated blips.
  const recovering = retention(fakeStore([0]), telemetry);
  await recovering.sweep();
  assert.equal(await sweeper.sweep(), 0);
  assert.equal(records.at(-1)?.consecutiveFailures, 2, 'each sweeper counts its own run of failures');
});

test('a sweep already in flight is not started a second time', async () => {
  const { telemetry } = observability();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = {
    calls: 0,
    async deleteExpired(): Promise<number> {
      this.calls += 1;
      await gate;
      return 0;
    },
  };
  const sweeper = retention(store, telemetry);

  const first = sweeper.sweep();
  // A sweep slower than the interval must not have a second one stacked on top of it.
  assert.equal(await sweeper.sweep(), 0, 'the overlapping call returns without touching the store');
  release();
  await first;
  assert.equal(store.calls, 1);

  // And the guard clears, so the next tick sweeps normally.
  await sweeper.sweep();
  assert.equal(store.calls, 2);
});

test('the sweeper schedules nothing until started, and nothing after being stopped', async () => {
  const { telemetry } = observability();
  const store = fakeStore([0]);
  const sweeper = new AnalysisCacheRetention({
    cache: store,
    observability: telemetry,
    ttlMs: DAY_MS,
    intervalMs: 5,
    batchSize: 10,
    maxBatchesPerSweep: 2,
  });

  // `start()` deliberately does not sweep immediately: every replica calls it during boot, and a
  // boot-time sweep would concentrate the fleet's delete load on a rolling deploy.
  assert.equal(store.calls.length, 0);

  sweeper.start();
  sweeper.start(); // idempotent: a second call must not leave a timer nothing can clear
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(store.calls.length > 0, 'the interval must actually fire');

  await sweeper.stop();
  await sweeper.stop();
  const afterStop = store.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(store.calls.length, afterStop, 'a stopped sweeper leaves no timer behind');
});

/**
 * The shutdown ordering that keeps an orderly stop out of the fault counter.
 *
 * The owner's next act after stopping the sweeper is to close the pool. If `stop()` returned while a
 * sweep was still running, that sweep's next batch would be rejected by the draining pool and
 * reported as a retention failure — an operator would see an error and a fault every time the
 * service shut down.
 */
test('stopping the sweeper waits for the batch already in flight', async () => {
  const { telemetry, records } = observability();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = false;
  const store = {
    async deleteExpired(): Promise<number> {
      await gate;
      finished = true;
      return 0;
    },
  };
  const sweeper = retention(store, telemetry);

  const sweep = sweeper.sweep();
  const stopped = sweeper.stop();
  let stopResolved = false;
  void stopped.then(() => {
    stopResolved = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(stopResolved, false, 'stop must not resolve while a batch is still running');

  release();
  await sweep;
  await stopped;
  assert.equal(finished, true);
  assert.equal(
    records.some((r) => String(r.level) === 'warn' || String(r.level) === 'error'),
    false,
    'an orderly stop is not a retention failure',
  );
});

test('a sweep in progress abandons its remaining batches once stopped', async () => {
  const { telemetry } = observability();
  const store = fakeStore(Array(50).fill(10));
  const sweeper = retention(store, telemetry, { batchSize: 10, maxBatchesPerSweep: 40 });

  // Stop between batches: the loop checks before each one, so a shutdown waits out at most the batch
  // already issued rather than the nineteen that were still budgeted.
  const sweep = sweeper.sweep();
  await sweeper.stop();
  await sweep;

  assert.ok(store.calls.length < 40, `a stopped sweep must not run its full budget (ran ${store.calls.length})`);
});

/**
 * A fixed batch size is a trap. If 500 rows ever stop fitting inside the pool's statement timeout,
 * every subsequent tick retries the same 500 rows, every one of them times out, and the table is
 * never trimmed again — a permanent stall that only shows up as a growing disk. Backing off turns
 * that into a slower sweep that still makes progress.
 */
test('the batch size backs off after a failure and is restored by a clean sweep', async () => {
  const { telemetry } = observability();
  let failNext = true;
  const asked: number[] = [];
  const store = {
    async deleteExpired(_before: Date, limit: number): Promise<number> {
      asked.push(limit);
      if (failNext) throw new Error('statement timeout');
      return 0;
    },
  };
  const sweeper = retention(store, telemetry, { batchSize: 400, maxBatchesPerSweep: 4 });

  await sweeper.sweep();
  await sweeper.sweep();
  await sweeper.sweep();
  assert.deepEqual(asked, [400, 200, 100], 'each failure halves the batch');

  failNext = false;
  await sweeper.sweep();
  await sweeper.sweep();
  assert.equal(asked[3], 50, 'the recovering sweep still uses the reduced size');
  assert.equal(asked[4], 400, 'and a clean sweep restores the configured one');
});

test('the batch size never backs off to nothing', async () => {
  const { telemetry } = observability();
  const asked: number[] = [];
  const store = {
    async deleteExpired(_before: Date, limit: number): Promise<number> {
      asked.push(limit);
      throw new Error('always fails');
    },
  };
  const sweeper = retention(store, telemetry, { batchSize: 400 });

  for (let i = 0; i < 12; i++) await sweeper.sweep();

  assert.ok(asked.every((n) => n >= 25), 'a floor keeps the sweep able to make progress');
  assert.equal(asked.at(-1), 25);
});

test('the sweeper refuses options that would remove its bounds', () => {
  const { telemetry } = observability();
  const base = {
    cache: fakeStore([0]),
    observability: telemetry,
    ttlMs: DAY_MS,
    intervalMs: 1_000,
    batchSize: 10,
    maxBatchesPerSweep: 1,
  };
  for (const field of ['ttlMs', 'intervalMs', 'batchSize', 'maxBatchesPerSweep'] as const) {
    assert.throws(
      () => new AnalysisCacheRetention({ ...base, [field]: 0 }),
      RangeError,
      `${field} of 0 must be refused rather than silently disabling a bound`,
    );
  }
});
