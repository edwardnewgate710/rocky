import type { AnalysisPort } from '../analysis/service.js';
import type {
  MistakePredictionInput,
  MistakePredictionOutcome,
} from '../analysis/mistake-prediction-service.js';
import { RequestScopedAnalysis } from '../coach/request-scoped-analysis.js';
import { HttpError } from '../http/errors.js';
import type { FinishedGameForReview, FinishedGameReviewArchive } from './finished-game-review.js';

/** A full instant review is intentionally bounded to keep one request within the engine budget. */
export const MAX_REVIEWED_PLAYER_MOVES = 40;

export interface MoveAssessmentService {
  predict(
    input: MistakePredictionInput,
    onAccepted?: () => Promise<void>,
  ): Promise<MistakePredictionOutcome>;
}

export interface GameReviewMove {
  readonly ply: number;
  readonly san: string;
  readonly move: string;
  readonly fenBefore: string;
  readonly assessment: MistakePredictionOutcome;
}

export interface GameReviewOutcome {
  readonly gameId: string;
  readonly variant: string;
  readonly playerColor: 'white' | 'black';
  readonly result: '1-0' | '0-1' | '1/2-1/2';
  readonly termination: string;
  readonly moves: readonly GameReviewMove[];
  readonly summary: {
    readonly ok: number;
    readonly inaccuracies: number;
    readonly mistakes: number;
    readonly blunders: number;
  };
}

export interface GameReviewServiceOptions {
  readonly archive: FinishedGameReviewArchive;
  readonly analysis: AnalysisPort;
  /** Built over the request-scoped analysis port, never the shared library Coach. */
  readonly createMoveAssessment: (analysis: AnalysisPort) => MoveAssessmentService;
}

/**
 * Produces a player's engine-grounded review only after a game is durable and over.
 *
 * The service returns no partial review: a cancelled or unavailable engine operation fails the
 * request, so callers never mistake an incomplete set of findings for a complete assessment.
 */
export class GameReviewService {
  private readonly archive: FinishedGameReviewArchive;
  private readonly analysis: AnalysisPort;
  private readonly createMoveAssessment: (analysis: AnalysisPort) => MoveAssessmentService;

  constructor(options: GameReviewServiceOptions) {
    this.archive = options.archive;
    this.analysis = options.analysis;
    this.createMoveAssessment = options.createMoveAssessment;
  }

  async review(
    input: { readonly gameId: string; readonly userId: string; readonly signal: AbortSignal },
    onAccepted: () => Promise<void>,
  ): Promise<GameReviewOutcome> {
    const game = await this.archive.finishedGameForReview(input.gameId);
    if (!game) throw HttpError.notFound('completed game not found');

    const playerColor = playerColorFor(game, input.userId);
    if (!playerColor) throw HttpError.notFound('completed game not found');

    const moves = game.moves.filter((move) => move.by === (playerColor === 'white' ? 'w' : 'b'));
    if (moves.length > MAX_REVIEWED_PLAYER_MOVES) {
      throw HttpError.validation('game is too long for an instant review', {
        moves: `at most ${MAX_REVIEWED_PLAYER_MOVES} player moves are supported`,
      });
    }
    if (moves.length === 0) throw HttpError.validation('game has no moves to review');

    // Archive/ownership/length validation is complete before quota is spent. One accepted review
    // consumes one quota unit even though it contains several fixed-policy engine assessments.
    await onAccepted();

    const scoped = new RequestScopedAnalysis(this.analysis, input.signal);
    const assessor = this.createMoveAssessment(scoped);
    const reviewed: GameReviewMove[] = [];
    const summary = { ok: 0, inaccuracies: 0, mistakes: 0, blunders: 0 };

    for (const move of moves) {
      if (input.signal.aborted) throw HttpError.unavailable('game review was cancelled');
      const assessment = await assessor.predict({
        fen: move.fenBefore,
        variant: game.variant,
        move: move.uci,
      });
      reviewed.push({
        ply: move.ply,
        san: move.san,
        move: move.uci,
        fenBefore: move.fenBefore,
        assessment,
      });
      switch (assessment.classification) {
        case 'ok': summary.ok += 1; break;
        case 'inaccuracy': summary.inaccuracies += 1; break;
        case 'mistake': summary.mistakes += 1; break;
        case 'blunder': summary.blunders += 1; break;
      }
    }

    return {
      gameId: game.gameId,
      variant: game.variant,
      playerColor,
      result: game.result,
      termination: game.termination,
      moves: reviewed,
      summary,
    };
  }
}

function playerColorFor(game: FinishedGameForReview, userId: string): 'white' | 'black' | undefined {
  if (game.white === userId) return 'white';
  if (game.black === userId) return 'black';
  return undefined;
}
