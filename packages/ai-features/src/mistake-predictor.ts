/**
 * `MistakePredictor` — M8 increment 3.
 *
 * Given a position (FEN) and a **candidate move the player is
 * considering**, determines whether that move is a mistake and how
 * severe.
 *
 * The severity of a move is the eval loss it causes versus best play:
 *
 * 1. Analyse the original position → `evalBefore` (best play for the
 *    side to move).
 * 2. Apply the candidate move with `@chess-platform/core`'s
 *    `Position.play()` to get the resulting FEN.
 * 3. Analyse the resulting position → `evalAfter` (from the
 *    **opponent's** perspective, since it is now their turn).
 * 4. Normalise: `evalAfterMoverPerspective = negate(evalAfter)`.
 * 5. `centipawnLoss = evalBefore − evalAfterMoverPerspective`.
 * 6. Classify: inaccuracy ≥ 50 cp, mistake ≥ 100 cp, blunder ≥ 300 cp
 *    (configurable).  A move that walks into a forced mate is always a
 *    blunder.
 *
 * This makes mistake classification an objective, testable engine fact
 * — the LLM never decides whether a move is a mistake.
 *
 * The AI provider's role is **only** the human-facing coaching text,
 * generated from the engine facts via the M7 grounding path.  If no AI
 * provider is supplied, the predictor returns a fully valid verdict
 * with all engine fields and no LLM text — the LLM is additive, never
 * load-bearing.
 *
 * This follows the exact architectural pattern established by
 * `MoveExplainer` (M8 increment 1) and `PuzzleGenerator` (M8 increment
 * 2): ports injected, engine-verified structured fields, hermetic tests
 * with fakes.
 */

import type { AnalysisProvider, AnalysisRequest, EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { AiProvider, CompletionRequest, EngineGrounding } from '@chess-platform/ai-orchestrator';
import { engineResultsToGrounding, evalToString, buildGroundedMessages } from '@chess-platform/ai-orchestrator';
import { Position } from '@chess-platform/core';

import type { PredictRequest, MistakeVerdict, MistakeClassification } from './mistake-types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default inaccuracy threshold: 50 cp = 0.50 pawns. */
export const DEFAULT_INACCURACY_THRESHOLD = 50;

/** Default mistake threshold: 100 cp = 1.00 pawn. */
export const DEFAULT_MISTAKE_THRESHOLD = 100;

/** Default blunder threshold: 300 cp = 3.00 pawns. */
export const DEFAULT_BLUNDER_THRESHOLD = 300;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for constructing a `MistakePredictor`. */
export interface MistakePredictorOptions {
  /** The chess engine analysis provider (M5 port). Injected — never a real binary in tests. */
  readonly engine: AnalysisProvider;
  /** The AI completion provider (M7 port). Optional — the LLM text is additive, never load-bearing. */
  readonly ai?: AiProvider;
  /** Default variant (defaults to `chess`). */
  readonly defaultVariant?: string;
  /** Default analysis limits (used when the request doesn't supply them). */
  readonly defaultLimits?: AnalysisLimits;
  /** Default temperature for the LLM call (defaults to 0.3 for factual coaching). */
  readonly temperature?: number;
  /** Default max output tokens (defaults to 512). */
  readonly maxTokens?: number;
}

// ---------------------------------------------------------------------------
// MistakePredictor
// ---------------------------------------------------------------------------

/**
 * Predicts whether a candidate move is a mistake and how severe.
 *
 * The verdict's correctness fields (evalBefore, evalAfter, cp loss,
 * better move) come entirely from the engine.  The LLM only provides
 * optional human-facing coaching text.
 */
export class MistakePredictor {
  private readonly engine: AnalysisProvider;
  private readonly ai: AiProvider | undefined;
  private readonly defaultVariant: string;
  private readonly defaultLimits: AnalysisLimits;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: MistakePredictorOptions) {
    this.engine = options.engine;
    this.ai = options.ai;
    this.defaultVariant = options.defaultVariant ?? 'chess';
    this.defaultLimits = options.defaultLimits ?? { depth: 20 };
    this.temperature = options.temperature ?? 0.3;
    this.maxTokens = options.maxTokens ?? 512;
  }

  /**
   * Predict whether a candidate move is a mistake.
   *
   * @param request - The position, candidate move, and optional configuration.
   * @returns A `MistakeVerdict` with the classification and engine-derived fields.
   */
  async predict(request: PredictRequest): Promise<MistakeVerdict> {
    const variant = request.variant ?? this.defaultVariant;
    const limits = request.limits ?? this.defaultLimits;
    const inaccuracyThreshold = request.inaccuracyThreshold ?? DEFAULT_INACCURACY_THRESHOLD;
    const mistakeThreshold = request.mistakeThreshold ?? DEFAULT_MISTAKE_THRESHOLD;
    const blunderThreshold = request.blunderThreshold ?? DEFAULT_BLUNDER_THRESHOLD;

    // 1. Analyse the original position.
    let resultsBefore: readonly EngineResult[];
    if (request.analysisBefore && request.analysisBefore.length > 0) {
      resultsBefore = request.analysisBefore;
    } else {
      const analysisRequest: AnalysisRequest = {
        fen: request.fen,
        variant,
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

    // 2. Apply the candidate move to get the resulting FEN.
    //    Use @chess-platform/core's Position.play() which validates legality.
    const position = Position.fromFen(request.fen);
    const positionAfter = position.play(request.move);
    const fenAfter = positionAfter.fen();

    // 3. Analyse the resulting position.
    let resultsAfter: readonly EngineResult[];
    if (request.analysisAfter && request.analysisAfter.length > 0) {
      resultsAfter = request.analysisAfter;
    } else {
      const analysisRequest: AnalysisRequest = {
        fen: fenAfter,
        variant,
        limits,
        multiPv: 1,
        signal: request.signal,
      };
      resultsAfter = await this.engine.analyze(analysisRequest);
    }

    const bestAfter = resultsAfter[0];
    const evalAfterRaw = bestAfter.evaluation;

    // 4. Normalise evalAfter to the mover's perspective.
    //    The engine reports eval from the side-to-move's perspective.
    //    After the candidate move, it is the opponent's turn, so the
    //    engine's eval is from the opponent's perspective.  To compare
    //    with evalBefore (which is from the mover's perspective), we
    //    must negate it.
    //
    //    For cp: negate the value.
    //    For mate: negate the value (mate-in-N for opponent = getting
    //    mated in N for the mover).
    const evalAfterMoverPerspective: Evaluation = negateEval(evalAfterRaw);

    // 5. Compute centipawn loss.
    const centipawnLoss = evalToCpLoss(evalBefore, evalAfterMoverPerspective);

    // 6. Classify.
    const classification = classify(
      centipawnLoss,
      inaccuracyThreshold,
      mistakeThreshold,
      blunderThreshold,
    );

    // 7. Optionally generate LLM coaching text.
    let coaching: string | null = null;
    let providerId: string | null = null;
    let model: string | null = null;
    let usage: import('@chess-platform/ai-orchestrator').TokenUsage | null = null;
    let latencyMs: number | null = null;

    if (this.ai) {
      // Build grounding from the original position's analysis.
      const grounding: EngineGrounding = engineResultsToGrounding(
        request.fen,
        resultsBefore,
        request.move,
      );

      const userContent = `The player is considering the move ${request.move} in the position with FEN: ${request.fen}. ` +
        `The engine classifies this as a ${classification} with a centipawn loss of ${centipawnLoss}. ` +
        `The engine's best move is ${betterMove}. ` +
        `Provide a brief, encouraging coaching explanation of why the move is good or bad, ` +
        `and what the player should consider instead. Cite the engine evaluation.`;

      const messages = buildGroundedMessages(
        [{ role: 'user', content: userContent }],
        grounding,
      );

      const completionRequest: CompletionRequest = {
        task: 'mistake_prediction',
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

    // 8. Build the structured verdict.
    const verdict: MistakeVerdict = {
      fen: request.fen,
      move: request.move,
      fenAfter,
      classification,
      centipawnLoss,
      evalBefore,
      evalBeforeLabel: evalToString(evalBefore),
      evalAfterMoverPerspective,
      evalAfterLabel: evalToString(evalAfterMoverPerspective),
      betterMove,
      bestLine,
      depth,
      coaching,
      providerId,
      model,
      usage,
      latencyMs,
    };

    return verdict;
  }
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Negate an evaluation, flipping the perspective from the side-to-move
 * to the opponent (or vice versa).
 *
 * For cp: negate the value (e.g. +50 → -50).
 * For mate: negate the value (e.g. mate in 3 → mate in -3, meaning the
 * opponent gets mated in 3, which from the mover's perspective is
 * "opponent is losing").
 */
export function negateEval(eval_: Evaluation): Evaluation {
  return {
    type: eval_.type,
    value: -eval_.value,
  };
}

/**
 * Compute the centipawn loss from the mover's perspective.
 *
 * `loss = evalBefore − evalAfterMoverPerspective`
 *
 * Both evals must already be in the mover's perspective (positive = good
 * for the mover).
 *
 * Special cases:
 * - If evalBefore is mate (mover is winning) and evalAfter is not mate:
 *   the move throws away a forced mate → loss is Infinity (blunder).
 * - If evalAfter is mate with a negative value (mover gets mated) and
 *   evalBefore is not mate: the move walks into mate → loss is Infinity
 *   (blunder).
 * - If both are mate: if evalBefore was mate-in-N (mover winning) and
 *   evalAfter is mate-in-M (mover still winning), loss is 0 (still
 *   winning).  If evalAfter is now mate with negative value (mover gets
 *   mated), loss is Infinity.
 */
export function evalToCpLoss(
  evalBefore: Evaluation,
  evalAfterMoverPerspective: Evaluation,
): number {
  // If the move walks into a forced mate (evalAfter is mate and negative
  // from mover's perspective = mover gets mated), it's always a blunder.
  if (evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value < 0) {
    return Infinity;
  }

  // If evalBefore was mate (mover was winning) and evalAfter is not mate,
  // the mover threw away a forced mate → blunder.
  if (evalBefore.type === 'mate' && evalBefore.value > 0 && evalAfterMoverPerspective.type !== 'mate') {
    return Infinity;
  }

  // If evalBefore was mate (mover winning) and evalAfter is also mate
  // (mover still winning), no loss.
  if (evalBefore.type === 'mate' && evalBefore.value > 0 &&
      evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value > 0) {
    return 0;
  }

  // If both are cp, simple subtraction.
  if (evalBefore.type === 'cp' && evalAfterMoverPerspective.type === 'cp') {
    return evalBefore.value - evalAfterMoverPerspective.value;
  }

  // Mixed cases: one is mate, the other is cp.
  // If evalBefore is mate (positive = winning) and evalAfter is cp:
  //   already handled above (Infinity).
  // If evalBefore is cp and evalAfter is mate (positive = still winning):
  //   the move is actually better than cp suggests → loss is 0 or negative.
  if (evalBefore.type === 'cp' && evalAfterMoverPerspective.type === 'mate' && evalAfterMoverPerspective.value > 0) {
    // The mover is still winning (mate), so the move can't be a mistake.
    return 0;
  }

  // Fallback: shouldn't reach here in normal use.
  return 0;
}

/**
 * Classify a move based on the centipawn loss and the evaluations.
 *
 * @param centipawnLoss - The measured cp loss (Infinity for mate-related blunders).
 * @param evalBefore - Engine eval before the move (mover's perspective).
 * @param evalAfter - Engine eval after the move (mover's perspective).
 * @param inaccuracyThreshold - Minimum cp loss for an inaccuracy.
 * @param mistakeThreshold - Minimum cp loss for a mistake.
 * @param blunderThreshold - Minimum cp loss for a blunder.
 */
export function classify(
  centipawnLoss: number,
  inaccuracyThreshold: number,
  mistakeThreshold: number,
  blunderThreshold: number,
): MistakeClassification {
  // A move that walks into mate is always a blunder.
  if (centipawnLoss === Infinity) {
    return 'blunder';
  }

  if (centipawnLoss >= blunderThreshold) {
    return 'blunder';
  }
  if (centipawnLoss >= mistakeThreshold) {
    return 'mistake';
  }
  if (centipawnLoss >= inaccuracyThreshold) {
    return 'inaccuracy';
  }
  return 'ok';
}
