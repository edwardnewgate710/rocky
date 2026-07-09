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
 * 3. Build grounded messages via the M7 `buildGroundedMessages()` prompt
 *    builder.
 * 4. Call the injected `AiProvider.complete()` to get the explanation.
 * 5. Return a structured response with the explanation prose and a
 *    distinct, testable `citation` field carrying the engine's eval,
 *    best line, and depth.
 *
 * Everything behind ports: both the engine and the AI provider are
 * injected.  The package is fully testable hermetically with fakes —
 * no keys, no binary, no network.
 */

import type { AnalysisProvider, AnalysisRequest, EngineResult, AnalysisLimits } from '@chess-platform/engine';
import type { AiProvider, CompletionRequest, EngineGrounding, TokenUsage } from '@chess-platform/ai-orchestrator';
import { engineResultsToGrounding, evalToString, buildGroundedMessages } from '@chess-platform/ai-orchestrator';

import type { ExplainRequest, MoveExplanationResponse, EngineCitation } from './types.js';

/** Options for constructing a `MoveExplainer`. */
export interface MoveExplainerOptions {
  /** The chess engine analysis provider (M5 port). Injected — never a real binary in tests. */
  readonly engine: AnalysisProvider;
  /** The AI completion provider (M7 port). Injected — use `FakeProvider` in tests. */
  readonly ai: AiProvider;
  /** Default variant (defaults to `chess`). */
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
  private readonly engine: AnalysisProvider;
  private readonly ai: AiProvider;
  private readonly defaultVariant: string;
  private readonly defaultLimits: AnalysisLimits;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: MoveExplainerOptions) {
    this.engine = options.engine;
    this.ai = options.ai;
    this.defaultVariant = options.defaultVariant ?? 'chess';
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
    const grounding: EngineGrounding = engineResultsToGrounding(
      request.fen,
      results,
      request.move,
    );

    // 3. Build the user prompt.
    const sideText = request.side
      ? ` (played by ${request.side})`
      : '';
    const userContent = `Explain the move ${request.move}${sideText} in the position with FEN: ${request.fen}. ` +
      `Describe why this move is good or bad, what it achieves, and what the engine's evaluation means. ` +
      `Cite the engine evaluation and best line in your explanation.`;

    // 4. Build grounded messages (system + user).
    const messages = buildGroundedMessages(
      [{ role: 'user', content: userContent }],
      grounding,
    );

    // 5. Call the AI provider.
    const completionRequest: CompletionRequest = {
      task: 'explanation',
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      signal: request.signal,
      grounding,
    };

    const response = await this.ai.complete(completionRequest);

    // 6. Build the structured citation from the engine results.
    const best = results[0];
    const citation: EngineCitation = best
      ? {
          fen: request.fen,
          move: request.move,
          evalKind: best.evaluation.type,
          evalValue: best.evaluation.value,
          evalLabel: evalToString(best.evaluation),
          bestLine: best.principalVariation,
          depth: best.depth,
        }
      : {
          fen: request.fen,
          move: request.move,
          evalKind: 'cp',
          evalValue: 0,
          evalLabel: '+0.00',
          bestLine: [],
          depth: 0,
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
