import type { Color } from '@chess-platform/core';
import type { MistakePredictionOutcome } from '../analysis/mistake-prediction-service.js';

/** The public, Chess.com-style vocabulary used by Gambit's completed-game review. */
export const GAME_REVIEW_CLASSIFICATIONS = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
  'missed_win',
] as const;

export type GameReviewClassification = (typeof GAME_REVIEW_CLASSIFICATIONS)[number];

export type GameReviewSummary = { readonly [K in GameReviewClassification]: number };

export interface ReviewAlternative {
  readonly move: string;
  readonly evaluation: { readonly kind: 'cp' | 'mate'; readonly value: number };
}

export interface GameReviewClassificationEvidence {
  readonly assessment: MistakePredictionOutcome;
  readonly mover: Color;
  readonly isBook: boolean;
  /** A non-pawn move left immediately capturable while engine-best play preserves the advantage. */
  readonly offeredMaterial: boolean;
  /** The runner-up engine choice from the same pre-move MultiPV search, when it exists. */
  readonly alternative: ReviewAlternative | null;
}

const WINNING_CP = 300;
const TACTICAL_CHANCE_CP = 150;
const SAFE_AFTER_CP = 100;
const EXCELLENT_LOSS_CP = 15;
const GREAT_ALTERNATIVE_GAP_CP = 120;

/**
 * Turns server-owned engine evidence into a single post-game label.
 *
 * This deliberately does not pretend to be Chess.com's proprietary classifier. The vocabulary is
 * familiar, but every condition below is explicit, fixed, and independent of a browser or player
 * supplied threshold. The precedence is intentional: a missed win teaches more than the generic
 * blunder it also is, and a known book move does not become a cosmetic "best" label.
 */
export function classifyGameReviewMove(input: GameReviewClassificationEvidence): GameReviewClassification {
  const { assessment } = input;

  if (input.isBook) return 'book';
  if (missedWin(assessment, input.mover)) return 'missed_win';
  if (missedTactic(assessment, input.mover)) return 'miss';

  switch (assessment.classification) {
    case 'blunder': return 'blunder';
    case 'mistake': return 'mistake';
    case 'inaccuracy': return 'inaccuracy';
    case 'ok': break;
  }

  const isBest = assessment.bestMove !== null && assessment.bestMove === assessment.move;
  if (isBest && input.offeredMaterial && stillAhead(assessment, input.mover)) return 'brilliant';
  if (isBest && alternativeGapIsGreat(assessment, input.alternative)) return 'great';
  if (isBest) return 'best';
  if (assessment.centipawnLoss !== null && assessment.centipawnLoss <= EXCELLENT_LOSS_CP) return 'excellent';
  return 'good';
}

export function emptyGameReviewSummary(): Record<GameReviewClassification, number> {
  return {
    brilliant: 0,
    great: 0,
    best: 0,
    excellent: 0,
    good: 0,
    book: 0,
    inaccuracy: 0,
    mistake: 0,
    miss: 0,
    blunder: 0,
    missed_win: 0,
  };
}

function missedWin(assessment: MistakePredictionOutcome, mover: Color): boolean {
  return isWinning(assessment.before, mover) && !stillAhead(assessment, mover);
}

function missedTactic(assessment: MistakePredictionOutcome, mover: Color): boolean {
  return isTacticalChance(assessment.before, mover) && !stillAhead(assessment, mover);
}

function isWinning(
  evaluation: { readonly evalKind: 'cp' | 'mate'; readonly evalValue: number },
  _mover: Color,
): boolean {
  return evaluation.evalKind === 'mate' ? evaluation.evalValue > 0 : evaluation.evalValue >= WINNING_CP;
}

function isTacticalChance(
  evaluation: { readonly evalKind: 'cp' | 'mate'; readonly evalValue: number },
  mover: Color,
): boolean {
  return isWinning(evaluation, mover) || (evaluation.evalKind === 'cp' && evaluation.evalValue >= TACTICAL_CHANCE_CP);
}

/** The reviewed move preserves a win, mate score, or at least the safe evaluation floor. */
function stillAhead(assessment: MistakePredictionOutcome, mover: Color): boolean {
  if (assessment.after.kind === 'terminal') return terminalIsWin(assessment.after.result, mover);
  return assessment.after.evalKind === 'mate'
    ? assessment.after.evalValue > 0
    : assessment.after.evalValue >= SAFE_AFTER_CP;
}

function terminalIsWin(result: '1-0' | '0-1' | '1/2-1/2', mover: Color): boolean {
  return (result === '1-0' && mover === 'w') || (result === '0-1' && mover === 'b');
}

function alternativeGapIsGreat(
  assessment: MistakePredictionOutcome,
  alternative: ReviewAlternative | null,
): boolean {
  if (!alternative || alternative.move === assessment.move) return false;
  if (assessment.before.evalKind === 'cp' && alternative.evaluation.kind === 'cp') {
    return assessment.before.evalValue - alternative.evaluation.value >= GREAT_ALTERNATIVE_GAP_CP;
  }
  return assessment.before.evalKind === 'mate'
    && assessment.before.evalValue > 0
    && !(alternative.evaluation.kind === 'mate' && alternative.evaluation.value > 0);
}
