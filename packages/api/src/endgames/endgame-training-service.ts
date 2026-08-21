/**
 * Production endgame training over the bundled M8 `EndgameTrainer` and API-owned `AnalysisService` (ADR-0128).
 *
 * `EndgameTrainer` requires an `AnalysisProvider` and accepts an optional `AiProvider`. This service
 * supplies no `AiProvider` and keeps the library engineless: it executes its own two searches against
 * {@link AnalysisService} with fixed server policy (depth 16, 1,000 ms, MultiPV 1) and hands those
 * pre-computed results into `evaluateAttempt`.
 *
 * Two entry points:
 * - `next(input)`: Selects a training position directly from the database without invoking the engine.
 *   Deliberately omits the solution and authored mate distance (ADR-0095, ADR-0127).
 * - `attempt(input, onAccepted)`: Looks up the position server-side, validates and plays the learner's
 *   move, runs before/after engine analysis, and returns a JSON-safe evaluation with a tagged `loss`.
 */
import { IllegalMoveError, Position } from '@chess-platform/core';
import {
  BundledEndgameDatabase,
  EndgameTrainer,
} from '@chess-platform/ai-features';
import type {
  AttemptClassification,
  EndgameDatabase,
  EndgameDifficulty,
  EndgameEntry,
  EndgameType,
} from '@chess-platform/ai-features';
import type {
  AnalysisProvider,
  EngineCapabilities,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import { HttpError } from '../http/errors.js';
import { DEFAULT_ANALYSIS_LIMITS } from '../analysis/limits.js';
import type { AnalysisService } from '../analysis/service.js';

export const ENDGAME_MULTI_PV = 1;
export const ENDGAME_DEPTH = DEFAULT_ANALYSIS_LIMITS.defaultDepth;
export const ENDGAME_MOVETIME_MS = DEFAULT_ANALYSIS_LIMITS.defaultTimeMs;

export const ENDGAME_ANALYSIS_LIMITS = {
  depth: ENDGAME_DEPTH,
  movetimeMs: ENDGAME_MOVETIME_MS,
  multiPv: ENDGAME_MULTI_PV,
} as const;

/** UCI move regex: 4-5 chars (e.g. "e2e4", "e7e8q"). */
const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Keep only the leading moves that are real; stop at the first that is not.
 *
 * @param line - the engine's principal variation, which may carry the library's `'(none)'` sentinel.
 * @returns the usable prefix.
 */
function takeWhileUsable(line: readonly string[]): string[] {
  const out: string[] = [];
  for (const move of line) {
    if (!move || move === '(none)') break;
    out.push(move);
  }
  return out;
}

export interface EndgameNextInput {
  readonly type?: string | undefined;
  readonly difficulty?: string | undefined;
  readonly id?: string | undefined;
}

export interface EndgameNextOutcome {
  readonly id: string;
  readonly type: EndgameType;
  readonly name: string;
  readonly fen: string;
  readonly sideToMove: 'w' | 'b';
  readonly objective: 'mate' | 'win' | 'draw';
  readonly difficulty: EndgameDifficulty;
  readonly technique: string | null;
}

export interface EndgameAttemptInput {
  readonly id: string;
  readonly move: string;
}

export type EndgameLossOutcome =
  | { readonly kind: 'centipawns'; readonly value: number }
  | { readonly kind: 'decisive' };

export interface EndgameEvaluationOutcome {
  readonly type: 'cp' | 'mate';
  readonly value: number;
}

/**
 * A move that ended the game.
 *
 * The single most instructive mistake in a K+Q mate is stalemate, and the mating move itself ends
 * the game too — so the two outcomes this trainer most needs to report are exactly the ones with no
 * evaluation to report. A decided position is a result, not a score (ADR-0116), so it gets its own
 * branch rather than a fabricated `0.00`.
 */
export interface EndgameTerminalOutcome {
  readonly kind: 'terminal';
  readonly id: string;
  readonly move: string;
  readonly fenAfter: string;
  readonly classification: AttemptClassification;
  readonly goalPreserved: boolean;
  readonly terminal: { readonly reason: string; readonly result: '1-0' | '0-1' | '1/2-1/2' };
}

export interface EndgameJudgedOutcome {
  readonly kind: 'judged';
  readonly id: string;
  readonly move: string;
  readonly fenAfter: string;
  readonly classification: AttemptClassification;
  readonly goalPreserved: boolean;
  readonly evalBefore: EndgameEvaluationOutcome;
  readonly evalAfter: EndgameEvaluationOutcome;
  readonly loss: EndgameLossOutcome;
  readonly betterMove: string | null;
  readonly bestLine: readonly string[];
  readonly depth: number;
  readonly mateDistanceAfter: number | null;
}

export type EndgameAttemptOutcome = EndgameJudgedOutcome | EndgameTerminalOutcome;

/**
 * Did the move keep the training goal alive, given that it ended the game?
 *
 * Decided from the result and the goal alone — no engine is involved, and none could be: the game
 * is over. A mate or win goal is preserved only by a win for the side that was to move; a draw goal
 * only by a draw.
 */
function adjudicateTerminal(
  goalKind: 'mate' | 'win' | 'draw',
  mover: 'w' | 'b',
  result: '1-0' | '0-1' | '1/2-1/2',
): { classification: AttemptClassification; goalPreserved: boolean } {
  // The engine reports from the side to move; the result is absolute. Comparing them needs the
  // colour that was to move, which is the entry's, not the position after the move.
  const moverWon = (result === '1-0' && mover === 'w') || (result === '0-1' && mover === 'b');
  const goalPreserved = goalKind === 'draw' ? result === '1/2-1/2' : moverWon;
  return { classification: goalPreserved ? 'optimal' : 'throws_result', goalPreserved };
}

export interface EndgameTrainingServiceOptions {
  readonly analysis: AnalysisService;
  readonly database?: EndgameDatabase | undefined;
}

/**
 * Stub engine provider passed to `EndgameTrainer`.
 *
 * The service supplies pre-computed engine lines via `analysisBefore` and `analysisAfter`
 * on every call to `evaluateAttempt`, so the trainer's internal engine is never reached.
 */
const NOOP_ENGINE: AnalysisProvider = {
  analyze: () => {
    throw new Error('EndgameTrainer engine was reached without pre-computed analysis');
  },
  play: (_request: PlayRequest): Promise<PlayResult> => {
    throw new Error('play is not supported in endgame trainer');
  },
  capabilitiesFor: (_variant: string): EngineCapabilities | undefined => undefined,
};

export class EndgameTrainingService {
  private readonly analysis: AnalysisService;
  private readonly database: EndgameDatabase;
  private readonly trainer: EndgameTrainer;

  constructor(options: EndgameTrainingServiceOptions) {
    if (!options.analysis.canSatisfyLimits(ENDGAME_ANALYSIS_LIMITS)) {
      throw new Error('Endgame training requires the fixed depth, time, and MultiPV policy.');
    }
    this.analysis = options.analysis;
    this.database = options.database ?? new BundledEndgameDatabase();
    this.trainer = new EndgameTrainer({
      database: this.database,
      engine: NOOP_ENGINE,
    });
  }

  /** @returns every endgame type the catalogue actually contains. */
  private knownTypes(): ReadonlySet<string> {
    return new Set(this.database.all().map((entry) => entry.type));
  }

  /** @returns every difficulty the catalogue actually contains. */
  private knownDifficulties(): ReadonlySet<string> {
    return new Set(this.database.all().map((entry) => entry.difficulty));
  }

  /**
   * The public shape of a training position.
   *
   * One projection for both selection paths, so an explicit id and a filtered pick can never
   * publish different fields — and so the rule that no solution leaves this service is enforced in
   * exactly one place.
   *
   * @param entry - the catalogue entry chosen.
   * @returns the position, carrying no solution and no authored mate distance.
   */
  private project(entry: EndgameEntry): EndgameNextOutcome {
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name,
      fen: entry.fen,
      sideToMove: entry.sideToMove,
      objective: entry.goal.kind,
      difficulty: entry.difficulty,
      technique: entry.technique ?? null,
    };
  }

  /**
   * Select a training position matching optional criteria.
   *
   * CRITICAL: The response must NOT contain the solution, the best move, the best line,
   * any evaluation, or the authored mate distance. This route makes NO engine call at all.
   * Two independent reasons:
   * (a) Sending the learner the answer before they attempt it is the defect ADR-0095 fixed for
   *     lesson steps (`stepView` was emitting `expectedSan`/`correctIndex` to the learner).
   * (b) The dataset's authored `goal.distance` (e.g. "mate in 5") is never cross-checked against
   *     the engine, so publishing it would present an authored number as a measured one —
   *     the ADR-0127 `stats` precedent. Only the engine's own figures are ever published,
   *     and only from `/attempt`.
   *
   * Standard chess only: `endgame-trainer.ts` hardcodes `variant: 'chess'` and the dataset is
   * standard positions. Neither route accepts a `variant`.
   */
  next(input: EndgameNextInput = {}): EndgameNextOutcome {
    // An id and a filter express different intentions — "this exact position" and "any position
    // like this" — so a request carrying both is a caller mistake rather than a request to be
    // guessed at. Honouring the id and ignoring the filters hides that mistake; validating the
    // filters first refuses a position the catalogue certainly has. Both readings were raised in the
    // Qodo review of PR #151, one against each ordering, which is the sign that neither is right.
    if (input.id !== undefined && (input.type !== undefined || input.difficulty !== undefined)) {
      throw HttpError.validation('id and filters are mutually exclusive', {
        id: 'send either a specific id or a type/difficulty filter, not both',
      });
    }

    let entry: EndgameEntry | undefined;
    if (input.id !== undefined) {
      entry = this.database.getById(input.id);
      if (!entry) {
        throw HttpError.validation('unknown endgame id', {
          id: `unknown endgame id: ${input.id}`,
        });
      }
      return this.project(entry);
    }

    // Validated against the values the catalogue actually holds rather than against a second
    // hand-written copy of the library's unions. A copy would go stale silently the day the dataset
    // gains a type — this repository has a parity guard for exactly that failure elsewhere — and it
    // would also accept a value that is in the union but in no entry, which can only ever answer
    // "no match" anyway.
    if (input.type !== undefined && !this.knownTypes().has(input.type)) {
      throw HttpError.validation('invalid endgame type', {
        type: `unknown endgame type: ${input.type}`,
      });
    }

    if (input.difficulty !== undefined && !this.knownDifficulties().has(input.difficulty)) {
      throw HttpError.validation('invalid endgame difficulty', {
        difficulty: `unknown endgame difficulty: ${input.difficulty}`,
      });
    }

    {
      let pool = this.database.all();
      if (input.type !== undefined) {
        pool = pool.filter((e) => e.type === input.type);
      }
      if (input.difficulty !== undefined) {
        pool = pool.filter((e) => e.difficulty === input.difficulty);
      }
      if (pool.length === 0) {
        throw HttpError.validation('no training position matches', {
          filter: 'no training position matches the requested filters',
        });
      }
      const idx = Math.floor(Math.random() * pool.length);
      entry = pool[idx]!;
    }

    return this.project(entry);
  }

  /**
   * Judge a learner's move against the engine's solution.
   *
   * `onAccepted` runs after cheap validation (UCI pattern, ID lookup, `Position.play` legality check),
   * but before the first engine call.
   */
  async attempt(
    input: EndgameAttemptInput,
    onAccepted?: () => Promise<void>,
  ): Promise<EndgameAttemptOutcome> {
    if (!UCI_PATTERN.test(input.move)) {
      throw HttpError.validation('malformed move', { move: 'move is not valid UCI' });
    }

    const entry = this.database.getById(input.id);
    if (!entry) {
      throw HttpError.validation('unknown endgame id', {
        id: `unknown endgame id: ${input.id}`,
      });
    }

    // Validate move legality by replaying it on the position.
    // Narrow catch strictly to `IllegalMoveError`; rethrow any unexpected error.
    let fenAfter: string;
    try {
      const position = Position.fromFen(entry.fen);
      const positionAfter = position.play(input.move);
      fenAfter = positionAfter.fen();
    } catch (error: unknown) {
      if (error instanceof IllegalMoveError) {
        throw HttpError.validation('illegal move', {
          move: `illegal move ${input.move} in position`,
        });
      }
      throw error;
    }

    if (onAccepted) await onAccepted();

    // 1. Analyze position before move.
    const analysisBefore = await this.analysis.analyze({
      fen: entry.fen,
      variant: 'standard',
      ...ENDGAME_ANALYSIS_LIMITS,
    });

    if (analysisBefore.terminal) {
      // The catalogue position is already over, so there is nothing to train. A dataset defect
      // rather than a caller mistake, but the caller is the one who can act on it by choosing
      // another position, so it is told plainly instead of being given a 500.
      throw HttpError.validation('this training position is already decided', {
        id: `endgame '${entry.id}' is not playable`,
      });
    }
    if (analysisBefore.lines.length === 0) {
      throw HttpError.unavailable('analysis is unavailable');
    }

    // 2. Analyze position after move.
    const analysisAfter = await this.analysis.analyze({
      fen: fenAfter,
      variant: 'standard',
      ...ENDGAME_ANALYSIS_LIMITS,
    });

    // The move ended the game. This is the common case, not the exception: in a mate-in-N trainer
    // the correct final move is checkmate and the classic blunder is stalemate, and neither has an
    // evaluation to report. Answering "analysis is unavailable" here would tell a learner the
    // engine broke at the exact moment they stalemated the opponent.
    if (analysisAfter.terminal) {
      const { classification, goalPreserved } = adjudicateTerminal(
        entry.goal.kind,
        entry.sideToMove,
        analysisAfter.terminal.result,
      );
      return {
        kind: 'terminal',
        id: entry.id,
        move: input.move,
        fenAfter,
        classification,
        goalPreserved,
        terminal: {
          reason: analysisAfter.terminal.reason,
          result: analysisAfter.terminal.result,
        },
      };
    }
    if (analysisAfter.lines.length === 0) {
      throw HttpError.unavailable('analysis is unavailable');
    }

    const evaluation = await this.trainer.evaluateAttempt({
      entry,
      move: input.move,
      analysisBefore: analysisBefore.lines,
      analysisAfter: analysisAfter.lines,
    });

    // Tagged loss union: legacyCpLoss returns Infinity on two branches.
    // JSON.stringify(Infinity) is null, which violates the schema. Assert finiteness explicitly.
    const loss: EndgameLossOutcome =
      Number.isFinite(evaluation.centipawnLoss) && !Number.isNaN(evaluation.centipawnLoss)
        ? { kind: 'centipawns', value: Math.round(evaluation.centipawnLoss) }
        : { kind: 'decisive' };

    // Map '(none)' or empty string to null.
    const betterMove =
      !evaluation.betterMove || evaluation.betterMove === '(none)' ? null : evaluation.betterMove;

    // A non-finite evaluation is the engine failing, not a position. Coercing it to `0` would
    // publish "dead equal" — a fabricated fact, and a plausible-looking one, which is worse than an
    // error. The same reasoning as the `loss` union above, except that here there is no honest
    // shape to fall back to, so the request fails.
    if (
      !Number.isFinite(evaluation.evalBefore.value) ||
      !Number.isFinite(evaluation.evalAfterMoverPerspective.value) ||
      !Number.isFinite(evaluation.depth)
    ) {
      throw HttpError.unavailable('analysis is unavailable');
    }
    const evalBeforeValue = evaluation.evalBefore.value;
    const evalAfterValue = evaluation.evalAfterMoverPerspective.value;

    const mateDistanceAfter =
      evaluation.mateDistanceAfter !== null &&
      evaluation.mateDistanceAfter !== undefined &&
      Number.isFinite(evaluation.mateDistanceAfter)
        ? evaluation.mateDistanceAfter
        : null;

    // Guarded above with the evaluations: reporting the depth we *asked* for as the depth the
    // engine *reached* would be a measurement we did not take.
    const depth = evaluation.depth;

    return {
      kind: 'judged',
      id: entry.id,
      move: input.move,
      fenAfter,
      classification: evaluation.classification,
      goalPreserved: evaluation.goalPreserved,
      evalBefore: {
        type: evaluation.evalBefore.type,
        value: evalBeforeValue,
      },
      evalAfter: {
        type: evaluation.evalAfterMoverPerspective.type,
        value: evalAfterValue,
      },
      loss,
      betterMove,
      // Truncated at the first unusable move, never filtered. A principal variation is a sequence:
      // removing an element from the middle silently rewrites every move after it into a line that
      // was never searched.
      bestLine: takeWhileUsable(evaluation.bestLine),
      depth,
      mateDistanceAfter,
    };
  }
}