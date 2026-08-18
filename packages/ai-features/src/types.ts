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
 * A finished game's outcome, as adjudicated by the caller.
 *
 * Deliberately structural rather than an import from the API: this package sits below it and knows
 * nothing about HTTP. `reason` is the platform's `GameStatus` vocabulary and `result` its
 * `ResultString`; `describe` is the phrase to ground the model with, so this package never has to
 * decide how an outcome should read.
 */
export interface TerminalAfterMove {
  readonly reason: string;
  /**
   * The game result.
   *
   * Narrowed from `string` in M15 increment 5. `ResultString` has exactly three values and every
   * caller already supplies one; leaving it open let a consumer branch on a fourth that cannot
   * exist, and made the one shape this package has for a finished game disagree with itself.
   * Raised in the CodeRabbit review of PR #136.
   */
  readonly result: '1-0' | '0-1' | '1/2-1/2';
  readonly describe: string;
}

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
  /** Chess variant in the platform's vocabulary — `standard`, `atomic`, … (defaults to `standard`). */
  readonly variant?: string;
  /**
   * Pre-computed engine analysis for the position.  If omitted, the
   * explainer runs the injected `AnalysisProvider` to obtain it.
   * This lets callers reuse analysis they already have (e.g. from a
   * live eval bar) and avoids redundant engine work.
   */
  readonly analysis?: readonly EngineResult[];
  /**
   * Pre-computed engine analysis of the position **after** {@link move} has been played.
   *
   * Without it the only evaluation available describes the position before the move, which is the
   * engine's assessment of its *own* preferred continuation — so a request to explain any move the
   * engine did not choose would be answered with facts about a different move. Supplying this is
   * what lets an explanation say whether the move played was good, and by how much.
   *
   * Optional because a caller may only want the position's assessment; when omitted the citation
   * carries no post-move evaluation and the prompt says nothing about one.
   */
  readonly analysisAfterMove?: readonly EngineResult[];
  /**
   * The game's outcome when {@link move} ends it, adjudicated by the caller's rules engine.
   *
   * Supplied *instead of* {@link analysisAfterMove}: a decided position has no evaluation, and a
   * search of one returns a placeholder that reads as `+0.00`. When this is present the explainer
   * grounds the explanation in the result and reports it as the move's outcome.
   */
  readonly terminalAfterMove?: TerminalAfterMove;
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
  /**
   * The engine's own preferred move in this position — the first move of {@link bestLine}.
   *
   * Present so a caller can tell at a glance whether {@link move} *is* the engine's choice, without
   * comparing strings against a line it also has to interpret.
   */
  readonly bestMove?: string;
  /**
   * Evaluation after {@link move}, normalised to the perspective of the player who made it.
   *
   * Absent when the caller supplied no post-move analysis. When present, this and the fields above
   * are the two halves of the only claim that matters: what the move achieves, and what the engine
   * would have achieved instead. `evalValue` alone describes the engine's preference, not the
   * player's move.
   */
  readonly moveEvalKind?: 'cp' | 'mate';
  /** Evaluation value after {@link move}, mover-relative. See {@link moveEvalKind}. */
  readonly moveEvalValue?: number;
  /** Human-readable post-move eval (e.g. `-1.20`). See {@link moveEvalKind}. */
  readonly moveEvalLabel?: string;
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
