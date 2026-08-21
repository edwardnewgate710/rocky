/**
 * Composition for endgame training (ADR-0128).
 *
 * Returns `undefined` when the analysis service cannot satisfy the fixed limits policy
 * OR when the bundled dataset is empty, so that `endgameTrainer` capability is derived
 * from real readiness rather than a hardcoded constant.
 */
import { BundledEndgameDatabase } from '@chess-platform/ai-features';
import type { AnalysisService } from '../analysis/service.js';
import {
  ENDGAME_ANALYSIS_LIMITS,
  EndgameTrainingService,
} from './endgame-training-service.js';

/**
 * Build the endgame training service, or `undefined` when dependencies cannot satisfy its policy.
 */
export function createEndgameTraining(
  analysis: AnalysisService,
): EndgameTrainingService | undefined {
  if (!analysis.canSatisfyLimits(ENDGAME_ANALYSIS_LIMITS)) return undefined;
  if (!analysis.supportsVariant('standard')) return undefined;
  const database = new BundledEndgameDatabase();
  if (database.all().length === 0) return undefined;
  return new EndgameTrainingService({ analysis, database });
}