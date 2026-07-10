/**
 * Types for the `VoiceCoach` feature (M8 increment 8).
 *
 * The Voice Coach turns a `CoachingResponse` into speech-ready output.
 * Its real, tested contribution is the **verbalization logic**: converting
 * coaching output and chess moves into natural spoken English.
 *
 * Chess notation read literally is gibberish aloud.  The Voice Coach
 * produces an ordered list of short, clearly segmented spoken phrases
 * that a speech synthesizer can pace naturally.
 */

import type { CoachingResponse, CoachRequest } from './coach-types.js';
import type { Coach } from './coach.js';
import type { AiProvider } from '@chess-platform/ai-orchestrator';
import type {
  SpeechSynthesizer,
  SpeechRecognizer,
} from './speech-ports.js';

// ---------------------------------------------------------------------------
// Spoken output
// ---------------------------------------------------------------------------

/**
 * A single spoken segment — a short natural-language string ready for TTS.
 *
 * Each segment is self-contained and short enough for a synthesizer to
 * pace naturally.  The `kind` field lets the caller (or a real TTS
 * adapter) apply per-segment prosody if desired.
 */
export interface SpokenSegment {
  /** Segment kind — drives optional prosody in a real adapter. */
  readonly kind: SpokenSegmentKind;
  /** The spoken text, in natural English (not raw notation). */
  readonly text: string;
}

/**
 * Kinds of spoken segments.  A real TTS adapter can use these to apply
 * different voices or pacing (e.g. a slower `assessment`, a quicker
 * `move`).
 */
export type SpokenSegmentKind =
  | 'greeting'
  | 'assessment'
  | 'move'
  | 'better-move'
  | 'opening'
  | 'puzzle'
  | 'endgame'
  | 'narrative'
  | 'closing';

/**
 * The result of verbalizing a coaching response.
 *
 * `segments` is an ordered list of short spoken phrases; `coaching` is
 * the underlying `CoachingResponse` for traceability.  The caller can
 * feed `segments` to a `SpeechSynthesizer` one-by-one.
 */
export interface SpokenCoaching {
  /** Ordered list of spoken segments, ready for TTS. */
  readonly segments: readonly SpokenSegment[];
  /** The underlying coaching response (for traceability). */
  readonly coaching: CoachingResponse;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Request for `VoiceCoach.coachAloud`.
 *
 * This is the same as `CoachRequest` — the Voice Coach runs the Coach
 * and then verbalizes the result.  Re-exported for convenience.
 */
export type CoachAloudRequest = CoachRequest;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for constructing a `VoiceCoach`. */
export interface VoiceCoachOptions {
  /** The Coach (composition layer over the five features). */
  readonly coach: Coach;
  /** Optional: speech synthesizer port (for `speak` convenience method). */
  readonly synthesizer?: SpeechSynthesizer;
  /** Optional: speech recognizer port (for `listen` convenience method). */
  readonly recognizer?: SpeechRecognizer;
  /** Optional: AI provider for narrative smoothing (if omitted, engine facts only). */
  readonly ai?: AiProvider;
  /** Default temperature for the LLM call. */
  readonly temperature?: number;
  /** Default max output tokens. */
  readonly maxTokens?: number;
}

// Re-export the speech ports so callers only need this package.
export type {
  SpeechSynthesizer,
  SpeechRecognizer,
  SynthesizeRequest,
  SynthesizeResult,
  RecognizeRequest,
  RecognizeResult,
  VoiceCommand,
} from './speech-ports.js';

// Re-export Coach types for convenience.
export type { CoachRequest, CoachingResponse } from './coach-types.js';
