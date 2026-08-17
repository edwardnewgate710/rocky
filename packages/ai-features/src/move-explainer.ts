/**
 * `MoveExplainer` — the first M8 AI feature.
 *
 * Given a position (FEN) and a played (or candidate) move (UCI), produces
 * a natural-language explanation **grounded in real engine analysis** —
 * not free-form LLM speculation.
 *
 * The flow:
 * 1. Obtain engine analysis (use pre-computed results if supplied, else
 *    run the injected `AnalysisProvider`).
 * 2. Convert engine results to `EngineGrounding` via the M7
 *    `engineResultsToGrounding()` bridge.
 * 3. Hand the grounding to the completion port, which owns turning it
 *    into prompt messages.
 * 4. Return a structured response with the explanation prose and a
 *    distinct, testable `citation` field carrying the engine's eval,
 *    best line, and depth.
 *
 * Everything behind ports: both the engine and the AI completion port are
 * injected.  The package is fully testable hermetically with fakes —
 * no keys, no binary, no network.
 */

import type { AnalysisProvider, AnalysisRequest, EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { CompletionPort, CompletionRequest, EngineGrounding, TokenUsage } from '@chess-platform/ai-orchestrator';
import { engineResultsToGrounding, evalToString } from '@chess-platform/ai-orchestrator';

import type { ExplainRequest, MoveExplanationResponse, EngineCitation } from './types.js';

/**
 * Flip an evaluation to the other side's perspective.
 *
 * UCI reports from the side to move, and after a move that side is the opponent — so the number
 * describing what the mover achieved is the negation of what the engine reports. Mate scores negate
 * the same way: mate in 3 for the opponent is mate in -3 for the mover.
 */
function negate(evaluation: Evaluation): Evaluation {
  return { type: evaluation.type, value: -evaluation.value };
}

/** Options for constructing a `MoveExplainer`. */
export interface MoveExplainerOptions {
  /**
   * The chess engine analysis provider (M5 port), for callers that want the explainer to obtain
   * its own analysis.
   *
   * Optional, and deliberately so. A caller that already owns an analysis subsystem — as the API
   * does since ADR-0113 — supplies `ExplainRequest.analysis` on every call and must not hand a
   * second engine to a second component; that is how one deployment silently acquires two pools and
   * twice the CPU ceiling it published. Composing without an engine makes the second pool
   * unrepresentable rather than merely discouraged. `explain` then requires pre-computed analysis
   * and throws if it is missing, which is a composition error, not a runtime condition.
   */
  readonly engine?: AnalysisProvider;
  /**
   * The AI completion port (M7).  `AiOrchestrator` satisfies it, and so does a bare `AiProvider`
   * for hermetic tests.
   *
   * **The port owns grounding.** Callers pass structured facts on `CompletionRequest.grounding`;
   * whatever is behind this port is responsible for rendering them into messages. See `explain`.
   */
  readonly ai: CompletionPort;
  /** Default variant (defaults to `standard`). */
  readonly defaultVariant?: string;
  /** Default analysis limits (used when the request doesn't supply them and no pre-computed analysis is given). */
  readonly defaultLimits?: AnalysisLimits;
  /** Default temperature for the LLM call (defaults to 0.3 for factual explanations). */
  readonly temperature?: number;
  /** Default max output tokens (defaults to 512). */
  readonly maxTokens?: number;
}

/**
 * Explains a chess move in natural language, grounded in real engine
 * analysis.
 *
 * The explanation cites the engine's eval (in cp/mate) and best line —
 * the whole point is that it is grounded, verifiable, and cannot
 * hallucinate a wrong assessment.
 */
export class MoveExplainer {
  private readonly engine: AnalysisProvider | undefined;
  private readonly ai: CompletionPort;
  private readonly defaultVariant: string;
  private readonly defaultLimits: AnalysisLimits;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: MoveExplainerOptions) {
    this.engine = options.engine;
    this.ai = options.ai;
    // `standard`, not `chess`. `chess` is not a value in the platform's variant vocabulary
    // (`VARIANTS` in the API, ADR-0102 in the engine): it fails `parseVariant` at the API boundary
    // and matches no engine pool below it, so the old default named a variant that could not be
    // served anywhere in this system.
    this.defaultVariant = options.defaultVariant ?? 'standard';
    this.defaultLimits = options.defaultLimits ?? { depth: 20 };
    this.temperature = options.temperature ?? 0.3;
    this.maxTokens = options.maxTokens ?? 512;
  }

  /**
   * Explain a move.
   *
   * @param request - The position, move, and optional pre-computed analysis.
   * @returns A structured explanation with a distinct engine citation field.
   */
  async explain(request: ExplainRequest): Promise<MoveExplanationResponse> {
    const variant = request.variant ?? this.defaultVariant;
    const limits = request.limits ?? this.defaultLimits;

    // 1. Obtain engine analysis.
    let results: readonly EngineResult[];
    if (request.analysis && request.analysis.length > 0) {
      results = request.analysis;
    } else {
      if (this.engine === undefined) {
        throw new Error(
          'MoveExplainer was composed without an engine, so ExplainRequest.analysis is required.',
        );
      }
      const analysisRequest: AnalysisRequest = {
        fen: request.fen,
        variant,
        limits,
        multiPv: 1,
        signal: request.signal,
      };
      results = await this.engine.analyze(analysisRequest);
    }

    // 2. Convert engine results to grounding context.
    //
    // `results` describes the position *before* the move, so its evaluation and best line are the
    // engine's own preference. When the caller also supplies analysis of the position after the
    // move, that second evaluation is what actually answers "was this move good" — and it arrives
    // from the opponent's perspective, because they are the side to move once the move is made.
    // Negating it puts both numbers in one frame: the mover's.
    const afterMove = request.analysisAfterMove?.[0];
    const moverRelative = afterMove ? negate(afterMove.evaluation) : undefined;

    const grounding: EngineGrounding = {
      ...engineResultsToGrounding(request.fen, results, request.move, variant),
      ...(moverRelative?.type === 'cp' ? { moveEvalCp: moverRelative.value } : {}),
      ...(moverRelative?.type === 'mate' ? { moveEvalMate: moverRelative.value } : {}),
    };

    // 3. Build the user prompt.
    const sideText = request.side
      ? ` (played by ${request.side})`
      : '';
    const userContent = `Explain the move ${request.move}${sideText} in the position with FEN: ${request.fen}. ` +
      `Describe why this move is good or bad, what it achieves, and what the engine's evaluation means. ` +
      `Cite the engine evaluation and best line in your explanation.`;

    // The comparison is the whole judgement, so it is asked for explicitly rather than left to be
    // inferred from two numbers in the grounding block.
    const comparison = moverRelative
      ? ` Compare the evaluation after ${request.move} with the engine's own best move and say whether the move loses ground.`
      : '';

    // 4. Hand the facts to the completion port, which renders them.
    //
    // This deliberately does *not* call `buildGroundedMessages` and then also set `grounding`.
    // `AiOrchestrator.complete` builds grounded messages whenever `grounding` is present, and
    // `buildGroundedMessages` inserts after a leading system message — so pre-building here put the
    // same block of engine facts into the prompt twice, wasting a slice of the context window on a
    // verbatim repeat and giving the model two copies to reconcile. Grounding has one owner: the
    // port. Features supply structured facts and never prompt text built from them.
    const completionRequest: CompletionRequest = {
      task: 'explanation',
      messages: [{ role: 'user', content: userContent + comparison }],
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      signal: request.signal,
      grounding,
    };

    const response = await this.ai.complete(completionRequest);

    // 5. Build the structured citation from the engine results.
    const best = results[0];
    const moveEval = moverRelative
      ? {
          moveEvalKind: moverRelative.type,
          moveEvalValue: moverRelative.value,
          moveEvalLabel: evalToString(moverRelative),
        }
      : {};
    const citation: EngineCitation = best
      ? {
          fen: request.fen,
          move: request.move,
          evalKind: best.evaluation.type,
          evalValue: best.evaluation.value,
          evalLabel: evalToString(best.evaluation),
          bestLine: best.principalVariation,
          depth: best.depth,
          ...(best.principalVariation[0] !== undefined
            ? { bestMove: best.principalVariation[0] }
            : {}),
          ...moveEval,
        }
      : {
          fen: request.fen,
          move: request.move,
          evalKind: 'cp',
          evalValue: 0,
          evalLabel: '+0.00',
          bestLine: [],
          depth: 0,
          ...moveEval,
        };

    const usage: TokenUsage = response.usage;

    return {
      explanation: response.content,
      citation,
      providerId: response.providerId,
      model: response.model,
      usage,
      latencyMs: response.latencyMs,
    };
  }
}
