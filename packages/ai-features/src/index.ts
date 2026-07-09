/**
 * `@chess-platform/ai-features` — AI-powered chess features built on the
 * M5 engine bridge (`@chess-platform/engine`) and M7 AI orchestrator
 * (`@chess-platform/ai-orchestrator`).
 *
 * Each feature is a thin task definition over the orchestration layer:
 * it runs the engine, grounds the LLM prompt with real analysis, and
 * returns a structured response with a verifiable engine citation.
 *
 * M8 increment 1: **Move Explanation** — the template every later
 * feature follows.
 *
 * M8 increment 2: **Puzzle Generator** — engine-verified tactical puzzles.
 *
 * M8 increment 3: **Mistake Predictor** — engine-measured move quality.
 *
 * M8 increment 4: **Opening Explorer** — opening identification from a
 * database port (first non-engine data source in M8).
 *
 * M8 increment 5: **Endgame Trainer** — engine-verified endgame training
 * with a bundled endgame dataset port.
 *
 * M8 increment 6: **Coach** — composition layer that orchestrates the five
 * existing features into a unified coaching response.
 */

// Types
export type {
  ExplainRequest,
  MoveExplanationResponse,
  EngineCitation,
  MoveUci,
} from './types.js';
export type { EngineResult, Evaluation, AnalysisLimits } from '@chess-platform/engine';
export type { TokenUsage } from '@chess-platform/ai-orchestrator';

// Move Explainer (M8 increment 1)
export { MoveExplainer } from './move-explainer.js';
export type { MoveExplainerOptions } from './move-explainer.js';

// Puzzle Generator (M8 increment 2)
export { PuzzleGenerator, evalGapCp, deriveDifficulty, DEFAULT_SHARPNESS_THRESHOLD, DEFAULT_MULTI_PV } from './puzzle-generator.js';
export type { PuzzleGeneratorOptions } from './puzzle-generator.js';
export type {
  GeneratePuzzleRequest,
  PuzzleResult,
  Puzzle,
  PuzzleRejection,
  PuzzleDifficulty,
} from './puzzle-types.js';

// Mistake Predictor (M8 increment 3)
export { MistakePredictor, negateEval, evalToCpLoss, classify, DEFAULT_INACCURACY_THRESHOLD, DEFAULT_MISTAKE_THRESHOLD, DEFAULT_BLUNDER_THRESHOLD } from './mistake-predictor.js';
export type { MistakePredictorOptions } from './mistake-predictor.js';
export type {
  PredictRequest,
  MistakeVerdict,
  MistakeClassification,
} from './mistake-types.js';

// Opening Explorer (M8 increment 4)
export { OpeningExplorer } from './opening-explorer.js';
export type { OpeningExplorerOptions } from './opening-explorer.js';
export type { ExploreRequest, ExplorationResult } from './opening-types.js';
export { BundledOpeningDatabase } from './bundled-opening-database.js';
export type { OpeningDatabase, OpeningEntry, OpeningContinuation, OpeningStats, OpeningLookupResult } from './opening-database.js';

// Endgame Trainer (M8 increment 5)
export { EndgameTrainer, classifyAttempt } from './endgame-trainer.js';
export type { EndgameTrainerOptions } from './endgame-trainer.js';
export type { NextPositionRequest, TrainingPosition, EngineSolution, EvaluateAttemptRequest, AttemptEvaluation, AttemptClassification } from './endgame-types.js';
export { BundledEndgameDatabase } from './bundled-endgame-database.js';
export type { EndgameDatabase, EndgameEntry, EndgameGoal, EndgameType, EndgameDifficulty } from './endgame-database.js';

// Coach (M8 increment 6)
export { Coach } from './coach.js';
export type { CoachOptions, CoachFeatures } from './coach.js';
export type { CoachRequest, CoachingResponse } from './coach-types.js';
