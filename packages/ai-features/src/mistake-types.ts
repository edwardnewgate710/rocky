/**
 * Request and response types for the `MistakePredictor` feature.
 *
 * These are pure data — no behaviour, no dependencies — shared between
 * the predictor, its callers, and its tests.  The structured
 * {@link MistakeVerdict} is the whole point: the mistake classification
 * and all correctness fields come entirely from the engine, not from
 * LLM prose.
 */

import type { EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';

import type { MoveUci } from './types.js';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Request for mistake prediction.
 *
 * The caller supplies a position (FEN) and a candidate move (UCI) the
 * player is considering.  The predictor runs the engine on the original
 * position and on the position after the candidate move, computes the
 * centipawn loss, and classifies the move.
 */
export interface PredictRequest {
  /** FEN of the position in which the move is being considered. */
  readonly fen: string;
  /** The candidate move to evaluate, in UCI long algebraic notation (e.g. `e2e4`). */
  readonly move: MoveUci;
  /** Chess variant (defaults to `chess`). */
  readonly variant?: string;
  /** Engine search limits (used only when pre-computed analysis is not supplied). */
  readonly limits?: AnalysisLimits;
  /**
   * Pre-computed engine analysis of the original position (multi-Pv 1).
   * If omitted, the predictor runs the injected `AnalysisProvider`.
   */
  readonly analysisBefore?: readonly EngineResult[];
  /**
   * Pre-computed engine analysis of the position after the candidate move
   * (multi-Pv 1).  If omitted, the predictor applies the move and runs
   * the engine on the resulting position.
   */
  readonly analysisAfter?: readonly EngineResult[];
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
  /** Optional: override the inaccuracy threshold (cp). Default: 50. */
  readonly inaccuracyThreshold?: number;
  /** Optional: override the mistake threshold (cp). Default: 100. */
  readonly mistakeThreshold?: number;
  /** Optional: override the blunder threshold (cp). Default: 300. */
  readonly blunderThreshold?: number;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Mistake classification, derived from the measured centipawn loss.
 *
 * - `ok`: loss < inaccuracy threshold — the move is fine.
 * - `inaccuracy`: loss ≥ inaccuracy threshold but < mistake threshold.
 * - `mistake`: loss ≥ mistake threshold but < blunder threshold.
 * - `blunder`: loss ≥ blunder threshold, or the move walks into a forced mate.
 */
export type MistakeClassification = 'ok' | 'inaccuracy' | 'mistake' | 'blunder';

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * A verified mistake verdict.  All correctness fields come from the
 * engine — the LLM never decides whether a move is a mistake.
 *
 * Both `evalBefore` and `evalAfterMoverPerspective` are normalised to
 * the **mover's** perspective (positive = good for the mover).  The
 * engine reports eval from the side-to-move's perspective; after the
 * candidate move it is the opponent's turn, so the eval must be negated
 * to keep it in the mover's frame.
 */
export interface MistakeVerdict {
  /** FEN of the original position. */
  readonly fen: string;
  /** The candidate move that was evaluated, in UCI. */
  readonly move: MoveUci;
  /** FEN of the position after the candidate move. */
  readonly fenAfter: string;
  /** The classification: ok / inaccuracy / mistake / blunder. */
  readonly classification: MistakeClassification;
  /** Centipawn loss caused by the candidate move (evalBefore − evalAfterMoverPerspective). */
  readonly centipawnLoss: number;
  /** Engine eval of the original position, from the mover's perspective. */
  readonly evalBefore: Evaluation;
  /** Human-readable eval label for evalBefore (e.g. `+1.50` or `mate in 3`). */
  readonly evalBeforeLabel: string;
  /** Engine eval of the position after the move, from the mover's perspective (negated). */
  readonly evalAfterMoverPerspective: Evaluation;
  /** Human-readable eval label for evalAfterMoverPerspective. */
  readonly evalAfterLabel: string;
  /** The engine's best move from the original position (what the player should play instead). */
  readonly betterMove: MoveUci;
  /** The engine's principal variation from the original position. */
  readonly bestLine: readonly string[];
  /** Search depth the engine reached on the original position. */
  readonly depth: number;
  /** Optional: natural-language coaching text from the LLM.  `null` if no AI provider was supplied. */
  readonly coaching: string | null;
  /** The provider id that served the LLM completion, or `null` if no AI provider was supplied. */
  readonly providerId: string | null;
  /** The model that served the completion, or `null` if no AI provider was supplied. */
  readonly model: string | null;
  /** Token usage from the LLM call, or `null` if no AI provider was supplied. */
  readonly usage: TokenUsage | null;
  /** Wall-clock latency of the LLM call in ms, or `null` if no AI provider was supplied. */
  readonly latencyMs: number | null;
}
