/**
 * @packageDocumentation
 * The driver-free half of the durable engine analysis cache (ADR-0135): the payload
 * serialization contract, its validating reader, and the limit bookkeeping the Postgres
 * adapter stores in comparable columns.
 *
 * This module holds no SQL and no `pg` import so the encoding rules can be tested without a
 * database, and so a consumer that only needs the contract does not pull in the driver.
 */

import type { AnalysisLimits, EngineResult } from '@chess-platform/engine';
import { PersistenceError } from './errors';

/**
 * Version of the `results` JSON contract, stored alongside every row.
 *
 * A cached analysis outlives the process that wrote it, so a reader can meet a payload written
 * by a build that serialized something else. Versioning is what lets it answer "I do not
 * understand this" instead of casting unverified JSON into an {@link EngineResult}.
 */
export const ANALYSIS_CACHE_PAYLOAD_VERSION = 1;

/**
 * A stored payload could not be turned back into results.
 *
 * Raised by {@link decodeAnalysisPayload} and, in the adapter, converted into a cache miss: a
 * corrupt row must cost a recomputation, never a wrong answer.
 */
export class AnalysisCachePayloadError extends PersistenceError {
  constructor(message: string) {
    super(`unusable cached analysis payload: ${message}`);
    this.name = 'AnalysisCachePayloadError';
  }
}

/** The achieved limits of a stored search, in the shape the cache table stores them. */
export interface StoredAnalysisLimits {
  readonly depth: number | null;
  readonly nodes: number | null;
  readonly timeMs: number | null;
}

/**
 * Project {@link AnalysisLimits} onto the three comparable columns.
 *
 * `undefined` (dimension not stated) becomes `NULL`, which the read predicate treats as
 * "reached no bound here" — satisfying only a request that asks nothing of that dimension.
 * A limit that is not a non-negative safe integer is refused rather than rounded or clamped:
 * every producer of these values parses them as integers, so anything else is a defect, and
 * storing it would make the row's claim about what the search reached untrue.
 */
export function toStoredLimits(limits: AnalysisLimits): StoredAnalysisLimits {
  const stored = {
    depth: dimension(limits.depth, 'depth'),
    nodes: dimension(limits.nodes, 'nodes'),
    timeMs: dimension(limits.timeMs, 'timeMs'),
  };
  if (stored.depth === null && stored.nodes === null && stored.timeMs === null) {
    throw new AnalysisCachePayloadError('limits state no dimension, so no request could match them');
  }
  return stored;
}

/**
 * `depth` is stored in an `INTEGER` column and the other two in `BIGINT`, so the ceilings differ.
 * Bounding them here rather than letting Postgres refuse the row keeps the reason legible: a limit
 * this large is a defect in the caller, not a database problem to read out of a SQLSTATE.
 */
const COLUMN_CEILING: Readonly<Record<string, number>> = {
  depth: 2_147_483_647,
  nodes: Number.MAX_SAFE_INTEGER,
  timeMs: Number.MAX_SAFE_INTEGER,
};

function dimension(value: number | undefined, name: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AnalysisCachePayloadError(`${name} limit is not a non-negative integer`);
  }
  if (value > (COLUMN_CEILING[name] as number)) {
    throw new AnalysisCachePayloadError(`${name} limit exceeds what its column can hold`);
  }
  return value;
}

/**
 * Serialize results for storage, field by field.
 *
 * The projection is explicit rather than a pass-through of the caller's objects so that a field
 * the contract does not name cannot ride along into the database, and so an absent optional
 * stays absent instead of becoming `null`.
 */
export function encodeAnalysisPayload(results: readonly EngineResult[]): unknown[] {
  assertLineOrder(results);
  return results.map((result) => ({
    multipv: result.multipv,
    evaluation: { type: result.evaluation.type, value: result.evaluation.value },
    ...(result.evaluationBound !== undefined ? { evaluationBound: result.evaluationBound } : {}),
    principalVariation: [...result.principalVariation],
    depth: result.depth,
    ...(result.selDepth !== undefined ? { selDepth: result.selDepth } : {}),
    nodes: result.nodes,
    nps: result.nps,
    timeMs: result.timeMs,
  }));
}

/**
 * Turn a stored payload back into results, validating every field.
 *
 * Throws {@link AnalysisCachePayloadError} for an unknown `payloadVersion` or for any value the
 * {@link EngineResult} contract does not admit. The alternative — casting the row's JSON to
 * `EngineResult[]` — would let a malformed evaluation reach a caller that has no way left to
 * tell it apart from a real one.
 */
export function decodeAnalysisPayload(payloadVersion: number, raw: unknown): readonly EngineResult[] {
  if (payloadVersion !== ANALYSIS_CACHE_PAYLOAD_VERSION) {
    throw new AnalysisCachePayloadError(`payload version ${payloadVersion} is not readable by this build`);
  }
  if (!Array.isArray(raw)) throw new AnalysisCachePayloadError('payload is not an array');
  const results = raw.map((entry, index) => decodeResult(entry, index));
  assertLineOrder(results);
  return Object.freeze(results);
}

function decodeResult(entry: unknown, index: number): EngineResult {
  const at = `results[${index}]`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new AnalysisCachePayloadError(`${at} is not an object`);
  }
  const row = entry as Record<string, unknown>;

  const result: EngineResult = {
    multipv: integer(row['multipv'], `${at}.multipv`, 1),
    evaluation: decodeEvaluation(row['evaluation'], `${at}.evaluation`),
    ...(row['evaluationBound'] !== undefined
      ? { evaluationBound: bound(row['evaluationBound'], `${at}.evaluationBound`) }
      : {}),
    principalVariation: Object.freeze(moves(row['principalVariation'], `${at}.principalVariation`)),
    depth: integer(row['depth'], `${at}.depth`, 0),
    ...(row['selDepth'] !== undefined ? { selDepth: integer(row['selDepth'], `${at}.selDepth`, 0) } : {}),
    nodes: integer(row['nodes'], `${at}.nodes`, 0),
    nps: integer(row['nps'], `${at}.nps`, 0),
    timeMs: integer(row['timeMs'], `${at}.timeMs`, 0),
  };
  return result;
}

function decodeEvaluation(value: unknown, at: string): EngineResult['evaluation'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AnalysisCachePayloadError(`${at} is not an object`);
  }
  const row = value as Record<string, unknown>;
  const type = row['type'];
  if (type !== 'cp' && type !== 'mate') {
    throw new AnalysisCachePayloadError(`${at}.type is neither 'cp' nor 'mate'`);
  }
  const score = row['value'];
  if (!Number.isSafeInteger(score)) {
    throw new AnalysisCachePayloadError(`${at}.value is not an integer`);
  }
  return { type, value: score as number };
}

function bound(value: unknown, at: string): NonNullable<EngineResult['evaluationBound']> {
  if (value !== 'lowerbound' && value !== 'upperbound') {
    throw new AnalysisCachePayloadError(`${at} is neither 'lowerbound' nor 'upperbound'`);
  }
  return value;
}

function moves(value: unknown, at: string): string[] {
  if (!Array.isArray(value)) throw new AnalysisCachePayloadError(`${at} is not an array`);
  return value.map((move, index) => {
    if (typeof move !== 'string') {
      throw new AnalysisCachePayloadError(`${at}[${index}] is not a string`);
    }
    return move;
  });
}

function integer(value: unknown, at: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new AnalysisCachePayloadError(`${at} is not an integer >= ${minimum}`);
  }
  return value as number;
}

/**
 * Hold a set of lines to the collection contract `EngineResult` states: one result per requested
 * line, "ordered best-first (`multipv` 1..N)".
 *
 * Individual fields being well-formed is not enough. An empty array is the sharper case: it passes
 * every per-field check, and `EngineManager.analyze` returns a cache hit with `if (cached) return
 * cached`, where `[]` is truthy — so an empty stored payload would be served as a successful
 * analysis to callers like `endgame-trainer` and `opening-explorer`, which go straight to
 * `results[0]` and would find `undefined`. A search that found no lines cannot answer anything, so
 * it is refused in both directions: never stored, and never returned if some other writer stored it.
 */
function assertLineOrder(results: readonly EngineResult[]): void {
  if (results.length === 0) {
    throw new AnalysisCachePayloadError('an analysis with no lines cannot answer any request');
  }
  for (const [index, result] of results.entries()) {
    if (result.multipv !== index + 1) {
      throw new AnalysisCachePayloadError(
        `line ${index} claims multipv ${result.multipv}; lines must run 1..N in order`,
      );
    }
  }
}
