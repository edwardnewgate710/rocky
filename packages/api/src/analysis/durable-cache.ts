/**
 * @packageDocumentation
 * Assembly of the durable analysis cache (ADR-0138): the pool it runs on, the Phase A adapter, the
 * retention sweeper, and the observability both halves report to.
 *
 * This module exists so `analysis/composition.ts` stays driver-free — its tests build a whole engine
 * with no database — while still giving the subsystem a single owner for everything the durable tier
 * brings with it. Whatever is created here is torn down here, in `shutdown()`.
 */

import { createPool, PgAnalysisCache } from '@chess-platform/persistence/pg';
import type { Logger } from '../ports/logger';
import type { Metrics } from '../ports/metrics';
import { AnalysisCacheObservability } from './cache-observability';
import { AnalysisCacheRetention } from './cache-retention';
import type { AnalysisCacheComposition, AnalysisCacheSettings } from './composition';
import { HOT_CACHE_TTL_MS, HotAnalysisCache } from './hot-cache';

/**
 * Server-side bound on every cache statement, and on waiting for a connection to send one.
 *
 * Derived rather than picked: `DEFAULT_ANALYSIS_LIMITS.defaultTimeMs` is 1000ms, so a search this
 * cache exists to avoid costs about a second. A lookup is a single primary-key probe, so anything
 * approaching a quarter of that is already pathological — and waiting longer than that to *maybe*
 * skip a one-second search is a worse deal than simply running the search. Both bounds are the same
 * value because both are ways of waiting: `statement_timeout` is enforced by PostgreSQL once a
 * statement is in flight, and `connectionTimeoutMillis` bounds the queue in front of it. Setting
 * only the first leaves a saturated pool able to stall analysis indefinitely, which is the exact
 * hang ADR-0135 §7 asked for a timeout to prevent.
 */
const STATEMENT_TIMEOUT_MS = 250;
const CONNECTION_TIMEOUT_MS = 250;

/**
 * The cache runs on its own small pool, not the API's shared one.
 *
 * ADR-0135 §7 puts the bound "on the pool the composition root supplies", and a pool is the only
 * place it can go cheaply: `statement_timeout` from `PoolConfig` is a connection-level setting, so
 * putting it on the shared pool would bound every unrelated repository query too. The alternatives
 * are worse — `SET LOCAL` needs an explicit transaction, turning a one-round-trip lookup into
 * BEGIN/SELECT/COMMIT, and a plain `SET` leaks the setting to whichever borrower gets that client
 * next. Four connections is enough for a workload of one indexed probe per analysis request, and it
 * keeps a burst of cache work from consuming connections the rest of the API needs.
 */
const POOL_MAX = 4;

/**
 * Everything about the cache pool except where it connects, exported so it can be asserted.
 *
 * Stated as one object, and the only thing {@link createAnalysisCacheComposition} spreads into
 * `createPool`, because these three settings are the whole of the bound this phase exists to add and
 * a silently dropped one is invisible: the pool still works, the logs still say the tier was
 * composed, and analysis simply becomes able to stall again. A separate literal at the call site
 * could drift from whatever a test asserted; this cannot.
 */
export const ANALYSIS_CACHE_POOL_CONFIG = {
  max: POOL_MAX,
  statement_timeout: STATEMENT_TIMEOUT_MS,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
} as const;

/** Sweep hourly: often enough that expired rows do not pile up, rare enough to be invisible. */
const RETENTION_INTERVAL_MS = 3_600_000;
/** Rows per delete, so no single statement runs long enough to matter. */
const RETENTION_BATCH_SIZE = 500;
/** Batches per sweep — the ceiling on one tick's write load, here 10,000 rows an hour. */
const RETENTION_MAX_BATCHES_PER_SWEEP = 20;

export interface DurableAnalysisCacheOptions {
  readonly settings: AnalysisCacheSettings;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /**
   * Where the cache pool connects. Absent means no durable tier at all — see
   * {@link createAnalysisCacheComposition} on why that is a caller's decision rather than a
   * silent fallback.
   */
  readonly connectionString?: string | undefined;
}

/**
 * Build the analysis cache tier.
 *
 * **Durable caching is on exactly when the caller supplies a connection string and has not turned it
 * off.** There is deliberately no probe: `pg.Pool` connects lazily, and a boot-time `SELECT 1` would
 * only turn a database that happens to be slow at that instant into a failed deploy, for a component
 * whose entire failure story is "carry on without it". The database being down is already reported —
 * by the API's own readiness check, and by the fault counter once requests start missing.
 *
 * Nor is a missing connection string a hidden fallback. The only caller that composes this is
 * `createPgDependencies`, which has already built the main pool from the same value and therefore
 * cannot reach here without one unless a test injected its own pool. A deployment with a broken
 * `DATABASE_URL` fails at the main pool, loudly, before this is asked anything.
 */
export function createAnalysisCacheComposition(
  options: DurableAnalysisCacheOptions,
): AnalysisCacheComposition {
  const observability = new AnalysisCacheObservability({
    metrics: options.metrics,
    logger: options.logger,
  });

  if (!options.settings.durable || !options.connectionString) {
    options.logger.info('analysis cache: durable tier off, using the in-process cache', {
      reason: options.settings.durable ? 'no connection string' : 'disabled by configuration',
    });
    return { cache: undefined, observer: observability, shutdown: async () => {} };
  }

  const pool = createPool({
    connectionString: options.connectionString,
    ...ANALYSIS_CACHE_POOL_CONFIG,
  });
  const durable = new PgAnalysisCache(pool, {
    onError: (fault, error) => observability.reportFault(fault, error),
  });
  // The hot tier wraps the durable one and takes its place as the engine's cache, so every lookup
  // tries memory before PostgreSQL (ADR-0139). Retention keeps hold of `durable` rather than the
  // composite: `deleteExpired` is the adapter's own, off the request path, and belongs to the tier
  // that actually owns rows. Routing it through the front tier would be asking a cache with no
  // storage to sweep a table.
  const cache = new HotAnalysisCache({
    delegate: durable,
    maxEntries: options.settings.hotEntries,
    observer: observability,
  });
  const retention = new AnalysisCacheRetention({
    cache: durable,
    observability,
    ttlMs: options.settings.ttlMs,
    intervalMs: RETENTION_INTERVAL_MS,
    batchSize: RETENTION_BATCH_SIZE,
    maxBatchesPerSweep: RETENTION_MAX_BATCHES_PER_SWEEP,
  });
  retention.start();
  options.logger.info('analysis cache: durable tier composed', {
    ttlMs: options.settings.ttlMs,
    statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    hotEntries: options.settings.hotEntries,
    hotTtlMs: HOT_CACHE_TTL_MS,
  });

  return {
    cache,
    observer: observability,
    shutdown: async () => {
      // Order matters: stop sweeping and wait for the batch in flight, *then* release the pool. A
      // sweep still running when the pool drains would have its next statement rejected and would
      // report an orderly shutdown as a retention failure. The engine must already have drained by
      // the time this runs, or the last searches' writes would meet a closed pool — which is why
      // this hangs off the analysis shutdown handle rather than the process's pool teardown.
      await retention.stop();
      // Dropped first, and synchronously, so "the cache tier is released" is true of both halves at
      // the same instant. A hot entry outliving the pool would go on answering out of a tier whose
      // durable half is gone — harmless to correctness, and exactly the sort of thing that makes an
      // outage hard to read. The tier owns no timer and no handle, so this is the whole of it.
      cache.clear();
      await pool.end();
    },
  };
}
