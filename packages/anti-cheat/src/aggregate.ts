import {
  type PlayerCorrelationReport,
  type Suspicion,
  SUSPICION_HIGH_T1_RATE,
  SUSPICION_HIGH_ACPL_CAPPED,
  SUSPICION_REVIEW_T1_RATE,
  SUSPICION_REVIEW_ACPL_CAPPED,
} from './analyzer';

/**
 * A single game — however anomalous — must not flip an account. The aggregate
 * cannot escalate below this many games.
 */
export const AGG_MIN_GAMES = 3;

/**
 * The pooled T1/T3 denominator (non-book, non-forced plies across every game)
 * must reach this before the aggregate can escalate — a handful of eligible
 * moves has no statistical power no matter how many games they span.
 */
export const AGG_MIN_POOLED_TRATE = 40;

/**
 * One game's contribution to an account-level aggregate: the report for the
 * side THE ACCOUNT PLAYED in that game (white or black — the caller picks the
 * correct `PlayerCorrelationReport` from each `GameCorrelationReport`).
 */
export interface PlayerAggregateInput {
  readonly gameId: string;
  readonly report: PlayerCorrelationReport;
}

export interface PlayerAggregateReport {
  readonly suspicion: Suspicion;
  readonly gamesAnalyzed: number;
  /** Pooled ACPL denominator (Σ per-game sampleSize). */
  readonly pooledSampleSize: number;
  /** Pooled T1/T3 denominator (Σ per-game tRateSampleCount). */
  readonly pooledTRateSampleCount: number;
  /** Sample-weighted mean raw ACPL (Σ raw loss ÷ Σ sampleSize), not an average of per-game ACPLs. */
  readonly acpl: number;
  /** Sample-weighted mean capped ACPL. */
  readonly acplCapped: number;
  /** Pooled T1 rate (Σ t1Matches ÷ Σ tRateSampleCount). */
  readonly t1Rate: number;
  /** Pooled T3 rate (Σ t3Matches ÷ Σ tRateSampleCount). */
  readonly t3Rate: number;
  /** Set when there are too few games or too thin a pooled denominator to trust an escalation. */
  readonly lowConfidence: boolean;
  /** Game IDs whose per-game suspicion was `review`/`high`, for a reviewer's drill-down. */
  readonly flaggedGameIds: readonly string[];
}

/**
 * Combine one account's per-game reports into an account-level suspicion signal
 * by POOLING numerators and denominators (never averaging per-game rates, which
 * would let a 3-ply game outweigh a 60-ply one). Pure and deterministic.
 *
 * Still a screening signal for HUMAN REVIEW — never an automated verdict or ban.
 *
 * @throws if the same `gameId` appears twice — a retried/overlapping history
 *   read must not inflate the pooled totals (and thus confidence) by
 *   double-counting a game.
 */
export function aggregatePlayer(
  games: readonly PlayerAggregateInput[],
): PlayerAggregateReport {
  let gamesAnalyzed = 0;
  let pooledSampleSize = 0;
  let pooledTRateSampleCount = 0;
  let totalRawCentipawnLoss = 0;
  let totalCappedCentipawnLoss = 0;
  let totalT1Matches = 0;
  let totalT3Matches = 0;

  const flaggedGameIds: string[] = [];
  const seenGameIds = new Set<string>();

  for (const { gameId, report } of games) {
    if (seenGameIds.has(gameId)) {
      throw new Error(`aggregatePlayer: duplicate gameId "${gameId}"`);
    }
    seenGameIds.add(gameId);

    gamesAnalyzed++;
    pooledSampleSize += report.sampleSize;
    pooledTRateSampleCount += report.tRateSampleCount;
    totalRawCentipawnLoss += report.rawCentipawnLossTotal;
    totalCappedCentipawnLoss += report.cappedCentipawnLossTotal;
    totalT1Matches += report.t1Matches;
    totalT3Matches += report.t3Matches;

    if (report.suspicion === 'review' || report.suspicion === 'high') {
      flaggedGameIds.push(gameId);
    }
  }

  const acpl = pooledSampleSize > 0 ? totalRawCentipawnLoss / pooledSampleSize : 0;
  const acplCapped = pooledSampleSize > 0 ? totalCappedCentipawnLoss / pooledSampleSize : 0;
  const t1Rate = pooledTRateSampleCount > 0 ? totalT1Matches / pooledTRateSampleCount : 0;
  const t3Rate = pooledTRateSampleCount > 0 ? totalT3Matches / pooledTRateSampleCount : 0;

  // A collection of individually low-confidence games CAN become confident once
  // pooled — but only if the pooled totals clear the aggregate's own gate.
  const lowConfidence =
    gamesAnalyzed < AGG_MIN_GAMES || pooledTRateSampleCount < AGG_MIN_POOLED_TRATE;

  let suspicion: Suspicion = 'clean';
  if (!lowConfidence) {
    if (t1Rate >= SUSPICION_HIGH_T1_RATE && acplCapped <= SUSPICION_HIGH_ACPL_CAPPED) {
      suspicion = 'high';
    } else if (t1Rate >= SUSPICION_REVIEW_T1_RATE && acplCapped <= SUSPICION_REVIEW_ACPL_CAPPED) {
      suspicion = 'review';
    }
  }

  return {
    suspicion,
    gamesAnalyzed,
    pooledSampleSize,
    pooledTRateSampleCount,
    acpl,
    acplCapped,
    t1Rate,
    t3Rate,
    lowConfidence,
    flaggedGameIds,
  };
}
