/**
 * The `StudySessionStore` port and session state types.
 *
 * Session state lives behind a port, not in a live database.  The
 * default `InMemoryStudySessionStore` keeps sessions in a Map; a durable
 * adapter can implement the same port later without touching the
 * feature.
 *
 * Session state is explicit and serializable: a session is a plain data
 * object (id, topic, turns, progress metrics) that the store persists.
 * No hidden mutable state on the class instance.
 */

import type { MistakeClassification } from './mistake-types.js';
import type { CoachingResponse } from './coach-types.js';
import type { MoveUci } from './types.js';

// ---------------------------------------------------------------------------
// Session state (serializable plain data)
// ---------------------------------------------------------------------------

/** A single turn in a study session. */
export interface StudyTurn {
  /** Turn number (1-indexed). */
  readonly turnNumber: number;
  /** FEN of the position for this turn. */
  readonly fen: string;
  /** The learner's move (UCI), or null if no move was submitted. */
  readonly move: MoveUci | null;
  /** The coaching response from the Coach for this turn. */
  readonly coaching: CoachingResponse;
  /** The mistake classification from the MistakePredictor (if a move was played). */
  readonly mistakeClassification: MistakeClassification | null;
  /** Timestamp (ISO string). */
  readonly timestamp: string;
}

/** Running progress metrics for a session. */
export interface SessionProgress {
  /** Total number of turns completed. */
  readonly turnsCompleted: number;
  /** Number of moves classified as 'ok'. */
  readonly okCount: number;
  /** Number of moves classified as 'inaccuracy'. */
  readonly inaccuracyCount: number;
  /** Number of moves classified as 'mistake'. */
  readonly mistakeCount: number;
  /** Number of moves classified as 'blunder'. */
  readonly blunderCount: number;
  /** Number of turns where no move was submitted (position-only). */
  readonly noMoveCount: number;
  /** Accuracy: (okCount + 0.5 * inaccuracyCount) / turnsWithMoves, or 1.0 if no moves. */
  readonly accuracy: number;
  /** Features fired across all turns (union). */
  readonly featuresUsed: readonly string[];
  /** Topics covered (from opening names, endgame types, puzzle themes). */
  readonly topicsCovered: readonly string[];
}

/** The lifecycle status of a session. */
export type SessionStatus = 'active' | 'completed';

/** A complete study session (serializable plain data). */
export interface StudySession {
  /** Unique session identifier. */
  readonly id: string;
  /** The learning topic or goal. */
  readonly topic: string;
  /** Optional difficulty level. */
  readonly difficulty: string | null;
  /** Session status. */
  readonly status: SessionStatus;
  /** The sequence of turns. */
  readonly turns: readonly StudyTurn[];
  /** Current progress metrics. */
  readonly progress: SessionProgress;
  /** The current position FEN the learner should work on (next step). */
  readonly currentFen: string | null;
  /** Creation timestamp (ISO string). */
  readonly createdAt: string;
  /** Completion timestamp (ISO string), or null if active. */
  readonly completedAt: string | null;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/**
 * The study session store port.  Persists sessions by id.
 *
 * Implementations:
 * - `InMemoryStudySessionStore` — in-process Map (default, hermetic).
 * - Future: durable adapter (Postgres, Redis, etc.).
 */
export interface StudySessionStore {
  /** Create a new session. */
  create(session: StudySession): Promise<void>;
  /** Load a session by id.  Returns `undefined` if not found. */
  load(id: string): Promise<StudySession | undefined>;
  /** Save (update) an existing session. */
  save(session: StudySession): Promise<void>;
  /** Delete a session. */
  delete(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryStudySessionStore
// ---------------------------------------------------------------------------

/**
 * Default `StudySessionStore` implementation.  Keeps sessions in an
 * in-process Map.  Fully hermetic — no DB, no network.
 */
export class InMemoryStudySessionStore implements StudySessionStore {
  private readonly sessions = new Map<string, StudySession>();

  async create(session: StudySession): Promise<void> {
    if (this.sessions.has(session.id)) {
      throw new Error(`Session already exists: ${session.id}`);
    }
    this.sessions.set(session.id, session);
  }

  async load(id: string): Promise<StudySession | undefined> {
    return this.sessions.get(id);
  }

  async save(session: StudySession): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  /** Number of sessions in the store (for testing). */
  get size(): number {
    return this.sessions.size;
  }
}
