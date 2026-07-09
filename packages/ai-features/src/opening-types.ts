/**
 * Request and response types for the `OpeningExplorer` feature.
 */

import type { EngineResult, Evaluation, AnalysisLimits } from '@chess-platform/engine';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';

import type { MoveUci } from './types.js';
import type { OpeningEntry, OpeningContinuation, OpeningStats } from './opening-database.js';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Request for opening exploration.
 *
 * The caller supplies a move sequence (UCI) from the start position.
 * The explorer walks the moves against the `OpeningDatabase` port,
 * identifies the deepest matching opening, and returns a structured
 * result.
 */
export interface ExploreRequest {
  /** The move sequence from the start position, in UCI (e.g. `['e2e4', 'e7e5']`). */
  readonly moves: readonly MoveUci[];
  /** Engine search limits (used only for optional engine enrichment). */
  readonly limits?: AnalysisLimits;
  /** Pre-computed engine analysis of the current position (optional enrichment). */
  readonly analysis?: readonly EngineResult[];
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * The result of opening exploration.
 *
 * If a known opening is found, the `opening` field carries the ECO code,
 * name, continuations, and stats from the `OpeningDatabase` port.  If no
 * known opening matches, `opening` is `null` and the result clearly
 * indicates "no known opening" — never a fabricated one.
 *
 * Optional engine enrichment (eval of the current position) is included
 * if an `AnalysisProvider` was supplied.
 *
 * Optional LLM narrative is included if an `AiProvider` was supplied.
 */
export interface ExplorationResult {
  /** The move sequence that was explored, in UCI. */
  readonly moves: readonly MoveUci[];
  /** FEN of the current position (after the move sequence). */
  readonly fen: string;
  /** Whether a known opening was identified. */
  readonly found: boolean;
  /** The identified opening entry, or `null` if no known opening matches. */
  readonly opening: OpeningEntry | null;
  /** ECO code of the identified opening, or `null` if not found. */
  readonly eco: string | null;
  /** Name of the identified opening, or `null` if not found. */
  readonly name: string | null;
  /** Main continuations from the current position (from the DB), or empty if not found. */
  readonly continuations: readonly OpeningContinuation[];
  /** Aggregate stats for the opening, or `null` if not available. */
  readonly stats: OpeningStats | null;
  /** How many of the input moves matched the opening line. 0 if not found. */
  readonly matchedMoves: number;
  /** Whether the game has diverged from the opening line. */
  readonly outOfBook: boolean;
  /** Optional: engine eval of the current position (if enrichment was supplied). */
  readonly engineEval: Evaluation | null;
  /** Optional: human-readable engine eval label. */
  readonly engineEvalLabel: string | null;
  /** Optional: the engine's best move from the current position. */
  readonly engineBestMove: MoveUci | null;
  /** Search depth the engine reached (if enrichment was supplied). */
  readonly engineDepth: number | null;
  /** Optional: natural-language narrative from the LLM.  `null` if no AI provider was supplied. */
  readonly narrative: string | null;
  /** The provider id that served the LLM completion, or `null`. */
  readonly providerId: string | null;
  /** The model that served the completion, or `null`. */
  readonly model: string | null;
  /** Token usage from the LLM call, or `null`. */
  readonly usage: TokenUsage | null;
  /** Wall-clock latency of the LLM call in ms, or `null`. */
  readonly latencyMs: number | null;
}
