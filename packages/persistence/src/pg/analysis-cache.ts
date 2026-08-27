/**
 * @packageDocumentation
 * Postgres-backed {@link AnalysisCache} (ADR-0135). Implements the port `@chess-platform/engine`
 * defines; the engine never learns that a database exists.
 */

import type { Pool } from 'pg';
import type { AnalysisCache, AnalysisKey, CacheMeta } from '@chess-platform/engine';
import type { AnalysisLimits, EngineResult } from '@chess-platform/engine';
import {
  ANALYSIS_CACHE_PAYLOAD_VERSION,
  decodeAnalysisPayload,
  encodeAnalysisPayload,
  toStoredLimits,
} from '../analysis-cache';

/**
 * What kind of fault was absorbed.
 *
 * `read`/`write` are the database being unreachable or refusing a statement. `payload` is a row
 * that was found but could not be believed — corruption or a payload version this build does not
 * speak — which is a different alert with a different cause, so it is not folded into `read`.
 */
export type AnalysisCacheFault = 'read' | 'write' | 'payload';

export interface PgAnalysisCacheOptions {
  /**
   * Called for every absorbed fault. Optional because this package has no logging dependency and
   * choosing one is the composition root's job; supplying it is how a deployment stops a silently
   * dead cache from looking like a merely cold one.
   */
  readonly onError?: (fault: AnalysisCacheFault, error: unknown) => void;
}

/**
 * A stored search may answer a request only if it reached at least the request's bound in every
 * dimension the request states. A dimension the row left NULL reached no stated bound, so it
 * satisfies only a request that asks nothing of it — `IS NOT NULL` is what makes that fail closed
 * rather than letting an absent measurement read as an adequate one.
 *
 * This is `limitsSatisfy(stored, requested)` from the engine port, expressed where the rows are.
 */
const SATISFIES_REQUEST = `
       AND ($5::int    IS NULL OR (achieved_depth   IS NOT NULL AND achieved_depth   >= $5::int))
       AND ($6::bigint IS NULL OR (achieved_nodes   IS NOT NULL AND achieved_nodes   >= $6::bigint))
       AND ($7::bigint IS NULL OR (achieved_time_ms IS NOT NULL AND achieved_time_ms >= $7::bigint))`;

const SELECT_SQL = `
  SELECT payload_version, results
    FROM engine_analysis_cache
   WHERE fingerprint = $1 AND variant = $2 AND multi_pv = $3 AND fen = $4${SATISFIES_REQUEST}`;

/**
 * An entry may only be replaced by one that could serve every request the entry could serve.
 *
 * That is the same predicate as the read path with the arguments swapped — `limitsSatisfy(incoming,
 * stored)` — and it is what stops a depth-10 search that finishes second from evicting the depth-20
 * result already there. Evaluated inside `ON CONFLICT DO UPDATE`, so the comparison happens under
 * the row lock: two concurrent writers cannot both read "stronger" and then both overwrite.
 *
 * A newer payload version always wins, and an older one never overwrites a newer: during a rolling
 * deploy the build that can still read a row must not lose it to one that cannot.
 *
 * Writes that dominate each other in neither direction (deeper but fewer nodes) leave the incumbent
 * in place. The outcome then depends on which arrived first, which no cache can control, but every
 * outcome is a search that truthfully achieved what its row claims, and the loser costs a
 * recomputation rather than a wrong answer.
 */
const UPSERT_SQL = `
  INSERT INTO engine_analysis_cache (
    fingerprint, variant, multi_pv, fen,
    achieved_depth, achieved_nodes, achieved_time_ms,
    payload_version, results, created_at, updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10)
  ON CONFLICT (fingerprint, variant, multi_pv, fen) DO UPDATE
     SET achieved_depth   = EXCLUDED.achieved_depth,
         achieved_nodes   = EXCLUDED.achieved_nodes,
         achieved_time_ms = EXCLUDED.achieved_time_ms,
         payload_version  = EXCLUDED.payload_version,
         results          = EXCLUDED.results,
         updated_at       = EXCLUDED.updated_at
   WHERE engine_analysis_cache.payload_version < EXCLUDED.payload_version
      OR (engine_analysis_cache.payload_version = EXCLUDED.payload_version
          AND (engine_analysis_cache.achieved_depth IS NULL
               OR (EXCLUDED.achieved_depth IS NOT NULL
                   AND EXCLUDED.achieved_depth >= engine_analysis_cache.achieved_depth))
          AND (engine_analysis_cache.achieved_nodes IS NULL
               OR (EXCLUDED.achieved_nodes IS NOT NULL
                   AND EXCLUDED.achieved_nodes >= engine_analysis_cache.achieved_nodes))
          AND (engine_analysis_cache.achieved_time_ms IS NULL
               OR (EXCLUDED.achieved_time_ms IS NOT NULL
                   AND EXCLUDED.achieved_time_ms >= engine_analysis_cache.achieved_time_ms)))`;

interface CachedRow {
  payload_version: number;
  results: unknown;
}

/**
 * Durable analysis cache over the `engine_analysis_cache` table.
 *
 * **Failure semantics: fail open, never silently.** A cache is an optimization, and
 * `EngineManager.analyze` calls `get`/`set` unguarded — so a throw here would turn a database
 * blip into a failed analysis, which is strictly worse than the recomputation a miss costs.
 * Every fault is therefore absorbed and reported through {@link PgAnalysisCacheOptions.onError}.
 * The one thing never absorbed is a wrong answer: a row that cannot be decoded is a miss, not a
 * guess.
 */
export class PgAnalysisCache implements AnalysisCache {
  private readonly onError: (fault: AnalysisCacheFault, error: unknown) => void;

  constructor(
    private readonly pool: Pool,
    options: PgAnalysisCacheOptions = {},
  ) {
    const report = options.onError;
    // A reporter that throws would defeat the point of absorbing the fault in the first place.
    this.onError = report
      ? (fault, error) => {
          try {
            report(fault, error);
          } catch {
            /* the fault is already the degraded path; reporting it must not add a second one */
          }
        }
      : () => {};
  }

  async get(key: AnalysisKey, requested: AnalysisLimits): Promise<readonly EngineResult[] | undefined> {
    let row: CachedRow | undefined;
    try {
      const result = await this.pool.query<CachedRow>(SELECT_SQL, [
        key.fingerprint,
        key.variant,
        key.multiPv,
        key.fen,
        requested.depth ?? null,
        requested.nodes ?? null,
        requested.timeMs ?? null,
      ]);
      row = result.rows[0];
    } catch (error) {
      this.onError('read', error);
      return undefined;
    }
    if (!row) return undefined;

    try {
      return decodeAnalysisPayload(row.payload_version, row.results);
    } catch (error) {
      this.onError('payload', error);
      return undefined;
    }
  }

  async set(key: AnalysisKey, value: readonly EngineResult[], meta: CacheMeta): Promise<void> {
    try {
      const limits = toStoredLimits(meta.limits);
      await this.pool.query(UPSERT_SQL, [
        key.fingerprint,
        key.variant,
        key.multiPv,
        key.fen,
        limits.depth,
        limits.nodes,
        limits.timeMs,
        ANALYSIS_CACHE_PAYLOAD_VERSION,
        JSON.stringify(encodeAnalysisPayload(value)),
        new Date(),
      ]);
    } catch (error) {
      this.onError('write', error);
    }
  }
}
