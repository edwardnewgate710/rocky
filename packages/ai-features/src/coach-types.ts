/**
 * Request and response types for the `Coach` feature (M8 increment 6).
 *
 * The Coach is a composition layer: it calls the five existing feature
 * classes and aggregates their structured outputs into one unified
 * coaching response.  Every fact in the response is traceable to a
 * feature's engine-verified output.
 */

import type { MistakeVerdict } from './mistake-types.js';
import type { MoveExplanationResponse } from './types.js';
import type { ExplorationResult } from './opening-types.js';
import type { PuzzleResult } from './puzzle-types.js';
import type { TrainingPosition } from './endgame-types.js';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';
import type { MoveUci } from './types.js';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Request for coaching.
 *
 * The caller supplies a position (FEN) and optionally a move the player
 * just made (or is considering).  The Coach decides which features are
 * relevant and aggregates their results.
 *
 * If `moves` is supplied (the game's move sequence from the start), the
 * Coach can run the OpeningExplorer.  If only `fen` is supplied, the
 * opening explorer is skipped (no move sequence to look up).
 */
export interface CoachRequest {
  /** FEN of the current position. */
  readonly fen: string;
  /** Optional: the move the player just made or is considering (UCI). */
  readonly move?: MoveUci;
  /** Optional: the game's move sequence from the start (for opening identification). */
  readonly moves?: readonly MoveUci[];
  /** Optional: pre-computed engine analysis of the position (for features that need it). */
  readonly analysis?: readonly import('@chess-platform/engine').EngineResult[];
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * The unified coaching response.
 *
 * Each section is `null` when the corresponding feature reported "not
 * applicable" — the Coach never fabricates a lesson.  The `featuresFired`
 * array lists which features produced a result.
 */
export interface CoachingResponse {
  /** FEN of the position. */
  readonly fen: string;
  /** The move that was evaluated, or `null` if no move was supplied. */
  readonly move: MoveUci | null;
  /** Which features produced a non-null result. */
  readonly featuresFired: readonly string[];
  /** MistakePredictor verdict, or `null` if no move was supplied or the feature was not applicable. */
  readonly mistakeVerdict: MistakeVerdict | null;
  /** MoveExplainer explanation of the best move, or `null` if no move was supplied. */
  readonly moveExplanation: MoveExplanationResponse | null;
  /** OpeningExplorer result, or `null` if no move sequence was supplied or no opening was found. */
  readonly opening: ExplorationResult | null;
  /** PuzzleGenerator result (Puzzle if sharp, PuzzleRejection if not), or `null` if not run. */
  readonly puzzle: PuzzleResult | null;
  /** EndgameTrainer training position, or `null` if the position is not a recognized endgame. */
  readonly endgame: TrainingPosition | null;
  /** Optional: synthesized narrative from the LLM tying the results together.  `null` if no AI provider. */
  readonly narrative: string | null;
  /** Provider id, or `null`. */
  readonly providerId: string | null;
  /** Model, or `null`. */
  readonly model: string | null;
  /** Token usage, or `null`. */
  readonly usage: TokenUsage | null;
  /** Latency in ms, or `null`. */
  readonly latencyMs: number | null;
}
