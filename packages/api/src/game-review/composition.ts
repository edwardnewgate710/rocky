import { createMistakePrediction } from '../analysis/composition.js';
import type { AnalysisPort } from '../analysis/service.js';
import type { FinishedGameReviewArchive } from './finished-game-review.js';
import { GameReviewService } from './service.js';

/** Compose post-game review over the one production analysis subsystem. */
export function createGameReview(
  analysis: AnalysisPort,
  archive: FinishedGameReviewArchive,
): GameReviewService {
  return new GameReviewService({
    analysis,
    archive,
    createMoveAssessment: createMistakePrediction,
  });
}
