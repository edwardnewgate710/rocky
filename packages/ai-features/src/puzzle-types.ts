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
  /** Chess variant in the platform vocabulary (defaults to `standard`). */
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
   * runs the injected `AnalysisProvider` to obtain it. Supply `multiPv`
   * as well when every requested rank must be present (the production path does).
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
 * Why the first engine line is meaningfully better than the comparison line.
 *
 * Centipawn and mate scores do not share a numeric scale. Keeping them as a tagged union makes it
 * impossible for a caller to serialise `Infinity` as a stand-in for "mate beats a finite score".
 */
export type PuzzleEvidence =
  | { readonly kind: 'centipawn_gap'; readonly gapCp: number }
  | {
      readonly kind: 'mate';
      readonly relation: 'forces_mate' | 'avoids_mate' | 'faster_mate' | 'delays_mate';
      /** Difference in mate distance when both lines are mate scores; otherwise `null`. */
      readonly distanceGap: number | null;
    };

/** An engine response that cannot establish either a puzzle or a trustworthy rejection. */
export type PuzzleInsufficientReason =
  | 'not_enough_lines'
  | 'missing_best_line'
  | 'missing_comparison_line'
  | 'missing_best_move'
  | 'missing_comparison_move'
  | 'invalid_best_move'
  | 'invalid_comparison_move'
  | 'invalid_solution_line'
  | 'duplicate_moves'
  | 'bounded_evaluation'
  | 'non_finite_evaluation'
  /** The reported depth is not an integer, including fractional and non-finite values. */
  | 'non_finite_depth'
  | 'incomplete_depth'
  | 'mismatched_depth'
  | 'incomplete_multipv'
  | 'unordered_lines';

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
  /** The runner-up move used to establish that the solution is unique enough. */
  readonly comparisonMove: MoveUci;
  /** The engine's evaluation of the best line. */
  readonly bestEval: Evaluation;
  /** Human-readable eval label (e.g. `+3.50` or `mate in 3`). */
  readonly bestEvalLabel: string;
  /** The engine's evaluation of the second-best line. */
  readonly secondBestEval: Evaluation;
  /** Human-readable eval label for the second-best line. */
  readonly secondBestEvalLabel: string;
  /** Tagged, JSON-safe evidence that distinguishes centipawn and mate comparisons. */
  readonly evidence: PuzzleEvidence;
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
  /** Tagged, JSON-safe evidence supporting the no-puzzle conclusion. */
  readonly evidence: PuzzleEvidence;
  /** The centipawn threshold applied to centipawn evidence. */
  readonly thresholdCp: number;
  /** Stable reason suitable for callers; no prose parsing required. */
  readonly reason: 'gap_below_threshold' | 'mate_not_unique';
  /** The best move the engine found (for context). */
  readonly bestMove: MoveUci;
  /** The comparison move that made the tactic insufficiently unique. */
  readonly comparisonMove: MoveUci;
  /** The engine's evaluation of the best line. */
  readonly bestEval: Evaluation;
  /** The engine's evaluation of the second-best line. */
  readonly secondBestEval: Evaluation;
  /** Search depth the engine reached. */
  readonly depth: number;
}

/**
 * The engine did not return enough trustworthy evidence to decide whether a tactic exists.
 *
 * This is deliberately distinct from {@link PuzzleRejection}: "not proven" is not "no tactic".
 * Moves are nullable here because their absence is part of the evidence failure being reported.
 */
export interface PuzzleInsufficientEvidence {
  readonly kind: 'insufficient';
  readonly fen: string;
  readonly reason: PuzzleInsufficientReason;
  readonly bestMove: MoveUci | null;
  readonly comparisonMove: MoveUci | null;
}

/** A verified puzzle, a supported no-puzzle conclusion, or explicitly insufficient evidence. */
export type PuzzleResult = Puzzle | PuzzleRejection | PuzzleInsufficientEvidence;
