/**
 * Request and response types for the `TournamentCommentator` feature.
 *
 * This feature provides two modes of commentary:
 * 1. Moment commentary (engine-grounded) — explains a specific board position
 *    and move with live broadcast flair, citing the engine eval.
 * 2. Round recap (data-grounded) — provides a narrative summary of a round
 *    based purely on structured match results and standings.
 */

import type { EngineResult, AnalysisLimits } from '@chess-platform/engine';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';
import type { EngineCitation, MoveUci } from './types.js';

/**
 * Contextual information about the tournament for live commentary.
 */
export interface TournamentMomentContext {
  /** The name or handle of the player with the white pieces. */
  readonly whitePlayer: string;
  /** The name or handle of the player with the black pieces. */
  readonly blackPlayer: string;
  /** Optional round number or identifier. */
  readonly round?: string | number;
  /** Optional name of the tournament/event. */
  readonly event?: string;
  /** Optional description of what's at stake in this game. */
  readonly stakes?: string;
}

/**
 * Request for moment-by-moment live broadcast commentary.
 */
export interface MomentCommentaryRequest {
  /** FEN of the position to commentate on. */
  readonly fen: string;
  /** Optional: The move that was just played or is being considered, in UCI long algebraic notation (e.g. `e2e4`). */
  readonly lastMove?: MoveUci;
  /** Chess variant (defaults to `chess`). */
  readonly variant?: string;
  /** Optional pre-computed engine analysis. If omitted, the engine will be run. */
  readonly analysis?: readonly EngineResult[];
  /** Optional limits for engine analysis (used if `analysis` is not provided). */
  readonly limits?: AnalysisLimits;
  /** Cooperative cancellation signal. */
  readonly signal?: AbortSignal;
  /** Context about the tournament and players. */
  readonly context: TournamentMomentContext;
}

/**
 * The commentary response for a specific moment.
 */
export interface MomentCommentaryResponse {
  /** Natural-language broadcast-style commentary of the moment. */
  readonly commentary: string;
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

/**
 * A single structured match result in a tournament round.
 */
export interface MatchResultData {
  /** The name or handle of the player with the white pieces. */
  readonly white: string;
  /** The name or handle of the player with the black pieces. */
  readonly black: string;
  /** The result of the match. */
  readonly result: '1-0' | '0-1' | '1/2-1/2';
}

/**
 * A single player's standing in a tournament.
 */
export interface StandingData {
  /** The current rank of the player (1-based). */
  readonly rank: number;
  /** The name or handle of the player. */
  readonly player: string;
  /** The points the player has accumulated. */
  readonly points: number;
}

/**
 * Request for a narrative recap of a completed tournament round.
 */
export interface RoundRecapRequest {
  /** Optional name of the tournament/event. */
  readonly event?: string;
  /** The round number or identifier. */
  readonly round: string | number;
  /** The structured results of the matches in this round. */
  readonly results: readonly MatchResultData[];
  /** The structured current standings of the tournament. */
  readonly standings: readonly StandingData[];
  /** Cooperative cancellation signal. */
  readonly signal?: AbortSignal;
}

/**
 * The narrative round recap response.
 */
export interface RoundRecapResponse {
  /** Natural-language narrative summary of the round. */
  readonly recap: string;
  /** The provider id that served the LLM completion. */
  readonly providerId: string;
  /** The model that served the completion. */
  readonly model: string;
  /** Token usage from the LLM call. */
  readonly usage: TokenUsage;
  /** Wall-clock latency of the LLM call in ms. */
  readonly latencyMs: number;
}
