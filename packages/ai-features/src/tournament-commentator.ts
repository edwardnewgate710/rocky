/**
 * `TournamentCommentator` — the M9 AI feature.
 *
 * Provides two modes of commentary for tournaments:
 * 1. Moment Commentary: Given a position (FEN), an optional move, and
 *    tournament context, produces a natural-language broadcast-style
 *    explanation grounded in real engine analysis.
 * 2. Round Recap: Given a structured list of match results and current
 *    standings for a round, produces a narrative summary of the round
 *    grounded strictly in the provided data.
 */

import type { AnalysisProvider, AnalysisRequest, EngineResult, AnalysisLimits } from '@chess-platform/engine';
import type { AiProvider, CompletionRequest, EngineGrounding, TokenUsage } from '@chess-platform/ai-orchestrator';
import { engineResultsToGrounding, evalToString, buildGroundedMessages } from '@chess-platform/ai-orchestrator';

import type { EngineCitation } from './types.js';
import type {
  MomentCommentaryRequest,
  MomentCommentaryResponse,
  RoundRecapRequest,
  RoundRecapResponse,
} from './tournament-commentator-types.js';

/** Options for constructing a `TournamentCommentator`. */
export interface TournamentCommentatorOptions {
  /** The chess engine analysis provider (M5 port). */
  readonly engine: AnalysisProvider;
  /** The AI completion provider (M7 port). */
  readonly ai: AiProvider;
  /** Default variant (defaults to `chess`). */
  readonly defaultVariant?: string;
  /** Default analysis limits (used when the request doesn't supply them). */
  readonly defaultLimits?: AnalysisLimits;
  /** Default temperature for the LLM call (defaults to 0.6 for livelier prose). */
  readonly temperature?: number;
  /** Default max output tokens (defaults to 512). */
  readonly maxTokens?: number;
}

/**
 * Provides live broadcast commentary and narrative recaps for tournaments.
 */
export class TournamentCommentator {
  private readonly engine: AnalysisProvider;
  private readonly ai: AiProvider;
  private readonly defaultVariant: string;
  private readonly defaultLimits: AnalysisLimits;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: TournamentCommentatorOptions) {
    this.engine = options.engine;
    this.ai = options.ai;
    this.defaultVariant = options.defaultVariant ?? 'chess';
    this.defaultLimits = options.defaultLimits ?? { depth: 20 };
    this.temperature = options.temperature ?? 0.6;
    this.maxTokens = options.maxTokens ?? 512;
  }

  /**
   * Provide live broadcast-style commentary on a specific moment in a game.
   *
   * @param request - The position, optional move, tournament context, and optional pre-computed analysis.
   * @returns A structured commentary with a distinct engine citation field.
   */
  async commentateMoment(request: MomentCommentaryRequest): Promise<MomentCommentaryResponse> {
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
      request.lastMove,
    );

    // 3. Build the user prompt with tournament context.
    const contextLines = [
      `White: ${request.context.whitePlayer}`,
      `Black: ${request.context.blackPlayer}`,
    ];
    if (request.context.round !== undefined) contextLines.push(`Round: ${request.context.round}`);
    if (request.context.event) contextLines.push(`Event: ${request.context.event}`);
    if (request.context.stakes) contextLines.push(`Stakes: ${request.context.stakes}`);

    const moveText = request.lastMove ? `The last move played was ${request.lastMove}. ` : '';

    const userContent = `Act as a live broadcast commentator for a chess tournament.
Context:
${contextLines.join('\n')}

The current position FEN is: ${request.fen}
${moveText}
Provide exciting, broadcast-style commentary on this position. Describe who is better, the key threats, and what the engine evaluation implies for the game. Cite the engine evaluation and best line in your explanation to ensure your assessment is grounded in reality.`;

    // 4. Build grounded messages (system + user).
    const messages = buildGroundedMessages(
      [{ role: 'user', content: userContent }],
      grounding,
    );

    // 5. Call the AI provider.
    const completionRequest: CompletionRequest = {
      task: 'commentary',
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
          move: request.lastMove ?? '',
          evalKind: best.evaluation.type,
          evalValue: best.evaluation.value,
          evalLabel: evalToString(best.evaluation),
          bestLine: best.principalVariation,
          depth: best.depth,
        }
      : {
          fen: request.fen,
          move: request.lastMove ?? '',
          evalKind: 'cp',
          evalValue: 0,
          evalLabel: '+0.00',
          bestLine: [],
          depth: 0,
        };

    const usage: TokenUsage = response.usage;

    return {
      commentary: response.content,
      citation,
      providerId: response.providerId,
      model: response.model,
      usage,
      latencyMs: response.latencyMs,
    };
  }

  /**
   * Provide a narrative recap of a completed tournament round.
   *
   * @param request - The round, match results, and current standings.
   * @returns A narrative recap grounded in the supplied structured data.
   */
  async recapRound(request: RoundRecapRequest): Promise<RoundRecapResponse> {
    const eventText = request.event ? ` for the ${request.event}` : '';
    
    // Format the results and standings.
    const resultsText = request.results
      .map(r => `- ${r.white} vs ${r.black}: ${r.result}`)
      .join('\n');
      
    const standingsText = request.standings
      .map(s => `${s.rank}. ${s.player} (${s.points} pts)`)
      .join('\n');

    const userContent = `Act as a chess journalist providing a narrative recap of Round ${request.round}${eventText}.

Here are the official match results for the round:
${resultsText}

Here are the current standings after this round:
${standingsText}

Write an engaging, narrative summary of this round based strictly on the provided results and standings. 
CRITICAL RULES:
- Do NOT invent or hallucinate any games, players, or results that are not in the provided lists.
- Do NOT invent specific moves or blunders, as you do not have the game PGNs.
- Focus on the overall state of the tournament, who won/lost, and who is leading the standings.`;

    const messages = [
      {
        role: 'system' as const,
        content: 'You are a factual chess journalist. You must strictly ground your narrative in the provided structured data and never hallucinate unprovided details.',
      },
      {
        role: 'user' as const,
        content: userContent,
      },
    ];

    const completionRequest: CompletionRequest = {
      task: 'commentary',
      messages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
      signal: request.signal,
    };

    const response = await this.ai.complete(completionRequest);

    return {
      recap: response.content,
      providerId: response.providerId,
      model: response.model,
      usage: response.usage,
      latencyMs: response.latencyMs,
    };
  }
}
