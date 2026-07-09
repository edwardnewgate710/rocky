/**
 * `OpeningExplorer` — M8 increment 4.
 *
 * Given a game's move sequence (from the start), identifies the opening
 * and explains the position.
 *
 * The opening identification and stats come entirely from the
 * `OpeningDatabase` port — never invented by the LLM.  This is the
 * first M8 feature whose primary facts are not engine evals; the
 * architecture generalises the established pattern to a new data source
 * (opening database port + bundled dataset).
 *
 * Optionally enriches with the engine (M5): if an `AnalysisProvider` is
 * supplied, evaluates the current position so the result can note
 * whether the book line is objectively sound.  This is optional — the
 * explorer returns a valid result from the opening DB alone.
 *
 * The AI provider's role is **only** the human-facing narrative,
 * generated from the opening facts (and engine eval if present) via the
 * M7 grounding path.  If no AI provider is supplied, the result is
 * fully valid with DB/engine fields and no LLM text.
 *
 * Follows the exact architectural pattern established by `MoveExplainer`
 * (increment 1), `PuzzleGenerator` (increment 2), and `MistakePredictor`
 * (increment 3): ports injected, verifiable structured facts from a
 * trusted source, LLM text is additive only.
 */

import type { AnalysisProvider, AnalysisRequest, EngineResult, AnalysisLimits, Evaluation } from '@chess-platform/engine';
import type { AiProvider, CompletionRequest, EngineGrounding } from '@chess-platform/ai-orchestrator';
import { engineResultsToGrounding, evalToString, buildGroundedMessages } from '@chess-platform/ai-orchestrator';
import { Position } from '@chess-platform/core';

import type { OpeningDatabase, OpeningLookupResult } from './opening-database.js';
import type { ExploreRequest, ExplorationResult } from './opening-types.js';
import type { MoveUci } from './types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for constructing an `OpeningExplorer`. */
export interface OpeningExplorerOptions {
  /** The opening database port (primary data source). */
  readonly database: OpeningDatabase;
  /** The chess engine analysis provider (M5 port, optional enrichment). */
  readonly engine?: AnalysisProvider;
  /** The AI completion provider (M7 port, optional narrative). */
  readonly ai?: AiProvider;
  /** Default analysis limits (used for optional engine enrichment). */
  readonly defaultLimits?: AnalysisLimits;
  /** Default temperature for the LLM call (defaults to 0.4). */
  readonly temperature?: number;
  /** Default max output tokens (defaults to 512). */
  readonly maxTokens?: number;
}

// ---------------------------------------------------------------------------
// OpeningExplorer
// ---------------------------------------------------------------------------

/**
 * Explores chess openings from a move sequence.
 *
 * The opening identification and stats come entirely from the
 * `OpeningDatabase` port.  The LLM only provides optional narrative.
 */
export class OpeningExplorer {
  private readonly database: OpeningDatabase;
  private readonly engine: AnalysisProvider | undefined;
  private readonly ai: AiProvider | undefined;
  private readonly defaultLimits: AnalysisLimits;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: OpeningExplorerOptions) {
    this.database = options.database;
    this.engine = options.engine;
    this.ai = options.ai;
    this.defaultLimits = options.defaultLimits ?? { depth: 20 };
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 512;
  }

  /**
   * Explore the opening for a move sequence.
   *
   * @param request - The move sequence and optional configuration.
   * @returns An `ExplorationResult` with the opening identification and optional enrichment.
   */
  async explore(request: ExploreRequest): Promise<ExplorationResult> {
    const moves = request.moves;

    // 1. Walk the moves to get the current position FEN.
    //    Use @chess-platform/core's Position.play() to validate legality
    //    and derive the FEN.
    let position = Position.initial();
    for (const uci of moves) {
      position = position.play(uci);
    }
    const fen = position.fen();

    // 2. Look up the move sequence in the opening database.
    const lookup: OpeningLookupResult = this.database.lookup(moves);

    // 3. Extract opening fields from the DB result.
    const found = lookup.kind === 'found';
    const entry = found ? lookup.entry : null;
    const eco = entry?.eco ?? null;
    const name = entry?.name ?? null;
    const continuations = entry?.continuations ?? [];
    const stats = entry?.stats ?? null;
    const matchedMoves = found ? lookup.matchedMoves : 0;
    const outOfBook = found ? lookup.outOfBook : false;

    // 4. Optionally enrich with the engine.
    let engineEval: Evaluation | null = null;
    let engineEvalLabel: string | null = null;
    let engineBestMove: MoveUci | null = null;
    let engineDepth: number | null = null;
    let engineResults: readonly EngineResult[] | null = null;

    if (this.engine) {
      if (request.analysis && request.analysis.length > 0) {
        engineResults = request.analysis;
      } else {
        const limits = request.limits ?? this.defaultLimits;
        const analysisRequest: AnalysisRequest = {
          fen,
          variant: 'chess',
          limits,
          multiPv: 1,
          signal: request.signal,
        };
        engineResults = await this.engine.analyze(analysisRequest);
      }

      const best = engineResults[0];
      if (best) {
        engineEval = best.evaluation;
        engineEvalLabel = evalToString(best.evaluation);
        engineBestMove = best.principalVariation[0] ?? null;
        engineDepth = best.depth;
      }
    }

    // 5. Optionally generate LLM narrative.
    let narrative: string | null = null;
    let providerId: string | null = null;
    let model: string | null = null;
    let usage: import('@chess-platform/ai-orchestrator').TokenUsage | null = null;
    let latencyMs: number | null = null;

    if (this.ai) {
      // Build grounding from the engine analysis (if available) or
      // from the opening data alone.
      let grounding: EngineGrounding | undefined;

      if (engineResults && engineResults.length > 0) {
        grounding = engineResultsToGrounding(fen, engineResults, undefined);
      } else {
        // Minimal grounding with just the FEN (no engine eval).
        grounding = {
          fen,
        };
      }

      // Enrich the grounding with opening info via the user prompt.
      const openingDesc = found
        ? `Opening: ${name} (ECO ${eco}). ${outOfBook ? 'The game has left book.' : 'Still in book.'} ` +
          `Continuations: ${continuations.map(c => c.san ?? c.move).join(', ')}.`
        : 'No known opening matches this move sequence.';

      const engineDesc = engineEval
        ? ` Engine evaluation: ${engineEvalLabel}. Best move: ${engineBestMove}.`
        : '';

      const userContent = `Provide a brief narrative explanation of this chess position. ` +
        `${openingDesc}${engineDesc} ` +
        `FEN: ${fen}. ` +
        `Describe the opening ideas, plans for both sides, and the character of the position.`;

      const messages = buildGroundedMessages(
        [{ role: 'user', content: userContent }],
        grounding,
      );

      const completionRequest: CompletionRequest = {
        task: 'opening_explorer',
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

    // 6. Build the structured result.
    return {
      moves,
      fen,
      found,
      opening: entry,
      eco,
      name,
      continuations,
      stats,
      matchedMoves,
      outOfBook,
      engineEval,
      engineEvalLabel,
      engineBestMove,
      engineDepth,
      narrative,
      providerId,
      model,
      usage,
      latencyMs,
    };
  }
}
