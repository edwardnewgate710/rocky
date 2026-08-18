/**
 * Request and response types for the `MistakePredictor` feature.
 *
 * These are pure data — no behaviour, no dependencies — shared between
 * the predictor, its callers, and its tests.  The structured
 * {@link MistakeVerdict} is the whole point: the mistake classification
 * and all correctness fields come entirely from the engine and the rules,
 * not from LLM prose.
 */

import type { EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';

import type { MoveUci, TerminalAfterMove } from './types.js';

// ---------------------------------------------------------------------------
// Terminal outcomes
// ---------------------------------------------------------------------------

/**
 * A move that ends the game, as adjudicated by the caller.
 *
 * Re-exported rather than redeclared: `MoveExplainer` already needed exactly this shape, and two
 * declarations of one concept is two chances to widen a field. That had already happened — the
 * original here narrowed `result` correctly while the one in `types.ts` left it open as `string`.
 * One declaration now, in `types.ts`, narrowed. Raised in the CodeRabbit review of PR #136.
 */
export type { TerminalAfterMove } from './types.js';

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
 *
 * **Classification policy is not in here.** The thresholds that decide what counts as a blunder are
 * fixed at construction time, because a request that can widen them can declare its own blunders —
 * see {@link MistakePredictorOptions}.
 */
export interface PredictRequest {
  /** FEN of the position in which the move is being considered. */
  readonly fen: string;
  /** The candidate move to evaluate, in UCI long algebraic notation (e.g. `e2e4`). */
  readonly move: MoveUci;
  /** Chess variant (defaults to `standard`). Applied to rules adjudication *and* engine routing. */
  readonly variant?: string;
  /** Engine search limits (used only when pre-computed analysis is not supplied). */
  readonly limits?: AnalysisLimits;
  /**
   * Pre-computed engine analysis of the original position (multi-Pv 1).
   * If omitted, the predictor runs the injected `AnalysisProvider` — which a caller that composed
   * without one does not have, and is a composition error rather than a runtime condition.
   */
  readonly analysisBefore?: readonly EngineResult[];
  /**
   * Pre-computed engine analysis of the position after the candidate move
   * (multi-Pv 1).  Ignored entirely when {@link terminalAfterMove} is set: a decided position gives
   * a search nothing to score, and the placeholder it answers with reads as dead level (ADR-0116).
   */
  readonly analysisAfter?: readonly EngineResult[];
  /**
   * Set when the candidate move ends the game, as adjudicated by the caller.
   *
   * Takes precedence over every post-move evaluation, supplied or searched.
   */
  readonly terminalAfterMove?: TerminalAfterMove;
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Mistake classification, derived from the measured centipawn loss or from an authoritative result.
 *
 * - `ok`: loss < inaccuracy threshold — the move is fine.
 * - `inaccuracy`: loss ≥ inaccuracy threshold but < mistake threshold.
 * - `mistake`: loss ≥ mistake threshold but < blunder threshold.
 * - `blunder`: loss ≥ blunder threshold, or the move walks into a forced mate, or it ends the game
 *   in the mover's own defeat.
 *
 * Deliberately four values. `brilliant`, `great` and `excellent` are judgements about *why* a move
 * is good, which no centipawn difference can support — a forced-mate finish and a quiet best move
 * produce the same zero loss.
 */
export type MistakeClassification = 'ok' | 'inaccuracy' | 'mistake' | 'blunder';

// ---------------------------------------------------------------------------
// Move outcome
// ---------------------------------------------------------------------------

/**
 * What the candidate move achieved, from the **mover's** perspective.
 *
 * A discriminated union rather than an evaluation carrying sentinels, for the reason ADR-0116
 * records: a decided position has no evaluation, and reporting `+0.00` about checkmate is not a
 * rounding error but the opposite of the truth.
 */
export type MoveOutcome =
  | {
      readonly kind: 'evaluation';
      readonly evaluation: Evaluation;
      readonly label: string;
    }
  | {
      readonly kind: 'terminal';
      readonly reason: string;
      readonly result: '1-0' | '0-1' | '1/2-1/2';
      readonly label: string;
    };

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * A verified mistake verdict.  All correctness fields come from the
 * engine and the rules — the LLM never decides whether a move is a mistake.
 *
 * `evalBefore` and the `evaluation` inside {@link MoveOutcome} are both normalised to the **mover's**
 * perspective (positive = good for the mover).  The engine reports eval from the side-to-move's
 * perspective; after the candidate move it is the opponent's turn, so that eval is negated to keep
 * both numbers in one frame.
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
  /**
   * Centipawn loss caused by the candidate move, or `null` when no centipawn measure applies.
   *
   * `null` rather than `Infinity`: `JSON.stringify(Infinity)` is `null` anyway, so a caller
   * serialising the old value got the same absence with none of the intent, and no way to tell it
   * from a missing field. It is `null` whenever the transition crosses into or out of a mate score,
   * and whenever the move decides the game in anything but a draw — a won game and a lost game sit
   * on no shared scale with a centipawn count.
   *
   * A move that *draws* does have a measure: a draw is exactly the zero point of the engine's own
   * scale, so the loss against it is `evalBefore − 0` and is real. See {@link assessTerminal}.
   */
  readonly centipawnLoss: number | null;
  /** Engine eval of the original position, from the mover's perspective — what best play achieves. */
  readonly evalBefore: Evaluation;
  /** Human-readable eval label for evalBefore (e.g. `+1.50` or `mate in 3`). */
  readonly evalBeforeLabel: string;
  /** What the move actually achieved: an evaluation, or a finished game. */
  readonly moveOutcome: MoveOutcome;
  /**
   * The engine's best move from the original position, or `null` when the search reported no line.
   *
   * `null`, never `(none)`: a placeholder string is a value a client can render, compare and store
   * as if it were a move. When this equals {@link move} the player found the engine's own choice —
   * expressed by the equality rather than by a second boolean that could disagree with it.
   */
  readonly betterMove: MoveUci | null;
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
