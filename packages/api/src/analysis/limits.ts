/**
 * @packageDocumentation
 * The enforcement boundary for engine analysis limits.
 *
 * Analysis is a CPU-amplification surface: a request costing the caller one HTTP round trip can
 * cost the server seconds of multi-core search. Every other guard in this subsystem — auth, rate
 * limiting, pool bounds — controls *how often* that happens. This module controls *how expensive a
 * single one is allowed to be*, and it is the only place that decides.
 *
 * Two properties matter more than anything else here, and both are tested by deliberately breaking
 * them:
 *
 * 1. **A wall-clock ceiling is always applied.** `AnalysisLimits` lets a caller ask by `depth`,
 *    `nodes` or `timeMs`, and the engine honours whichever is reached first. A request carrying
 *    only `depth: 30` therefore has no time bound at all — it runs until that depth completes,
 *    which on a complex position is not a bounded quantity. So {@link applyAnalysisLimits} injects
 *    `timeMs` unconditionally, whether or not the caller mentioned time. That single line is what
 *    makes the endpoint safe to expose; the depth and node caps only shape the work below it.
 *
 * 2. **Nothing the caller sends can raise a ceiling.** Every field is clamped down to the policy,
 *    never up, and the result is built from scratch rather than by spreading the caller's object —
 *    so an unexpected property cannot ride along into the engine request.
 *
 * The route validates ranges first and rejects out-of-range input with 422, because silently
 * capping a caller who asked for depth 40 is worse than telling them the limit. This module still
 * clamps rather than trusting that, so a future caller that reaches the service by another path
 * cannot exceed the policy.
 */

/** Hard server-side ceilings. Nothing reaches an engine above these, whatever the caller asked. */
export interface AnalysisLimitsPolicy {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxTimeMs: number;
  readonly maxMultiPv: number;
  /** Applied when the caller specifies no limit at all. Must be <= the corresponding ceiling. */
  readonly defaultDepth: number;
  readonly defaultTimeMs: number;
}

/**
 * Deliberately modest. These are not a capacity claim — no load testing has been done against a
 * real deployment, so they are chosen to be obviously affordable rather than tuned.
 *
 * `maxTimeMs` is the number that matters: it is the worst case one request can occupy one worker,
 * so the worst case for the pool is `maxTimeMs * maxWorkers` of CPU per saturated batch. Two
 * seconds is enough for a useful eval bar at typical depths and short enough that a saturated pool
 * drains quickly rather than holding connections open.
 */
export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimitsPolicy = {
  maxDepth: 20,
  maxNodes: 5_000_000,
  maxTimeMs: 2_000,
  maxMultiPv: 5,
  defaultDepth: 16,
  defaultTimeMs: 1_000,
};

/** What a caller may ask for. Every field optional; all of it untrusted. */
export interface RequestedAnalysisLimits {
  readonly depth?: number | undefined;
  readonly nodes?: number | undefined;
  readonly movetimeMs?: number | undefined;
  readonly multiPv?: number | undefined;
}

/** The limits actually sent to the engine, plus the multi-PV count. */
export interface AppliedAnalysisLimits {
  readonly depth: number;
  readonly nodes?: number;
  /** Always present. See the wall-clock ceiling note in the module docblock. */
  readonly movetimeMs: number;
  readonly multiPv: number;
}

/**
 * Clamp a positive integer into `[1, max]`, treating anything that is not a usable number as
 * absent. `NaN` and `Infinity` are the interesting cases: `Math.min(Infinity, max)` is `max`, which
 * is fine, but `Math.min(NaN, max)` is `NaN`, which would travel into the engine request as a
 * `go depth NaN` line. Non-finite input is therefore rejected to the fallback rather than clamped.
 */
function clampPositive(value: number | undefined, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, max);
}

/**
 * Resolve an untrusted request into the limits the engine will actually be given.
 *
 * `depth` and `movetimeMs` are always present in the result: whichever the caller supplied, both
 * ceilings apply, so the search is bounded in two independent dimensions and neither can be
 * removed by omitting a field. `nodes` is passed through only when asked for, since it is a
 * refinement below the other two rather than a bound anything depends on.
 */
export function applyAnalysisLimits(
  requested: RequestedAnalysisLimits,
  policy: AnalysisLimitsPolicy = DEFAULT_ANALYSIS_LIMITS,
): AppliedAnalysisLimits {
  const depth = clampPositive(requested.depth, policy.maxDepth, policy.defaultDepth);
  const movetimeMs = clampPositive(requested.movetimeMs, policy.maxTimeMs, policy.defaultTimeMs);
  const multiPv = clampPositive(requested.multiPv, policy.maxMultiPv, 1);

  // Built field by field, never spread from `requested`: an unknown property on the caller's object
  // must not reach the engine request, and `exactOptionalPropertyTypes` makes the omission explicit.
  const applied: AppliedAnalysisLimits = {
    depth,
    movetimeMs,
    multiPv,
    ...(requested.nodes !== undefined && Number.isFinite(requested.nodes)
      ? { nodes: clampPositive(requested.nodes, policy.maxNodes, policy.maxNodes) }
      : {}),
  };

  return applied;
}
