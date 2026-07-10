/**
 * Request and response types for the `StudyPartner` feature.
 */

import type { StudySession, SessionProgress } from './study-session-store.js';
import type { CoachingResponse } from './coach-types.js';
import type { MoveUci } from './types.js';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';

// ---------------------------------------------------------------------------
// startSession
// ---------------------------------------------------------------------------

/** Request to start a new study session. */
export interface StartSessionRequest {
  /** The learning topic or goal (e.g. "endgames", "tactics", "openings"). */
  readonly topic: string;
  /** Optional difficulty level. */
  readonly difficulty?: string;
  /** The first position (FEN) to work on.  If omitted, the starting position is used. */
  readonly initialFen?: string;
}

/** Response from `startSession`. */
export interface StartSessionResponse {
  /** The created session. */
  readonly session: StudySession;
  /** The first position (FEN) to work on. */
  readonly currentFen: string;
  /** Optional: introductory narrative from the LLM.  `null` if no AI provider. */
  readonly narrative: string | null;
}

// ---------------------------------------------------------------------------
// submitTurn
// ---------------------------------------------------------------------------

/** Request to submit a turn in a study session. */
export interface SubmitTurnRequest {
  /** The session id. */
  readonly sessionId: string;
  /** FEN of the current position. */
  readonly fen: string;
  /** The learner's move (UCI), or null if no move (position-only analysis). */
  readonly move?: MoveUci;
  /** Optional: the game's move sequence (for opening identification). */
  readonly moves?: readonly MoveUci[];
  /** The next position (FEN) to work on after this turn.  If omitted, no next step. */
  readonly nextFen?: string;
}

/** Response from `submitTurn`. */
export interface SubmitTurnResponse {
  /** The updated session. */
  readonly session: StudySession;
  /** The coaching response for this turn. */
  readonly coaching: CoachingResponse;
  /** Updated progress metrics. */
  readonly progress: SessionProgress;
  /** The next position to work on, or null if the session has no next step. */
  readonly nextFen: string | null;
  /** Optional: coaching narrative from the LLM.  `null` if no AI provider. */
  readonly narrative: string | null;
}

// ---------------------------------------------------------------------------
// endSession
// ---------------------------------------------------------------------------

/** Request to end a study session. */
export interface EndSessionRequest {
  /** The session id. */
  readonly sessionId: string;
}

/** Response from `endSession`. */
export interface EndSessionResponse {
  /** The completed session. */
  readonly session: StudySession;
  /** Final progress metrics. */
  readonly progress: SessionProgress;
  /** Summary of what was covered. */
  readonly summary: SessionSummary;
  /** Optional: synthesized narrative from the LLM.  `null` if no AI provider. */
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

/** A summary of a completed session. */
export interface SessionSummary {
  /** Total turns completed. */
  readonly totalTurns: number;
  /** Accuracy (0–1). */
  readonly accuracy: number;
  /** Breakdown of mistake classifications. */
  readonly classificationCounts: {
    readonly ok: number;
    readonly inaccuracy: number;
    readonly mistake: number;
    readonly blunder: number;
  };
  /** Topics covered. */
  readonly topicsCovered: readonly string[];
  /** Features used. */
  readonly featuresUsed: readonly string[];
  /** Recommended next focus (derived from the session data). */
  readonly recommendedNextFocus: string;
}
