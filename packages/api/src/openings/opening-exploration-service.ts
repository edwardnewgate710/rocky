/**
 * Production opening identification over the bundled M8 `OpeningExplorer` (ADR-0127).
 *
 * The feature is deliberately the smallest half of the library one: `OpeningExplorer` accepts an
 * optional `AnalysisProvider` and an optional `AiProvider`, and this service supplies neither. The
 * opening identification is a lookup in a bundled table plus a legality replay, so it costs no
 * engine process, no pool acquisition and no provider call, and it answers identically on a
 * deployment that has no engine binary at all.
 *
 * Every policy the caller might otherwise choose lives here: the variant, the start position, the
 * ply ceiling, and which fields reach the wire.
 */
import { IllegalMoveError, Position } from '@chess-platform/core';
import { BundledOpeningDatabase, OpeningExplorer } from '@chess-platform/ai-features';
import type { ExplorationResult, OpeningDatabase } from '@chess-platform/ai-features';
import { HttpError } from '../http/errors.js';

/**
 * The only variant this feature can answer for.
 *
 * `OpeningExplorer.explore` replays from `Position.initial()` — no variant argument — and the
 * bundled dataset is standard-chess opening theory. Answering for any other variant would attach a
 * real ECO code to a position those moves never reached, which is the falsehood ADR-0123 refused
 * for `chess960`. The refusal is explicit rather than implicit so a caller learns it, instead of
 * receiving a confident answer about a different game.
 */
export const OPENING_EXPLORER_VARIANT = 'standard';

/**
 * The only start position this feature can answer for, derived rather than written out so it cannot
 * drift from the rule set.
 */
export const STANDARD_START_FEN = Position.initial().fen();

/**
 * Hard ceiling on the submitted sequence, in plies.
 *
 * Two independent jobs. It bounds the work: every ply is replayed through `Position.play`, which
 * generates legal moves, so an unbounded array is a CPU-amplification surface on an endpoint that
 * otherwise has none. And it keeps the endpoint honest about what it is — an opening tool. The
 * deepest bundled line is 10 plies, so this leaves a wide margin in which `outOfBook` is still a
 * measured answer rather than an artefact of truncation.
 *
 * A sequence longer than this is refused, never truncated: answering about a prefix of what was
 * asked would be a different question answered confidently. `scripts`-side there is no guard for
 * this, so `opening-exploration.test.ts` pins the ceiling above the deepest bundled entry.
 */
export const MAX_EXPLORED_PLIES = 60;

/** Long-algebraic UCI, with an optional promotion piece. Drops (`P@f7`) are not standard chess. */
const UCI_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

export interface OpeningExplorationInput {
  readonly variant: string;
  readonly moves: readonly string[];
  /**
   * The position the sequence starts from, when the caller knows it.
   *
   * Optional because a caller may not have it, and harmless here because this feature answers for
   * `standard` alone (see {@link OPENING_EXPLORER_VARIANT}) and a standard game always starts from
   * `Position.initial('standard')`.
   *
   * **The day this comment anticipated has arrived, for one variant.** It used to say that every game
   * this deployment can create starts from `Position.initial(variant)`. Since ADR-0137 that is false
   * for `chess960`, whose games start from whichever of the 960 arrangements the server drew — and
   * the gateway's `StateView` now does carry `chess960StartId`, so a client could supply one. The
   * variant gate is what keeps this feature correct regardless: Chess960 is refused before any
   * position is read, because the bundled dataset is standard opening theory and naming an ECO code
   * for a shuffled back rank would be the falsehood ADR-0123 refused. If the gate is ever widened,
   * this field is the thing that has to become required rather than optional.
   */
  readonly initialFen?: string | undefined;
}

/** One book move out of the identified line. Deliberately carries no statistics — see below. */
export interface OpeningContinuationOutcome {
  readonly move: string;
  readonly san: string | null;
  readonly eco: string | null;
  readonly name: string | null;
}

export interface OpeningExplorationOutcome {
  /** Echoed so a client can prove a late response belongs to the sequence it is about to render. */
  readonly moves: readonly string[];
  readonly found: boolean;
  readonly eco: string | null;
  readonly name: string | null;
  /** How many leading plies the identified line covers. `0` when nothing matched. */
  readonly matchedMoves: number;
  /** Whether play has continued past the end of the identified line. */
  readonly outOfBook: boolean;
  readonly continuations: readonly OpeningContinuationOutcome[];
}

export interface OpeningExplorationServiceOptions {
  readonly database?: OpeningDatabase;
}

export class OpeningExplorationService {
  private readonly explorer: OpeningExplorer;

  /** No `engine` and no `ai`: the constructed explorer has no path that can reach either. */
  constructor(options: OpeningExplorationServiceOptions = {}) {
    this.explorer = new OpeningExplorer({
      database: options.database ?? new BundledOpeningDatabase(),
    });
  }

  /**
   * Whether the bundled book describes this rule set.
   *
   * @param variant - the variant a caller named.
   * @returns `true` only for `standard`; the dataset is standard opening theory and the explorer
   * replays from `Position.initial()` with no variant argument.
   */
  supportsVariant(variant: string): boolean {
    return variant === OPENING_EXPLORER_VARIANT;
  }

  /**
   * Identify the opening for one exact move sequence.
   *
   * Ordered cheapest-first, so a malformed or oversized request is refused before any position is
   * constructed and long before the table is consulted.
   */
  async explore(input: OpeningExplorationInput): Promise<OpeningExplorationOutcome> {
    if (!this.supportsVariant(input.variant)) {
      throw HttpError.validation('unsupported variant', {
        variant: `opening exploration supports '${OPENING_EXPLORER_VARIANT}' only`,
      });
    }

    if (input.initialFen !== undefined && input.initialFen !== STANDARD_START_FEN) {
      throw HttpError.validation('unsupported starting position', {
        initialFen: 'opening exploration supports the standard starting position only',
      });
    }

    if (input.moves.length > MAX_EXPLORED_PLIES) {
      throw HttpError.validation('move sequence is too long', {
        moves: `at most ${MAX_EXPLORED_PLIES} plies`,
      });
    }

    for (const [index, move] of input.moves.entries()) {
      if (!UCI_PATTERN.test(move)) {
        throw HttpError.validation('malformed move', { moves: `move ${index} is not UCI` });
      }
    }

    // Legality is proved by replaying the sequence, which `explore` does itself. Catching here
    // rather than pre-walking keeps one replay: a second one would double the cost of the endpoint
    // to re-derive an answer the library already has.
    //
    // Only `IllegalMoveError` becomes a 422. Anything else is this deployment failing rather than
    // the caller sending a bad sequence, and relabelling it would report a defect of ours as their
    // mistake while hiding it from the error rate.
    let result: ExplorationResult;
    try {
      result = await this.explorer.explore({ moves: input.moves });
    } catch (error: unknown) {
      if (!(error instanceof IllegalMoveError)) throw error;
      throw HttpError.validation('illegal move sequence', {
        moves: 'the sequence is not legal from the standard starting position',
      });
    }

    return {
      moves: [...input.moves],
      found: result.found,
      eco: result.eco,
      name: result.name,
      matchedMoves: result.matchedMoves,
      outOfBook: result.outOfBook,
      // `stats` is dropped here, and this is the point of the projection rather than an omission.
      // The bundled dataset's own header says its figures "are approximate aggregate figures for
      // illustration; they are not sourced from a specific database" — publishing `games: 50000`
      // through a production API would present invented numbers as measured ones. Real statistics
      // need a real corpus; until there is one the field does not exist on the wire.
      continuations: result.continuations.map((continuation) => ({
        move: continuation.move,
        san: continuation.san ?? null,
        eco: continuation.eco ?? null,
        name: continuation.name ?? null,
      })),
    };
  }
}
