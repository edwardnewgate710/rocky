/**
 * Request and response types for the `EndgameTrainer` feature.
 */

import type { EngineResult, Evaluation, AnalysisLimits } from '@chess-platform/engine';
import type { TokenUsage } from '@chess-platform/ai-orchestrator';

import type { MoveUci } from './types.js';
import type { EndgameEntry, EndgameGoal, EndgameType, EndgameDifficulty } from './endgame-database.js';

// ---------------------------------------------------------------------------
// nextPosition
// ---------------------------------------------------------------------------

/** Request for selecting a training position. */
export interface NextPositionRequest {
  /** Filter by endgame type (optional). */
  readonly type?: EndgameType;
  /** Filter by difficulty (optional). */
  readonly difficulty?: EndgameDifficulty;
  /** Specific entry id (optional — overrides filters). */
  readonly id?: string;
  /** Engine search limits (for computing the solution). */
  readonly limits?: AnalysisLimits;
  /** Pre-computed engine analysis of the training position (optional). */
  readonly analysis?: readonly EngineResult[];
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/** Classification of the engine's solution relative to the goal. */
export interface EngineSolution {
  /** The engine's best move in UCI. */
  readonly bestMove: MoveUci;
  /** The engine's evaluation of the position. */
  readonly eval: Evaluation;
  /** Human-readable eval label. */
  readonly evalLabel: string;
  /** The engine's principal variation. */
  readonly bestLine: readonly string[];
  /** Search depth. */
  readonly depth: number;
  /** If the goal is mate, the engine's mate distance (if found). */
  readonly mateDistance: number | null;
}

/** Response from `nextPosition`. */
export interface TrainingPosition {
  /** The selected training endgame entry. */
  readonly entry: EndgameEntry;
  /** FEN of the training position. */
  readonly fen: string;
  /** The learning goal. */
  readonly goal: EndgameGoal;
  /** The engine-verified solution. */
  readonly solution: EngineSolution;
  /** Optional: teaching narrative from the LLM.  `null` if no AI provider. */
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

// ---------------------------------------------------------------------------
// evaluateAttempt
// ---------------------------------------------------------------------------

/** Request for evaluating a learner's move. */
export interface EvaluateAttemptRequest {
  /** The training endgame entry. */
  readonly entry: EndgameEntry;
  /** The learner's move in UCI. */
  readonly move: MoveUci;
  /** Engine search limits. */
  readonly limits?: AnalysisLimits;
  /** Pre-computed analysis of the original position (optional). */
  readonly analysisBefore?: readonly EngineResult[];
  /** Pre-computed analysis of the position after the move (optional). */
  readonly analysisAfter?: readonly EngineResult[];
  /** Cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/** Classification of the learner's attempt. */
export type AttemptClassification =
  | 'optimal'       // the move matches the engine's best move (or is equally good)
  | 'acceptable'    // the move preserves the goal but is not optimal
  | 'throws_result'; // the move throws away the win or draw

/** Response from `evaluateAttempt`. */
export interface AttemptEvaluation {
  /** The training endgame entry. */
  readonly entry: EndgameEntry;
  /** The learner's move. */
  readonly move: MoveUci;
  /** FEN after the learner's move. */
  readonly fenAfter: string;
  /** Classification of the attempt. */
  readonly classification: AttemptClassification;
  /** Whether the goal is still preserved after this move. */
  readonly goalPreserved: boolean;
  /** Eval of the original position (mover's perspective). */
  readonly evalBefore: Evaluation;
  readonly evalBeforeLabel: string;
  /** Eval of the position after the move (mover's perspective, negated). */
  readonly evalAfterMoverPerspective: Evaluation;
  readonly evalAfterLabel: string;
  /** Centipawn loss caused by the move. */
  readonly centipawnLoss: number;
  /** The engine's best move (what the learner should have played). */
  readonly betterMove: MoveUci;
  /** The engine's best line from the original position. */
  readonly bestLine: readonly string[];
  /** Search depth. */
  readonly depth: number;
  /** If the goal was mate, whether the move still leads to mate (and distance). */
  readonly mateDistanceAfter: number | null;
  /** Optional: coaching text from the LLM.  `null` if no AI provider. */
  readonly coaching: string | null;
  /** Provider id, or `null`. */
  readonly providerId: string | null;
  /** Model, or `null`. */
  readonly model: string | null;
  /** Token usage, or `null`. */
  readonly usage: TokenUsage | null;
  /** Latency in ms, or `null`. */
  readonly latencyMs: number | null;
}
