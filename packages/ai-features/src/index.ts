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
 * feature (Coach, Puzzle Generator, Commentator, etc.) will follow.
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
