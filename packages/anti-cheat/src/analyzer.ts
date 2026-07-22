import type { PositionEvaluator } from './port';

/** Which side made the move at a given ply. */
export type Player = 'white' | 'black';

/** Screening bands — a signal for human review, never an automated verdict. */
export type Suspicion = 'clean' | 'review' | 'high';

export interface PlayerCorrelationReport {
  readonly suspicion: Suspicion;
  /** Average centipawn loss over the player's non-book plies (raw, uncapped). */
  readonly acpl: number;
  /** ACPL with each ply's loss clamped to {@link ACPL_CAP} so one blunder can't dominate. */
  readonly acplCapped: number;
  /** Fraction of scored plies where the played move was the engine's #1. */
  readonly t1Rate: number;
  /** Fraction of scored plies where the played move was in the engine's top 3. */
  readonly t3Rate: number;
  /** Non-book plies excluded from T1/T3 because the position was effectively forced. */
  readonly onlyMoveExcluded: number;
  /** Non-book plies contributing to ACPL (includes only-move plies). */
  readonly sampleSize: number;
  /** Non-book plies the evaluator could not score (empty/incomplete result); excluded from every metric. */
  readonly unscored: number;
  /** Set when the sample is too small, the T1/T3 denominator too thin, or the analysis depth too shallow to trust. */
  readonly lowConfidence: boolean;
}

/**
 * A per-player report. Engine-correlation flags a SPECIFIC player, so a game is
 * always split by side — a cheater on one side must not be diluted by the
 * opponent's human moves.
 */
export interface GameCorrelationReport {
  readonly white: PlayerCorrelationReport;
  readonly black: PlayerCorrelationReport;
}

export interface AnalyzedPly {
  readonly fen: string;
  readonly playedUci: string;
  /** Which side made this move. Metrics are computed per player. */
  readonly player: Player;
  /** True for opening-theory plies; excluded from every metric. */
  readonly isBook?: boolean;
}

export interface AnalyzeGameInput {
  readonly plies: readonly AnalyzedPly[];
  readonly depth: number;
  readonly evaluator: PositionEvaluator;
}

/** Per-ply centipawn-loss cap: one blunder cannot dominate a player's ACPL. */
export const ACPL_CAP = 300;
/** Documented magnitude the evaluator uses to encode a forced mate. */
export const MATE_ENCODING = 10000;
/** best − 2nd gap (cp) at or above which a position is treated as effectively forced. */
export const ONLY_MOVE_GAP = 200;
/** Below this many scored plies, a player's report is low-confidence. */
export const LOW_CONFIDENCE_SAMPLE_MIN = 20;
/**
 * Below this many T1/T3-eligible plies (non-book, non-only-move), a player's
 * report is low-confidence. A thin denominator can make T1 spike to 1.0 off a
 * handful of moves, so it must never escalate suspicion on its own.
 */
export const LOW_CONFIDENCE_TRATE_MIN = 10;
/** Below this analysis depth, every report is low-confidence. */
export const LOW_CONFIDENCE_DEPTH_MIN = 14;

export async function analyzeGame(input: AnalyzeGameInput): Promise<GameCorrelationReport> {
  const { plies, depth, evaluator } = input;
  const white = await analyzePlayer(plies.filter((p) => p.player === 'white'), depth, evaluator);
  const black = await analyzePlayer(plies.filter((p) => p.player === 'black'), depth, evaluator);
  return { white, black };
}

/** Accumulate the correlation metrics for a single player's plies. */
async function analyzePlayer(
  plies: readonly AnalyzedPly[],
  depth: number,
  evaluator: PositionEvaluator,
): Promise<PlayerCorrelationReport> {
  let totalRawCentipawnLoss = 0;
  let totalCappedCentipawnLoss = 0;
  let acplSampleCount = 0;

  let t1Matches = 0;
  let t3Matches = 0;
  let tRateSampleCount = 0;
  let onlyMoveExcluded = 0;
  let unscored = 0;

  for (const ply of plies) {
    if (ply.isBook) continue;

    const evalResult = await evaluator.evaluate(ply.fen, ply.playedUci, depth);

    // The evaluator could not score this ply: either the position was
    // unevaluable (no top moves) or it did not return the played move's own
    // eval. We must never synthesize a loss — count it as unscored and skip it
    // so it contributes to no metric.
    if (evalResult.topMoves.length === 0 || evalResult.playedCp === undefined) {
      unscored++;
      continue;
    }

    const bestMove = evalResult.topMoves[0]!;
    // Raw, uncapped loss from the played move's actual eval (supplied by the
    // evaluator), so a move outside the top list contributes its true loss.
    const centipawnLoss = Math.max(0, bestMove.cp - evalResult.playedCp);

    totalRawCentipawnLoss += centipawnLoss;
    totalCappedCentipawnLoss += Math.min(centipawnLoss, ACPL_CAP);
    acplSampleCount++;

    // Only-move exclusion needs at least two candidates to measure the gap.
    // With a single candidate the position is effectively forced (there is no
    // alternative to reward), so exclude it from T1/T3 rather than crediting a
    // match against a denominator of one.
    if (evalResult.topMoves.length < 2) {
      onlyMoveExcluded++;
      continue;
    }

    // A position with a large best−2nd gap is effectively forced; playing the
    // only reasonable move shouldn't inflate the top-move match rates.
    const gapToSecond = bestMove.cp - evalResult.topMoves[1]!.cp;

    if (gapToSecond >= ONLY_MOVE_GAP) {
      onlyMoveExcluded++;
    } else {
      tRateSampleCount++;
      const rank = evalResult.topMoves.findIndex((m) => m.uci === ply.playedUci);
      if (rank === 0) t1Matches++;
      if (rank >= 0 && rank < 3) t3Matches++;
    }
  }

  const sampleSize = acplSampleCount;
  const lowConfidence =
    sampleSize < LOW_CONFIDENCE_SAMPLE_MIN ||
    tRateSampleCount < LOW_CONFIDENCE_TRATE_MIN ||
    depth < LOW_CONFIDENCE_DEPTH_MIN;

  const acpl = sampleSize > 0 ? totalRawCentipawnLoss / sampleSize : 0;
  const acplCapped = sampleSize > 0 ? totalCappedCentipawnLoss / sampleSize : 0;
  const t1Rate = tRateSampleCount > 0 ? t1Matches / tRateSampleCount : 0;
  const t3Rate = tRateSampleCount > 0 ? t3Matches / tRateSampleCount : 0;

  let suspicion: Suspicion = 'clean';
  if (!lowConfidence) {
    if (t1Rate >= 0.70 && acplCapped <= 15) {
      suspicion = 'high';
    } else if (t1Rate >= 0.55 && acplCapped <= 25) {
      suspicion = 'review';
    }
  }

  return { suspicion, acpl, acplCapped, t1Rate, t3Rate, onlyMoveExcluded, sampleSize, unscored, lowConfidence };
}
