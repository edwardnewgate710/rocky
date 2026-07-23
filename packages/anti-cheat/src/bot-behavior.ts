import type { Suspicion } from './analyzer';

/**
 * One timed move by the player under analysis.
 */
export interface TimedMove {
  /** Wall-clock milliseconds the player spent before making this move (>= 0). */
  readonly ms: number;
  /** True for opening-book / pre-theory moves; excluded from the timing statistics. */
  readonly isBook?: boolean;
}

/**
 * Per-game behavioral move-time timing report for a single player.
 *
 * Behavioral bot detection analyzes move-time distributions (pacing uniformity
 * and near-instant reply frequency), forming a screening signal orthogonal to
 * move quality (engine correlation). Per ARCHITECTURE §7, this signal feeds a
 * review queue and is NEVER an automated verdict or instant ban.
 */
export interface BotBehaviorReport {
  readonly suspicion: Suspicion;
  /** Non-book moves considered. */
  readonly sampleSize: number;
  /** Mean move time over the sample (ms). 0 for an empty sample. */
  readonly meanMs: number;
  /** Population standard deviation of the sample's move times (ms). */
  readonly stdevMs: number;
  /** stdevMs / meanMs; 0 when meanMs is 0. LOW values = suspiciously uniform pacing (bot-like). */
  readonly coefficientOfVariation: number;
  /** Moves at or below {@link INSTANT_MOVE_MS}. */
  readonly instantMoves: number;
  /** instantMoves / sampleSize; a HIGH fraction of near-instant replies is bot-like. 0 for empty. */
  readonly instantFraction: number;
  /** Σ move time (ms) over the sample — a poolable numerator for cross-game aggregation. */
  readonly sumMs: number;
  /** Σ (move time)² (ms²) over the sample — poolable numerator for pooled variance. */
  readonly sumSqMs: number;
  /** Set when the sample is too small to trust an escalation — the report then stays `clean`. */
  readonly lowConfidence: boolean;
}

/** Below this sample size of non-book moves, lowConfidence — never escalate. */
export const BOT_MIN_SAMPLE_SIZE = 10;

/** Move time (ms) at or below which a move counts as a near-instant reply. */
export const INSTANT_MOVE_MS = 150;

/** Coefficient of variation at or below this triggers at least `review` suspicion. */
export const CV_REVIEW = 0.5;

/** Coefficient of variation at or below this triggers `high` suspicion. */
export const CV_HIGH = 0.25;

/** Fraction of near-instant moves at or above this triggers at least `review` suspicion. */
export const INSTANT_FRACTION_REVIEW = 0.7;

/** Fraction of near-instant moves at or above this triggers `high` suspicion. */
export const INSTANT_FRACTION_HIGH = 0.9;

/** Helper ranking for suspicion bands. */
function suspicionRank(s: Suspicion): number {
  switch (s) {
    case 'high':
      return 2;
    case 'review':
      return 1;
    case 'clean':
      return 0;
  }
}

/**
 * Map behavioral move-time metrics to a suspicion band: the MORE severe of the
 * coefficient-of-variation band and the near-instant-reply band (high>review>clean).
 * Does NOT apply the low-confidence gate — the caller does.
 */
export function behaviorSuspicion(
  coefficientOfVariation: number,
  instantFraction: number,
): Suspicion {
  let cvBand: Suspicion = 'clean';
  if (coefficientOfVariation <= CV_HIGH) {
    cvBand = 'high';
  } else if (coefficientOfVariation <= CV_REVIEW) {
    cvBand = 'review';
  }

  let instantBand: Suspicion = 'clean';
  if (instantFraction >= INSTANT_FRACTION_HIGH) {
    instantBand = 'high';
  } else if (instantFraction >= INSTANT_FRACTION_REVIEW) {
    instantBand = 'review';
  }

  return suspicionRank(cvBand) >= suspicionRank(instantBand) ? cvBand : instantBand;
}

/**
 * Analyzes a player's per-move timings for a single game to compute behavioral bot signals.
 *
 * Deterministic pure function: no I/O, no mutation of input.
 * Screening signal intended for human review queue, never auto-ban.
 */
export function analyzeBotBehavior(moves: readonly TimedMove[]): BotBehaviorReport {
  const sampleMoves = moves.filter((m) => !m.isBook);
  const sampleSize = sampleMoves.length;

  if (sampleSize === 0) {
    return {
      suspicion: 'clean',
      sampleSize: 0,
      meanMs: 0,
      stdevMs: 0,
      coefficientOfVariation: 0,
      instantMoves: 0,
      instantFraction: 0,
      sumMs: 0,
      sumSqMs: 0,
      lowConfidence: true,
    };
  }

  const sumMs = sampleMoves.reduce((acc, m) => acc + m.ms, 0);
  const sumSqMs = sampleMoves.reduce((acc, m) => acc + m.ms * m.ms, 0);
  const meanMs = sumMs / sampleSize;

  const populationVariance =
    sampleMoves.reduce((acc, m) => acc + Math.pow(m.ms - meanMs, 2), 0) / sampleSize;
  const stdevMs = Math.sqrt(populationVariance);

  const coefficientOfVariation = meanMs > 0 ? stdevMs / meanMs : 0;

  const instantMoves = sampleMoves.filter((m) => m.ms <= INSTANT_MOVE_MS).length;
  const instantFraction = instantMoves / sampleSize;

  const lowConfidence = sampleSize < BOT_MIN_SAMPLE_SIZE;

  const suspicion: Suspicion = lowConfidence
    ? 'clean'
    : behaviorSuspicion(coefficientOfVariation, instantFraction);

  return {
    suspicion,
    sampleSize,
    meanMs,
    stdevMs,
    coefficientOfVariation,
    instantMoves,
    instantFraction,
    sumMs,
    sumSqMs,
    lowConfidence,
  };
}
