import { createMistakePrediction } from '../analysis/composition.js';
import type { AnalysisPort } from '../analysis/service.js';
import { BundledOpeningDatabase } from '@chess-platform/ai-features';
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
    openingDatabase: new BundledOpeningDatabase(),
  });
}
