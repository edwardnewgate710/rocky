/**
 * Request and response types for the `PuzzleGenerator` feature.
 *
 * These are pure data — no behaviour, no dependencies — shared between
 * the generator, its callers, and its tests.  The structured
 * {@link Puzzle} and {@link PuzzleRejection} are the whole point: the
 * puzzle's validity and solution come entirely from the engine, not
 * from LLM prose.
 */

import type { EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';

import type { MoveUci } from './types.js';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Request for puzzle generation.
 *
 * The caller supplies a position (FEN).  The generator runs the engine
 * with `multiPv` lines; a position qualifies as a puzzle when the best
 * line's eval exceeds the second-best by at least `sharpnessThreshold`
 * centipawns (or the best line is mate and the second-best is not).
 */
export interface GeneratePuzzleRequest {
  /** FEN of the position to evaluate as a potential puzzle. */
  readonly fen: string;
  /** Chess variant (defaults to `chess`). */
  readonly variant?: string;
  /** Engine search limits (used only when `analysis` is not supplied). */
  readonly limits?: AnalysisLimits;
  /**
   * Number of principal variations to request from the engine.
   * Defaults to 3.  Must be ≥ 2 for the gap calculation to be meaningful.
   */
  readonly multiPv?: number;
  /**
   * Minimum eval gap (in centipawns) between the best and second-best
   * line for the position to qualify as a puzzle.
   * Default: 200 (2.00 pawns).
   */
  readonly sharpnessThreshold?: number;
  /**
   * Pre-computed engine analysis (multi-PV).  If omitted, the generator
   * runs the injected `AnalysisProvider` to obtain it.
   */
  readonly analysis?: readonly EngineResult[];
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Response — discriminated union: puzzle found vs rejected
// ---------------------------------------------------------------------------

/** Difficulty rating derived from the eval gap and search depth. */
export type PuzzleDifficulty = 'easy' | 'medium' | 'hard' | 'brilliant';

/**
 * A verified tactical puzzle.  All correctness fields come from the
 * engine — the LLM never decides whether a puzzle is real or what the
 * solution is.
 */
export interface Puzzle {
  /** Discriminator: always `'puzzle'`. */
  readonly kind: 'puzzle';
  /** FEN of the puzzle position. */
  readonly fen: string;
  /** The solution move (best move) in UCI. */
  readonly solutionMove: MoveUci;
  /** The engine's evaluation of the best line. */
  readonly bestEval: Evaluation;
  /** Human-readable eval label (e.g. `+3.50` or `mate in 3`). */
  readonly bestEvalLabel: string;
  /** The engine's evaluation of the second-best line. */
  readonly secondBestEval: Evaluation;
  /** Human-readable eval label for the second-best line. */
  readonly secondBestEvalLabel: string;
  /** The eval gap in centipawns (best − second-best).  For mate-vs-non-mate, this is `Infinity`. */
  readonly evalGapCp: number;
  /** The solution continuation (principal variation) in UCI moves. */
  readonly solutionLine: readonly string[];
  /** Search depth the engine reached. */
  readonly depth: number;
  /** Difficulty derived from the gap and depth. */
  readonly difficulty: PuzzleDifficulty;
  /** Optional: natural-language puzzle prompt/theme/hint from the LLM.  `null` if no AI provider was supplied. */
  readonly theme: string | null;
  /** Optional: a short hint from the LLM.  `null` if no AI provider was supplied. */
  readonly hint: string | null;
  /** The provider id that served the LLM completion, or `null` if no AI provider was supplied. */
  readonly providerId: string | null;
  /** The model that served the completion, or `null` if no AI provider was supplied. */
  readonly model: string | null;
  /** Token usage from the LLM call, or `null` if no AI provider was supplied. */
  readonly usage: TokenUsage | null;
  /** Wall-clock latency of the LLM call in ms, or `null` if no AI provider was supplied. */
  readonly latencyMs: number | null;
}

/**
 * The position was analysed and does not contain a sharp enough puzzle.
 * The measured gap is returned so the caller can see why.
 */
export interface PuzzleRejection {
  /** Discriminator: always `'rejection'`. */
  readonly kind: 'rejection';
  /** FEN of the analysed position. */
  readonly fen: string;
  /** The eval gap in centipawns (best − second-best). */
  readonly evalGapCp: number;
  /** The threshold that was applied. */
  readonly threshold: number;
  /** Human-readable reason. */
  readonly reason: string;
  /** The best move the engine found (for context). */
  readonly bestMove: MoveUci;
  /** The engine's evaluation of the best line. */
  readonly bestEval: Evaluation;
  /** The engine's evaluation of the second-best line. */
  readonly secondBestEval: Evaluation;
  /** Search depth the engine reached. */
  readonly depth: number;
}

/** The result of puzzle generation: either a verified puzzle or a rejection. */
export type PuzzleResult = Puzzle | PuzzleRejection;
