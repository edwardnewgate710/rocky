/**
 * `EndgameTrainer` — M8 increment 5.
 *
 * Serves a training endgame, and — given a learner's attempted move —
 * evaluates it against the engine's solution and coaches.
 *
 * Two entry points:
 * - `nextPosition(request)` — select a training position from the
 *   `EndgameDatabase`, return it with its goal and the engine-verified
 *   solution.
 * - `evaluateAttempt(request)` — given the training position and the
 *   learner's move, use the engine to judge whether the move preserves
 *   the win/draw goal, and classify it (optimal / acceptable /
 *   throws_result).
 *
 * The dataset supplies the position and goal; the engine judges; the
 * LLM provides only the teaching narrative.  All correctness fields
 * come from the engine — the LLM never decides whether a move is
 * correct.
 *
 * Reuses two established patterns:
 * - Bundled-dataset port (like `OpeningDatabase` / `BundledOpeningDatabase`).
 * - Perspective-flip eval logic (like `MistakePredictor`): after the
 *   learner's move, the engine eval is from the opponent's perspective
 *   and must be negated to the mover's frame.
 *
 * Follows the exact architectural pattern established by the previous
 * four M8 increments.
 */

import type { AnalysisProvider, AnalysisRequest, EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { AiProvider, CompletionRequest, EngineGrounding } from '@chess-platform/ai-orchestrator';
import { engineResultsToGrounding, evalToString, buildGroundedMessages } from '@chess-platform/ai-orchestrator';
import { Position } from '@chess-platform/core';

import type { EndgameDatabase, EndgameEntry, EndgameGoal } from './endgame-database.js';
import type {
  NextPositionRequest, TrainingPosition, EngineSolution,
  EvaluateAttemptRequest, AttemptEvaluation, AttemptClassification,
} from './endgame-types.js';

// Reuse the perspective-flip logic from MistakePredictor.
import { negateEval } from './mistake-predictor.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for constructing an `EndgameTrainer`. */
export interface EndgameTrainerOptions {
  /** The endgame database port (training positions). */
  readonly database: EndgameDatabase;
  /** The chess engine analysis provider (M5 port). */
  readonly engine: AnalysisProvider;
  /** The AI completion provider (M7 port, optional narrative). */
  readonly ai?: AiProvider;
  /** Default analysis limits. */
  readonly defaultLimits?: AnalysisLimits;
  /** Default temperature for the LLM call. */
  readonly temperature?: number;
  /** Default max output tokens. */
  readonly maxTokens?: number;
  /** Threshold for "acceptable" vs "throws_result" classification (cp). Default: 50. */
  readonly acceptableThreshold?: number;
}

// ---------------------------------------------------------------------------
// EndgameTrainer
// ---------------------------------------------------------------------------

/**
 * Trains endgame technique with engine-verified feedback.
 */
export class EndgameTrainer {
  private readonly database: EndgameDatabase;
  private readonly engine: AnalysisProvider;
  private readonly ai: AiProvider | undefined;
  private readonly defaultLimits: AnalysisLimits;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly acceptableThreshold: number;

  constructor(options: EndgameTrainerOptions) {
    this.database = options.database;
    this.engine = options.engine;
    this.ai = options.ai;
    this.defaultLimits = options.defaultLimits ?? { depth: 25 };
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 512;
    this.acceptableThreshold = options.acceptableThreshold ?? 50;
  }

  /**
   * Select a training position and return it with the engine-verified solution.
   */
  async nextPosition(request: NextPositionRequest): Promise<TrainingPosition> {
    // 1. Select a training position from the database.
    let entry: EndgameEntry;
    if (request.id) {
      const found = this.database.getById(request.id);
      if (!found) throw new Error(`Endgame entry not found: ${request.id}`);
      entry = found;
    } else {
      entry = this.database.random({ type: request.type, difficulty: request.difficulty });
    }

    // 2. Get engine analysis of the position.
    const limits = request.limits ?? this.defaultLimits;
    let results: readonly EngineResult[];
    if (request.analysis && request.analysis.length > 0) {
      results = request.analysis;
    } else {
      const analysisRequest: AnalysisRequest = {
        fen: entry.fen,
        variant: 'chess',
        limits,
        multiPv: 1,
        signal: request.signal,
      };
      results = await this.engine.analyze(analysisRequest);
    }

    const best = results[0];
    const solution: EngineSolution = {
      bestMove: best.principalVariation[0] ?? '(none)',
      eval: best.evaluation,
      evalLabel: evalToString(best.evaluation),
      bestLine: best.principalVariation,
      depth: best.depth,
      mateDistance: best.evaluation.type === 'mate' ? best.evaluation.value : null,
    };

    // 3. Optionally generate LLM narrative.
    let narrative: string | null = null;
    let providerId: string | null = null;
    let model: string | null = null;
    let usage: import('@chess-platform/ai-orchestrator').TokenUsage | null = null;
    let latencyMs: number | null = null;

    if (this.ai) {
      const grounding: EngineGrounding = engineResultsToGrounding(
        entry.fen, results, undefined,
      );

      const goalDesc = formatGoal(entry.goal);
      const userContent = `This is an endgame training position: ${entry.name}. ` +
        `Goal: ${goalDesc}. Technique: ${entry.technique ?? 'N/A'}. ` +
        `FEN: ${entry.fen}. Engine eval: ${solution.evalLabel}. ` +
        `Provide a brief teaching narrative explaining the key ideas and the plan for the side to move.`;

      const messages = buildGroundedMessages(
        [{ role: 'user', content: userContent }],
        grounding,
      );

      const completionRequest: CompletionRequest = {
        task: 'general',
        messages,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        signal: request.signal,
        grounding,
      };

      const response = await this.ai.complete(completionRequest);
      narrative = response.content;
      providerId = response.providerId;
      model = response.model;
      usage = response.usage;
      latencyMs = response.latencyMs;
    }

    return {
      entry,
      fen: entry.fen,
      goal: entry.goal,
      solution,
      narrative,
      providerId,
      model,
      usage,
      latencyMs,
    };
  }

  /**
   * Evaluate a learner's attempted move against the engine's solution.
   *
   * Uses the exact perspective-flip logic pattern from MistakePredictor:
   * after the learner's move, the engine eval is from the opponent's
   * perspective and must be negated to the mover's frame.
   */
  async evaluateAttempt(request: EvaluateAttemptRequest): Promise<AttemptEvaluation> {
    const entry = request.entry;
    const limits = request.limits ?? this.defaultLimits;

    // 1. Analyse the original position.
    let resultsBefore: readonly EngineResult[];
    if (request.analysisBefore && request.analysisBefore.length > 0) {
      resultsBefore = request.analysisBefore;
    } else {
      const analysisRequest: AnalysisRequest = {
        fen: entry.fen,
        variant: 'chess',
        limits,
        multiPv: 1,
        signal: request.signal,
      };
      resultsBefore = await this.engine.analyze(analysisRequest);
    }

    const bestBefore = resultsBefore[0];
    const evalBefore = bestBefore.evaluation;
    const betterMove = bestBefore.principalVariation[0] ?? '(none)';
    const bestLine = bestBefore.principalVariation;
    const depth = bestBefore.depth;

    // 2. Apply the learner's move.
    const position = Position.fromFen(entry.fen);
    const positionAfter = position.play(request.move);
    const fenAfter = positionAfter.fen();

    // 3. Analyse the resulting position.
    let resultsAfter: readonly EngineResult[];
    if (request.analysisAfter && request.analysisAfter.length > 0) {
      resultsAfter = request.analysisAfter;
    } else {
      const analysisRequest: AnalysisRequest = {
        fen: fenAfter,
        variant: 'chess',
        limits,
        multiPv: 1,
        signal: request.signal,
      };
      resultsAfter = await this.engine.analyze(analysisRequest);
    }

    const bestAfter = resultsAfter[0];
    const evalAfterRaw = bestAfter.evaluation;

    // 4. Normalise evalAfter to the mover's perspective (perspective flip).
    const evalAfterMoverPerspective = negateEval(evalAfterRaw);

    // 5. Compute centipawn loss, on this feature's own terms.
    const centipawnLoss = legacyCpLoss(evalBefore, evalAfterMoverPerspective);

    // 6. Determine mate distance after the move (if applicable).
    let mateDistanceAfter: number | null = null;
    if (evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value > 0) {
      mateDistanceAfter = evalAfterMoverPerspective.value;
    }

    // 7. Classify the attempt and determine if the goal is preserved.
    const { classification, goalPreserved } = classifyAttempt(
      entry.goal,
      evalAfterMoverPerspective,
      centipawnLoss,
      this.acceptableThreshold,
    );

    // 8. Optionally generate LLM coaching.
    let coaching: string | null = null;
    let providerId: string | null = null;
    let model: string | null = null;
    let usage: import('@chess-platform/ai-orchestrator').TokenUsage | null = null;
    let latencyMs: number | null = null;

    if (this.ai) {
      const grounding: EngineGrounding = engineResultsToGrounding(
        entry.fen, resultsBefore, request.move,
      );

      const goalDesc = formatGoal(entry.goal);
      const userContent = `The learner played ${request.move} in the endgame "${entry.name}". ` +
        `Goal: ${goalDesc}. Classification: ${classification}. ` +
        `The move ${goalPreserved ? 'preserves' : 'does not preserve'} the goal. ` +
        `Engine eval before: ${evalToString(evalBefore)}, after: ${evalToString(evalAfterMoverPerspective)} (mover's perspective). ` +
        `Cp loss: ${centipawnLoss}. Better move: ${betterMove}. ` +
        `Provide a brief coaching explanation.`;

      const messages = buildGroundedMessages(
        [{ role: 'user', content: userContent }],
        grounding,
      );

      const completionRequest: CompletionRequest = {
        task: 'general',
        messages,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        signal: request.signal,
        grounding,
      };

      const response = await this.ai.complete(completionRequest);
      coaching = response.content;
      providerId = response.providerId;
      model = response.model;
      usage = response.usage;
      latencyMs = response.latencyMs;
    }

    return {
      entry,
      move: request.move,
      fenAfter,
      classification,
      goalPreserved,
      evalBefore,
      evalBeforeLabel: evalToString(evalBefore),
      evalAfterMoverPerspective,
      evalAfterLabel: evalToString(evalAfterMoverPerspective),
      centipawnLoss,
      betterMove,
      bestLine,
      depth,
      mateDistanceAfter,
      coaching,
      providerId,
      model,
      usage,
      latencyMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * The centipawn loss, on the terms this feature has always used.
 *
 * A verbatim copy of `evalToCpLoss` as it stood before M15 increment 5, kept here rather than shared,
 * and that is the point. The shared version now applies a rule this one does not: **"already lost"
 * outranks "walked into mate"**, because Mistake Prediction measures what a *move* cost and a player
 * who was being forcibly mated before it lost nothing by it. That rule is right for assessing a move
 * and wrong for grading an endgame attempt, where converting mate-in-2-against-you into
 * mate-in-1-against-you is precisely the technique failure the exercise is testing.
 *
 * An earlier draft of this increment routed this call through the shared helper and claimed in a
 * comment to preserve the old value exactly. It did not: that case flipped from `Infinity`
 * (`throws_result`) to `0` (`optimal`) — a silent behaviour change to a feature this increment does
 * not touch, hidden behind a comment saying nothing had changed. Raised in the Qodo review of
 * PR #136.
 *
 * `Infinity` is retained deliberately: `AttemptEvaluation.centipawnLoss` is a plain number and no
 * caller serialises it. Giving this feature the nullable contract belongs with productionising it.
 */
function legacyCpLoss(evalBefore: Evaluation, evalAfterMoverPerspective: Evaluation): number {
  if (evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value < 0) {
    return Infinity;
  }
  if (
    evalBefore.type === 'mate' &&
    evalBefore.value > 0 &&
    evalAfterMoverPerspective.type !== 'mate'
  ) {
    return Infinity;
  }
  if (
    evalBefore.type === 'mate' &&
    evalBefore.value > 0 &&
    evalAfterMoverPerspective.type === 'mate' &&
    evalAfterMoverPerspective.value > 0
  ) {
    return 0;
  }
  if (evalBefore.type === 'cp' && evalAfterMoverPerspective.type === 'cp') {
    return evalBefore.value - evalAfterMoverPerspective.value;
  }
  return 0;
}

/** Format an endgame goal as a human-readable string. */
function formatGoal(goal: EndgameGoal): string {
  switch (goal.kind) {
    case 'mate': return `Mate in ${goal.distance}`;
    case 'win': return `Win: ${goal.description}`;
    case 'draw': return `Draw: ${goal.description}`;
  }
}

/**
 * Classify a learner's attempt based on the goal, evals, and cp loss.
 *
 * - `optimal`: the move matches the engine's best (cp loss ≈ 0, or both
 *   still mate with same/faster distance).
 * - `acceptable`: the move preserves the goal but with some cp loss.
 * - `throws_result`: the move throws away the win or draw.
 */
export function classifyAttempt(
  goal: EndgameGoal,
  evalAfterMoverPerspective: Evaluation,
  centipawnLoss: number,
  acceptableThreshold: number,
): { classification: AttemptClassification; goalPreserved: boolean } {
  // Determine if the goal is preserved based on the goal type.
  let goalPreserved: boolean;

  if (goal.kind === 'mate') {
    // For a mate goal: the goal is preserved if the mover is still winning
    // (mate or large positive eval).
    if (evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value > 0) {
      // Still mate — goal preserved.
      goalPreserved = true;
    } else if (evalAfterMoverPerspective.type === 'cp' && evalAfterMoverPerspective.value > 500) {
      // Still winning by a large margin — goal likely preserved.
      goalPreserved = true;
    } else {
      // No longer clearly winning — goal lost.
      goalPreserved = false;
    }
  } else if (goal.kind === 'win') {
    // For a win goal: preserved if still winning (positive eval, mate, or
    // large cp advantage).
    if (evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value > 0) {
      goalPreserved = true;
    } else if (evalAfterMoverPerspective.type === 'cp' && evalAfterMoverPerspective.value > 100) {
      goalPreserved = true;
    } else {
      goalPreserved = false;
    }
  } else {
    // For a draw goal: preserved if the position is still drawn or better
    // (eval near zero or positive for the defender).
    if (evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value > 0) {
      // Winning — goal (draw) is preserved (actually exceeded).
      goalPreserved = true;
    } else if (evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value < 0) {
      // Getting mated — goal lost.
      goalPreserved = false;
    } else if (evalAfterMoverPerspective.type === 'cp') {
      // Drawn or better if eval >= -100 (small disadvantage is still drawable).
      goalPreserved = evalAfterMoverPerspective.value >= -100;
    } else {
      goalPreserved = false;
    }
  }

  // Classify.
  if (!goalPreserved) {
    return { classification: 'throws_result', goalPreserved: false };
  }

  // Goal preserved — is the move optimal or just acceptable?
  if (centipawnLoss <= 0) {
    return { classification: 'optimal', goalPreserved: true };
  }
  if (centipawnLoss <= acceptableThreshold) {
    return { classification: 'acceptable', goalPreserved: true };
  }
  // Large cp loss but goal still preserved — still throws_result
  // (the move is bad even if the goal is technically still achievable).
  // Actually, if the goal is preserved, we should classify as acceptable
  // even with large cp loss, because the pedagogical point is whether
  // the goal is maintained.  But a very large loss suggests the move
  // makes the task much harder.  Let's use throws_result for large losses
  // even if the goal is technically still preserved, since the learner
  // made the position much harder.
  if (centipawnLoss >= 300) {
    return { classification: 'throws_result', goalPreserved: true };
  }
  return { classification: 'acceptable', goalPreserved: true };
}
