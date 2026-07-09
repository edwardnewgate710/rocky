/**
 * Request and response types for the `MoveExplainer` feature.
 *
 * These are pure data — no behaviour, no dependencies — shared between
 * the explainer, its callers, and its tests.  The structured
 * {@link MoveExplanationResponse} is the whole point: the engine
 * citation is a distinct, testable field, not prose the test has to
 * parse.
 */

import type { EngineResult, AnalysisLimits } from '@chess-platform/engine';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';

/** A move in UCI long algebraic notation (e.g. `e2e4`, `e7e8q`). */
export type MoveUci = string;

/**
 * Request for a move explanation.
 *
 * The caller supplies a position (FEN) and a move (UCI).  The explainer
 * runs the engine (via the injected `AnalysisProvider`) if no pre-computed
 * analysis is supplied, grounds the LLM prompt with the engine's eval +
 * best line, and returns a natural-language explanation that cites the
 * engine's numbers.
 */
export interface ExplainRequest {
  /** FEN of the position in which the move was played (or is being considered). */
  readonly fen: string;
  /** The move to explain, in UCI long algebraic notation (e.g. `e2e4`). */
  readonly move: MoveUci;
  /** Chess variant (defaults to `chess`). */
  readonly variant?: string;
  /**
   * Pre-computed engine analysis for the position.  If omitted, the
   * explainer runs the injected `AnalysisProvider` to obtain it.
   * This lets callers reuse analysis they already have (e.g. from a
   * live eval bar) and avoids redundant engine work.
   */
  readonly analysis?: readonly EngineResult[];
  /** Engine search limits (used only when `analysis` is not supplied). */
  readonly limits?: AnalysisLimits;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
  /** Optional: the side that played the move (`white` | `black`). */
  readonly side?: 'white' | 'black';
}

/**
 * The structured engine citation that grounds every explanation.
 * This is a distinct, testable field — not embedded in prose.
 */
export interface EngineCitation {
  /** FEN of the analyzed position. */
  readonly fen: string;
  /** The move being explained, in UCI. */
  readonly move: MoveUci;
  /** Evaluation kind: `cp` (centipawns) or `mate`. */
  readonly evalKind: 'cp' | 'mate';
  /** Evaluation value from the side-to-move's perspective. */
  readonly evalValue: number;
  /** Human-readable eval string (e.g. `+1.50` or `mate in 3`). */
  readonly evalLabel: string;
  /** The engine's principal variation (best line) in UCI moves. */
  readonly bestLine: readonly string[];
  /** Search depth the engine reached. */
  readonly depth: number;
}

/**
 * The explanation response.  The `explanation` field is natural-language
 * prose; the `citation` field is the structured, verifiable engine data
 * that grounds it.  Tests assert on `citation`, not on parsing prose.
 */
export interface MoveExplanationResponse {
  /** Natural-language explanation of the move. */
  readonly explanation: string;
  /** Structured engine citation (eval, best line, depth). */
  readonly citation: EngineCitation;
  /** The provider id that served the LLM completion. */
  readonly providerId: string;
  /** The model that served the completion. */
  readonly model: string;
  /** Token usage from the LLM call. */
  readonly usage: TokenUsage;
  /** Wall-clock latency of the LLM call in ms. */
  readonly latencyMs: number;
}

// ---------------------------------------------------------------------------
// Re-exported types from dependencies (so callers only need this package)
// ---------------------------------------------------------------------------

export type { EngineResult, Evaluation, AnalysisLimits } from '@chess-platform/engine';
export type { TokenUsage } from '@chess-platform/ai-orchestrator';
