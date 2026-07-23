import type { Suspicion } from './analyzer';
import {
  type BotBehaviorReport,
  behaviorSuspicion,
} from './bot-behavior';

/** A single game may not flip an account: the aggregate can't escalate below this many games. */
export const BOT_AGG_MIN_GAMES = 3;
/** The pooled move sample (Σ per-game sampleSize) must reach this before the aggregate can escalate. */
export const BOT_AGG_MIN_POOLED_SAMPLE = 40;

/** One game's contribution to an account-level behavioral aggregate. */
export interface BotAggregateInput {
  readonly gameId: string;
  readonly report: BotBehaviorReport;
}

export interface BotAggregateReport {
  readonly suspicion: Suspicion;
  readonly gamesAnalyzed: number;
  /** Pooled move-time denominator (Σ per-game sampleSize). */
  readonly pooledSampleSize: number;
  /** Sample-weighted mean move time (Σ sumMs ÷ Σ sampleSize), not an average of per-game means. */
  readonly pooledMeanMs: number;
  /** Pooled population standard deviation over all moves across the games. */
  readonly pooledStdevMs: number;
  /** Pooled coefficient of variation (pooledStdevMs ÷ pooledMeanMs; 0 when pooledMeanMs is 0). */
  readonly pooledCoefficientOfVariation: number;
  /** Pooled near-instant replies (Σ per-game instantMoves). */
  readonly pooledInstantMoves: number;
  /** Pooled near-instant fraction (pooledInstantMoves ÷ pooledSampleSize; 0 when empty). */
  readonly pooledInstantFraction: number;
  /** Set when too few games or too thin a pooled sample to trust an escalation. */
  readonly lowConfidence: boolean;
  /** Game IDs whose per-game suspicion was `review`/`high`, for reviewer drill-down. */
  readonly flaggedGameIds: readonly string[];
}

/**
 * Combine one account's per-game bot behavior reports into an account-level
 * suspicion signal by POOLING numerators and denominators across games.
 * Pure and deterministic.
 *
 * Screening signal intended for human moderation review — never an automated verdict or ban.
 *
 * @throws if the same `gameId` appears twice — a retried/overlapping history
 *   read must not inflate the pooled totals (and thus confidence) by
 *   double-counting a game.
 */
export function aggregateBotBehavior(
  games: readonly BotAggregateInput[],
): BotAggregateReport {
  let gamesAnalyzed = 0;
  let pooledSampleSize = 0;
  let pooledSumMs = 0;
  let pooledSumSqMs = 0;
  let pooledInstantMoves = 0;

  const flaggedGameIds: string[] = [];
  const seenGameIds = new Set<string>();

  for (const { gameId, report } of games) {
    if (seenGameIds.has(gameId)) {
      throw new Error(`aggregateBotBehavior: duplicate gameId "${gameId}"`);
    }
    seenGameIds.add(gameId);

    gamesAnalyzed++;
    pooledSampleSize += report.sampleSize;
    pooledSumMs += report.sumMs;
    pooledSumSqMs += report.sumSqMs;
    pooledInstantMoves += report.instantMoves;

    if (report.suspicion === 'review' || report.suspicion === 'high') {
      flaggedGameIds.push(gameId);
    }
  }

  const pooledMeanMs = pooledSampleSize > 0 ? pooledSumMs / pooledSampleSize : 0;
  const pooledVariance =
    pooledSampleSize > 0
      ? Math.max(0, pooledSumSqMs / pooledSampleSize - Math.pow(pooledMeanMs, 2))
      : 0;
  const pooledStdevMs = Math.sqrt(pooledVariance);
  const pooledCoefficientOfVariation =
    pooledMeanMs > 0 ? pooledStdevMs / pooledMeanMs : 0;
  const pooledInstantFraction =
    pooledSampleSize > 0 ? pooledInstantMoves / pooledSampleSize : 0;

  const lowConfidence =
    gamesAnalyzed < BOT_AGG_MIN_GAMES || pooledSampleSize < BOT_AGG_MIN_POOLED_SAMPLE;

  const suspicion: Suspicion = lowConfidence
    ? 'clean'
    : behaviorSuspicion(pooledCoefficientOfVariation, pooledInstantFraction);

  return {
    suspicion,
    gamesAnalyzed,
    pooledSampleSize,
    pooledMeanMs,
    pooledStdevMs,
    pooledCoefficientOfVariation,
    pooledInstantMoves,
    pooledInstantFraction,
    lowConfidence,
    flaggedGameIds,
  };
}
