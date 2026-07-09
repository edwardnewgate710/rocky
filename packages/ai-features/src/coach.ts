/**
 * `Coach` — M8 increment 6.
 *
 * An orchestrator that composes the five existing feature classes into
 * one unified coaching response.  The Coach is a thin composition layer:
 * it decides which features are relevant to the request and aggregates
 * their structured outputs.  It does NOT re-implement any engine/analysis
 * logic.
 *
 * Every fact in the response is traceable to a feature's engine-verified
 * output.  The Coach's synthesized narrative (if an AI provider is
 * supplied) only produces a natural-language summary over facts the
 * features already computed and verified — it never invents a chess
 * assessment the underlying features didn't produce.
 *
 * The Coach degrades gracefully: if a feature reports "not applicable"
 * (no opening match, not a puzzle, not an endgame, move is fine), the
 * Coach simply omits that section — it never fabricates a lesson.
 *
 * Stateless — no session object, no memory between calls.
 *
 * This introduces the **composition/orchestration pattern**: a feature
 * built from features.  Study Partner and Tournament Commentator will
 * follow the same shape.
 */

import type { AnalysisProvider, AnalysisLimits } from '@chess-platform/engine';
import type { AiProvider, CompletionRequest, EngineGrounding } from '@chess-platform/ai-orchestrator';
import { buildGroundedMessages } from '@chess-platform/ai-orchestrator';

import { MoveExplainer } from './move-explainer.js';
import { MistakePredictor } from './mistake-predictor.js';
import { OpeningExplorer } from './opening-explorer.js';
import { PuzzleGenerator } from './puzzle-generator.js';
import { EndgameTrainer } from './endgame-trainer.js';
import { BundledOpeningDatabase } from './bundled-opening-database.js';
import { BundledEndgameDatabase } from './bundled-endgame-database.js';

import type { CoachRequest, CoachingResponse } from './coach-types.js';
import type { MoveUci } from './types.js';
import type { MistakeVerdict } from './mistake-types.js';
import type { MoveExplanationResponse } from './types.js';
import type { ExplorationResult } from './opening-types.js';
import type { PuzzleResult } from './puzzle-types.js';
import type { TrainingPosition } from './endgame-types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for constructing a `Coach`. */
export interface CoachOptions {
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
  /**
   * Optional: pre-built feature instances.  If supplied, the Coach uses
   * them directly (useful for testing with spies/fakes).  If omitted, the
   * Coach constructs them internally from the shared engine + AI ports.
   */
  readonly features?: Partial<CoachFeatures>;
}

/** The five feature instances the Coach composes. */
export interface CoachFeatures {
  readonly moveExplainer: MoveExplainer;
  readonly mistakePredictor: MistakePredictor;
  readonly openingExplorer: OpeningExplorer;
  readonly puzzleGenerator: PuzzleGenerator;
  readonly endgameTrainer: EndgameTrainer;
}

// ---------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------

/**
 * Composes the five existing features into a unified coaching response.
 *
 * The Coach calls the underlying features; it does not re-implement
 * their logic.  Every fact in the response is traceable to a feature's
 * engine-verified output.
 */
export class Coach {
  private readonly moveExplainer: MoveExplainer | null;
  private readonly mistakePredictor: MistakePredictor;
  private readonly openingExplorer: OpeningExplorer;
  private readonly puzzleGenerator: PuzzleGenerator;
  private readonly endgameTrainer: EndgameTrainer;
  private readonly ai: AiProvider | undefined;
  private readonly temperature: number;
  private readonly maxTokens: number;

  constructor(options: CoachOptions) {
    this.ai = options.ai;
    this.temperature = options.temperature ?? 0.4;
    this.maxTokens = options.maxTokens ?? 768;

    // Use supplied feature instances or construct them from shared ports.
    const f = options.features;
    const limits = options.defaultLimits ?? { depth: 20 };
    const ai = options.ai;

    this.moveExplainer = f?.moveExplainer ?? (ai ? new MoveExplainer({ engine: options.engine, ai, defaultLimits: limits }) : null);
    this.mistakePredictor = f?.mistakePredictor ?? new MistakePredictor({ engine: options.engine, ...(ai ? { ai } : {}), defaultLimits: limits });
    this.openingExplorer = f?.openingExplorer ?? new OpeningExplorer({
      database: new BundledOpeningDatabase(),
      engine: options.engine,
      ...(ai ? { ai } : {}),
      defaultLimits: limits,
    });
    this.puzzleGenerator = f?.puzzleGenerator ?? new PuzzleGenerator({ engine: options.engine, ...(ai ? { ai } : {}), defaultLimits: limits });
    this.endgameTrainer = f?.endgameTrainer ?? new EndgameTrainer({
      database: new BundledEndgameDatabase(),
      engine: options.engine,
      ...(ai ? { ai } : {}),
      defaultLimits: limits,
    });
  }

  /**
   * Produce a unified coaching response for a position and optional move.
   *
   * Calls the relevant features and aggregates their results.  Features
   * that report "not applicable" are omitted — the Coach never
   * fabricates a lesson.
   */
  async coach(request: CoachRequest): Promise<CoachingResponse> {
    const featuresFired: string[] = [];

    // 1. If a move was supplied, run MistakePredictor and MoveExplainer.
    let mistakeVerdict: MistakeVerdict | null = null;
    let moveExplanation: MoveExplanationResponse | null = null;

    if (request.move) {
      mistakeVerdict = await this.mistakePredictor.predict({
        fen: request.fen,
        move: request.move,
        ...(request.analysis ? { analysisBefore: request.analysis } : {}),
        signal: request.signal,
      });
      featuresFired.push('mistakePredictor');

      // Explain the engine's better move (not the player's move).
      const betterMove = mistakeVerdict.betterMove;
      if (betterMove && betterMove !== '(none)' && this.moveExplainer) {
        moveExplanation = await this.moveExplainer.explain({
          fen: request.fen,
          move: betterMove,
          ...(request.analysis ? { analysis: request.analysis } : {}),
          signal: request.signal,
        });
        featuresFired.push('moveExplainer');
      }
    }

    // 2. If a move sequence was supplied, run OpeningExplorer.
    let opening: ExplorationResult | null = null;
    if (request.moves && request.moves.length > 0) {
      opening = await this.openingExplorer.explore({
        moves: request.moves,
        signal: request.signal,
      });
      if (opening.found) {
        featuresFired.push('openingExplorer');
      } else {
        // Not found — set to null so the response doesn't carry a "not found" result.
        opening = null;
      }
    }

    // 3. Check if the position is a tactical puzzle.
    let puzzle: PuzzleResult | null = null;
    puzzle = await this.puzzleGenerator.generate({
      fen: request.fen,
      ...(request.analysis ? { analysis: request.analysis } : {}),
      signal: request.signal,
    });
    if (puzzle.kind === 'puzzle') {
      featuresFired.push('puzzleGenerator');
    } else {
      // Not a puzzle — omit.
      puzzle = null;
    }

    // 4. Check if the position is a recognized endgame.
    //    We try to match the FEN against the endgame database by checking
    //    if any entry's FEN matches.  This is a simple heuristic — a more
    //    sophisticated matcher would analyze material, but for the
    //    composition pattern this suffices.
    let endgame: TrainingPosition | null = null;
    const endgameEntry = this.findEndgameForFen(request.fen);
    if (endgameEntry) {
      endgame = await this.endgameTrainer.nextPosition({
        id: endgameEntry.id,
        ...(request.analysis ? { analysis: request.analysis } : {}),
        signal: request.signal,
      });
      featuresFired.push('endgameTrainer');
    }

    // 5. Optionally synthesize a narrative.
    let narrative: string | null = null;
    let providerId: string | null = null;
    let model: string | null = null;
    let usage: import('@chess-platform/ai-orchestrator').TokenUsage | null = null;
    let latencyMs: number | null = null;

    if (this.ai && featuresFired.length > 0) {
      // Build a summary of what the features found.
      const summary = this.buildSummary(
        request.fen,
        request.move ?? null,
        mistakeVerdict,
        moveExplanation,
        opening,
        puzzle,
        endgame,
      );

      const grounding: EngineGrounding = { fen: request.fen };

      const userContent = `You are a chess coach. Synthesize the following engine-verified analysis ` +
        `into a brief, encouraging coaching narrative. Do not invent assessments — ` +
        `only summarize what the analysis found.\n\n${summary}`;

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
      fen: request.fen,
      move: request.move ?? null,
      featuresFired,
      mistakeVerdict,
      moveExplanation,
      opening,
      puzzle,
      endgame,
      narrative,
      providerId,
      model,
      usage,
      latencyMs,
    };
  }

  /**
   * Try to find an endgame database entry whose FEN matches the request.
   * Returns `undefined` if no match — the position is not a recognized
   * endgame training position.
   */
  private findEndgameForFen(fen: string): import('./endgame-database.js').EndgameEntry | undefined {
    // The BundledEndgameDatabase is the default; we access it through the
    // endgameTrainer's database.  Since we constructed it internally,
    // we can check by trying to match the FEN.
    // A simple approach: check if the FEN matches any entry in the DB.
    // We access the DB through the trainer's options — but since we
    // constructed it, we need a reference.  Let's use a simpler approach:
    // check the material configuration from the FEN.
    //
    // Actually, the cleanest approach is to try nextPosition with each
    // entry and see if the FEN matches.  But that's expensive.
    // Instead, let's just check if the FEN has very few pieces (endgame
    // indicator) and try to find a matching entry.
    //
    // For the composition pattern, the simplest correct approach is:
    // the Coach doesn't need to be clever about endgame detection. It
    // just tries the endgame DB and if no entry matches, it omits the
    // section.  We can check by seeing if the FEN matches any entry.
    //
    // Since we don't have direct access to the database from the trainer,
    // let's use a heuristic: count pieces on the board. If <= 7 pieces
    // (including kings), it's likely an endgame.
    const pieceCount = this.countPieces(fen);
    if (pieceCount > 7) {
      return undefined;
    }

    // Try to find a matching entry by FEN.
    // We need access to the database. Since the Coach constructs the
    // EndgameTrainer internally, we need to store a reference to the DB.
    // Let's use the bundled DB directly for matching.
    const db = new BundledEndgameDatabase();
    for (const entry of db.all()) {
      if (entry.fen === fen) {
        return entry;
      }
    }
    return undefined;
  }

  /** Count the number of pieces on the board from a FEN. */
  private countPieces(fen: string): number {
    const boardPart = fen.split(' ')[0];
    let count = 0;
    for (const ch of boardPart) {
      if (/[pnbrqkPNBRQK]/.test(ch)) {
        count++;
      }
    }
    return count;
  }

  /** Build a text summary of the feature results for the LLM. */
  private buildSummary(
    fen: string,
    move: MoveUci | null,
    mistake: MistakeVerdict | null,
    explanation: MoveExplanationResponse | null,
    opening: ExplorationResult | null,
    puzzle: PuzzleResult | null,
    endgame: TrainingPosition | null,
  ): string {
    const lines: string[] = [`Position FEN: ${fen}`];

    if (move) {
      lines.push(`Move evaluated: ${move}`);
    }

    if (mistake) {
      lines.push(`Mistake assessment: ${mistake.classification} (cp loss: ${mistake.centipawnLoss}). ` +
        `Better move: ${mistake.betterMove}.`);
    }

    if (explanation) {
      lines.push(`Best move explanation: ${explanation.explanation}`);
    }

    if (opening) {
      lines.push(`Opening: ${opening.name} (ECO ${opening.eco}). ` +
        `${opening.outOfBook ? 'Out of book.' : 'Still in book.'}`);
    }

    if (puzzle && puzzle.kind === 'puzzle') {
      lines.push(`Tactical puzzle detected: ${puzzle.theme ?? 'Tactical opportunity'}. ` +
        `Solution: ${puzzle.solutionMove}. Difficulty: ${puzzle.difficulty}.`);
    }

    if (endgame) {
      lines.push(`Endgame training: ${endgame.entry.name}. ` +
        `Goal: ${this.formatGoal(endgame.goal)}.`);
    }

    if (lines.length === 1) {
      lines.push('No specific lessons found for this position.');
    }

    return lines.join('\n');
  }

  /** Format an endgame goal as a string. */
  private formatGoal(goal: import('./endgame-database.js').EndgameGoal): string {
    switch (goal.kind) {
      case 'mate': return `Mate in ${goal.distance}`;
      case 'win': return `Win (${goal.description})`;
      case 'draw': return `Draw (${goal.description})`;
    }
  }
}
