/**
 * Production coaching over the five hardened feature services (ADR-0129).
 *
 * `Coach` in `@chess-platform/ai-features` (M8 increment 6) is the composition layer this
 * productionizes, and it is deliberately **not** the class this service uses. That class constructs
 * its own `MoveExplainer`, `MistakePredictor`, `OpeningExplorer`, `PuzzleGenerator` and
 * `EndgameTrainer` directly on the raw engine port, which would discard every server-owned policy
 * the last four increments established: the standard-only opening gate and its 60-ply ceiling
 * (ADR-0127), the finiteness guards and the `judged | terminal` union (ADR-0128), the terminal
 * adjudication that stops checkmate reading as `+0.00` (ADR-0116), and the answer withholding of
 * ADR-0095. Composing the *services* keeps all of it; composing the class silently loses it. So this
 * orchestrator calls the same five services the five existing routes call, and adds nothing of its
 * own except sequencing.
 *
 * Three properties it is responsible for, none of which any single feature service can provide:
 *
 * **It never widens a feature's projection.** Each section carries what that feature's own route
 * publishes, or less. The endgame section goes through `EndgameTrainingService.identify`, which
 * shares `next`'s projection, so the solution the trainer withholds cannot arrive by this door. The
 * puzzle section drops `solutionMove` and `solutionLine`: `/v1/puzzles/generate` answers "is this
 * position a tactic, and what is it" for a caller studying their own position, but a coaching hint
 * that hands over the tactic is the answer, not the hint, and that is the ADR-0095 defect wearing a
 * different hat.
 *
 * **It degrades by section, not by request.** A missing capability or a failing engine turns one
 * section into an explicit `omitted` value with a reason; it does not fail the other four. The
 * request fails only when nothing could be attempted at all.
 *
 * **It bounds its own cost.** Sections run in sequence, never `Promise.all`. Concurrency would
 * multiply the engine acquisitions a single request can hold, defeat the de-duplication in
 * {@link RequestScopedAnalysis} (whose single-flight only helps if there is something to collapse
 * onto), and leave nothing to cancel between sections. Sequential is both the cheaper and the
 * cancellable order.
 */
import { HttpError } from '../http/errors.js';
import type { Variant } from '@chess-platform/core';
import { Position } from '@chess-platform/core';
import type { MistakePredictionService, MistakePredictionOutcome } from '../analysis/mistake-prediction-service.js';
import type { MoveExplanationService, MoveExplanationOutcome } from '../ai/move-explanation-service.js';
import type {
  PuzzleGenerationService,
  PuzzleGenerationOutcome,
} from '../analysis/puzzle-generation-service.js';
import type { PuzzleDifficulty } from '@chess-platform/ai-features';
import type { OpeningExplorationService, OpeningExplorationOutcome } from '../openings/opening-exploration-service.js';
import type { EndgameTrainingService, EndgameNextOutcome } from '../endgames/endgame-training-service.js';
import type { FenValidator } from '@chess-platform/engine';
import { coreFenValidator } from '../analysis/fen-validator.js';
import { isUciShape } from '../analysis/uci.js';
import { fromStatus } from '../analysis/terminal.js';
import type { AnalysisPort } from '../analysis/service.js';
import { RequestScopedAnalysis } from './request-scoped-analysis.js';



/**
 * The ceiling on a supplied move sequence, matching `MAX_EXPLORED_PLIES` in the opening service.
 *
 * Restated rather than imported so this refuses the oversized sequence *before* charging, where the
 * opening service refuses it after. A test pins the two to the same number.
 */
export const MAX_COACH_PLIES = 60;

/** Why a section carries no value. A closed set, so a client can render every case. */
export type CoachOmissionReason =
  /** The request did not supply what this section needs — no move, or no move sequence. */
  | 'not_requested'
  /** The section ran and had nothing to say: out of book, no tactic, not a catalogue endgame. */
  | 'not_applicable'
  /**
   * This deployment does not compose the feature at all. Permanent, and not worth retrying.
   *
   * Kept apart from `unavailable` because the two need different things from a client and from the
   * status code: an engine that returned nothing may well answer on the next request, while a
   * feature this deployment never built will not appear because someone tried again.
   */
  | 'unsupported'
  /** The dependency the section needs failed on this request. Transient; a retry may succeed. */
  | 'unavailable'
  /** The caller went away before this section was attempted, so it was never started. */
  | 'cancelled';

/** A section that produced nothing, and says why rather than being absent or null. */
export interface CoachOmitted {
  readonly kind: 'omitted';
  readonly reason: CoachOmissionReason;
}

/** A section carrying a feature's result. `value` is that feature's own outcome, never widened. */
export interface CoachPresent<T> {
  readonly kind: 'present';
  readonly value: T;
}

export type CoachSection<T> = CoachPresent<T> | CoachOmitted;

/**
 * What the Coach says about a tactic.
 *
 * The solution is not here, and its absence is the point — see the file header. `difficulty` and the
 * sharpness evidence say *that* a tactic is present and how hard it is, which is what makes it a
 * coaching prompt rather than an answer key.
 */
export interface CoachPuzzleOutcome {
  readonly kind: 'puzzle';
  readonly fen: string;
  readonly variant: string;
  readonly difficulty: PuzzleDifficulty;
}

export interface CoachInput {
  readonly fen: string;
  readonly variant: Variant;
  readonly move?: string | undefined;
  readonly moves?: readonly string[] | undefined;
  /** Cancels the remaining sections. Comes from the socket; never from the request body. */
  readonly signal?: AbortSignal | undefined;
}

export interface CoachOutcome {
  readonly fen: string;
  readonly variant: string;
  readonly move: string | null;
  readonly mistake: CoachSection<MistakePredictionOutcome>;
  readonly explanation: CoachSection<MoveExplanationOutcome>;
  readonly opening: CoachSection<OpeningExplorationOutcome>;
  readonly puzzle: CoachSection<CoachPuzzleOutcome>;
  readonly endgame: CoachSection<EndgameNextOutcome>;
  /** Which sections produced a value, in the order they ran. Mirrors the library's contract. */
  readonly featuresFired: readonly string[];
}

/** The five feature services, as far as a deployment could build them. */
export interface CoachFeatureBundle {
  readonly mistakePrediction?: MistakePredictionService | undefined;
  readonly moveExplanation?: MoveExplanationService | undefined;
  readonly puzzleGeneration?: PuzzleGenerationService | undefined;
  readonly openingExploration?: OpeningExplorationService | undefined;
  readonly endgameTraining?: EndgameTrainingService | undefined;
}

/**
 * Builds the feature bundle over a given analysis port.
 *
 * A factory rather than a fixed bundle because the three engine-backed services must be constructed
 * against the *request-scoped* analysis port, which is the only thing that can de-duplicate their
 * overlapping searches and carry the request's cancellation signal into them. They are stateless
 * wrappers over a library object and a policy — building them costs no I/O and touches no pool — so
 * per-request construction is cheap, and it is the only construction that can see the request.
 *
 * The port is `undefined` on a deployment with no engine at all. Such a deployment builds none of
 * the engine-backed services anyway, so the factory simply ignores it and returns whatever it can.
 */
export type CoachFeatureFactory = (analysis: AnalysisPort | undefined) => CoachFeatureBundle;

export interface CoachServiceOptions {
  /** The shared, long-lived analysis service. Wrapped per request, never used directly. */
  readonly analysis?: AnalysisPort | undefined;
  readonly features: CoachFeatureFactory;
  readonly fenValidator?: FenValidator | undefined;
}

/**
 * @param reason - why the section carries no value.
 * @returns the omitted section. A helper rather than an inline literal because every one of the
 * fifteen places that build one must produce the same shape for the client to discriminate on.
 */
const OMITTED = (reason: CoachOmissionReason): CoachOmitted => ({ kind: 'omitted', reason });

/**
 * Decide how a thrown failure should land on a section.
 *
 * A 503 from a feature means that feature cannot answer right now — one section's problem, and the
 * others are still worth running. Anything else is rethrown: a 422 at this depth would mean the FEN
 * or move this service already validated was rejected downstream, which is a defect in the
 * validation above rather than a section that politely has nothing to say, and swallowing it into
 * `unavailable` would hide the bug behind a plausible-looking response.
 *
 * @param error - what the feature service threw.
 * @returns the section value to record.
 * @throws the original error when it is not a service-availability failure.
 */
function sectionFailure(error: unknown): CoachOmitted {
  if (error instanceof HttpError && error.status === 503) return OMITTED('unavailable');
  throw error;
}

export class CoachService {
  private readonly analysis: AnalysisPort | undefined;
  private readonly features: CoachFeatureFactory;
  private readonly fenValidator: FenValidator;

  constructor(options: CoachServiceOptions) {
    this.analysis = options.analysis;
    this.features = options.features;
    this.fenValidator = options.fenValidator ?? coreFenValidator;
  }

  /**
   * Coach a position, and optionally a move played in it.
   *
   * @param input - the position, variant, and what the caller wants considered.
   * @param onAccepted - charge callback, invoked once the request is known to be well-formed and
   * legal and before any engine or provider work begins. Supplied by the route; a caller that omits
   * it is charged nothing, which is what makes internal composition free.
   * @returns every section, each either present or explicitly omitted with a reason.
   */
  async coach(input: CoachInput, onAccepted?: () => Promise<void>): Promise<CoachOutcome> {
    // ---- Validation, all of it before anything is charged or searched. ----
    //
    // The FEN and move are validated here as well as inside each feature service, and that is not
    // redundant: a Coach request feeds the same position to up to four services, so a fault found
    // on the third of them would already have spent the first two. Finding it once, first, is what
    // makes the cost of a malformed request zero.
    try {
      this.fenValidator.validate(input.fen, input.variant);
    } catch {
      throw HttpError.validation('invalid FEN', { fen: 'invalid FEN' });
    }

    let position: Position;
    try {
      position = Position.fromFen(input.fen, input.variant);
    } catch {
      throw HttpError.validation('invalid FEN', { fen: 'invalid FEN' });
    }

    if (input.move !== undefined) {
      if (!isUciShape(input.move)) {
        throw HttpError.validation('invalid move', { move: 'invalid move' });
      }
      // Authoritative legality under the requested variant, by the same rules the feature services
      // use. Rejecting here costs nothing; rejecting inside mistake prediction costs whatever ran
      // before it.
      try {
        position.play(input.move);
      } catch {
        throw HttpError.validation('illegal move for this position', { move: 'illegal move' });
      }

      // A decided game has no move to judge, and saying so must cost nothing.
      //
      // Checkmate and stalemate cannot reach here — `play` above would have rejected the move — but
      // a draw by the fifty-move rule, by insufficient material, or by a variant rule leaves legal
      // moves on the board while the game is over. Mistake prediction and move explanation both
      // refuse such a position before their own `onAccepted`; this service calls them after its
      // own, so without this the caller was charged and then handed their 422. Raised in the
      // CodeRabbit review of PR #152.
      //
      // Deliberately inside the `move` branch. A decided position with no move supplied still has
      // an opening worth identifying and a catalogue endgame worth naming, and refusing the whole
      // request would take those away over a question nobody asked.
      if (fromStatus(position.status())) {
        throw HttpError.validation('the game is already over in this position', {
          fen: 'position is terminal',
        });
      }
    }

    if (input.moves !== undefined && input.moves.length > MAX_COACH_PLIES) {
      throw HttpError.validation('move sequence is too long', {
        moves: `at most ${String(MAX_COACH_PLIES)} plies`,
      });
    }

    // One analysis port for the whole request, and the features built over it.
    //
    // Constructed here rather than at boot so that every search this request makes goes through one
    // de-duplicating, cancellable view of the engine. Built *after* validation, so a malformed
    // request never reaches it, and *before* the charge, so nothing is charged for a deployment that
    // turns out to compose nothing.
    const scoped = this.analysis ? new RequestScopedAnalysis(this.analysis, input.signal) : undefined;
    const features = this.features(scoped);

    // Nothing composable at all is a deployment that cannot coach, not a quiet position.
    if (
      features.mistakePrediction === undefined &&
      features.moveExplanation === undefined &&
      features.puzzleGeneration === undefined &&
      features.openingExploration === undefined &&
      features.endgameTraining === undefined
    ) {
      throw HttpError.unavailable('coaching is not configured');
    }

    if (onAccepted) await onAccepted();

    const featuresFired: string[] = [];
    // Read once per section boundary rather than captured up front, so a caller that disconnects
    // mid-request stops the *next* section instead of only being noticed at the end.
    const cancelled = (): boolean => input.signal?.aborted === true;

    // ---- 1. Mistake prediction. Two searches; the first is the one every other section reuses. ----
    let mistake: CoachSection<MistakePredictionOutcome> = OMITTED('not_requested');

    if (input.move !== undefined) {
      if (features.mistakePrediction === undefined) {
        mistake = OMITTED('unsupported');
      } else if (cancelled()) {
        mistake = OMITTED('cancelled');
      } else {
        try {
          const outcome = await features.mistakePrediction.predict({
            fen: input.fen,
            variant: input.variant,
            move: input.move,
          });
          mistake = { kind: 'present', value: outcome };
          featuresFired.push('mistakePrediction');
        } catch (error: unknown) {
          mistake = sectionFailure(error);
        }
      }
    }

    // ---- 2. Move explanation, of the engine's preferred move rather than the player's. ----
    //
    // Explaining what the player already played teaches least; the coaching value is in what the
    // engine would have done instead, which is the choice `Coach` in `ai-features` makes too. The
    // better move is read off the mistake verdict, so this section runs only when that one did —
    // there is no second search to discover a better move independently.
    let explanation: CoachSection<MoveExplanationOutcome> = OMITTED('not_requested');
    if (input.move !== undefined) {
      // This section depends on the one above, so it inherits that section's failure rather than
      // reporting one of its own. The distinction is not cosmetic: `not_applicable` here reads as
      // "there was nothing better to suggest", which is a statement *about the move* — and telling
      // a learner their move could not be improved on, because an unrelated engine search failed,
      // is exactly the kind of confident wrong answer the rest of this increment exists to prevent.
      const better = mistake.kind === 'present' ? betterMoveOf(mistake.value, input.move) : null;
      if (features.moveExplanation === undefined) {
        explanation = OMITTED('unsupported');
      } else if (mistake.kind === 'omitted' && mistake.reason !== 'not_requested') {
        explanation = OMITTED(mistake.reason);
      } else if (better === null) {
        // The verdict is in and the engine had nothing better to offer, which is what happens when
        // the played move was already the best one. Nothing to explain, and nothing wrong.
        explanation = OMITTED('not_applicable');
      } else if (cancelled()) {
        explanation = OMITTED('cancelled');
      } else {
        try {
          const outcome = await features.moveExplanation.explain({
            fen: input.fen,
            variant: input.variant,
            move: better,
          });
          explanation = { kind: 'present', value: outcome };
          featuresFired.push('moveExplanation');
        } catch (error: unknown) {
          // This is the one section whose input is not the caller's.
          //
          // Everywhere else a 422 means the request was wrong and `sectionFailure` rethrows it,
          // because swallowing it would hide a caller mistake behind a plausible response. Here the
          // move being explained came from the *engine*, and the caller's own FEN and move were
          // validated at the top of this method. So a 422 here says the engine offered a move that
          // is not legal in the position it was asked about — a server-side disagreement the caller
          // can do nothing about, and no reason to throw away the four sections that answered.
          if (error instanceof HttpError && error.status === 422) {
            explanation = OMITTED('not_applicable');
          } else {
            explanation = sectionFailure(error);
          }
        }
      }
    }

    // ---- 3. Opening. No engine, no provider. ----
    let opening: CoachSection<OpeningExplorationOutcome> = OMITTED('not_requested');
    if (input.moves !== undefined && input.moves.length > 0) {
      if (cancelled()) {
        // Cheap sections are cancelled too. Neither this nor the endgame lookup touches an engine,
        // so skipping them saves little — but a caller who has gone is owed no work at all, and a
        // section reporting `cancelled` is a more honest record of what happened than one that
        // quietly ran anyway. Raised in the Qodo review of PR #152.
        opening = OMITTED('cancelled');
      } else if (features.openingExploration === undefined) {
        opening = OMITTED('unsupported');
      } else if (!features.openingExploration.supportsVariant(input.variant)) {
        // Asked before the call rather than caught after it. `explore` answers 422 for a variant it
        // does not serve, and `sectionFailure` rethrows anything that is not a 503 — so a
        // Crazyhouse game that supplied its move ledger failed the *whole* request, losing the
        // tactic, mistake and endgame sections that had nothing to do with openings. That is
        // exactly the all-or-nothing behaviour the section contract exists to prevent.
        opening = OMITTED('unsupported');
      } else {
        try {
          const outcome = await features.openingExploration.explore({
            variant: input.variant,
            moves: input.moves,
          });
          // `found: false` is the service saying the sequence left book. That is a real answer about
          // the game, not a failure, and it is reported as `not_applicable` rather than as a section
          // carrying an empty result a client would have to interpret.
          if (outcome.found) {
            opening = { kind: 'present', value: outcome };
            featuresFired.push('openingExploration');
          } else {
            opening = OMITTED('not_applicable');
          }
        } catch (error: unknown) {
          opening = sectionFailure(error);
        }
      }
    }

    // ---- 4. Puzzle detection. One search, at MultiPV 3 — the only section the de-duplication
    // cannot help, because a MultiPV 1 result cannot answer a MultiPV 3 question. ----
    let puzzle: CoachSection<CoachPuzzleOutcome> = OMITTED('not_applicable');
    if (features.puzzleGeneration === undefined) {
      puzzle = OMITTED('unsupported');
    } else if (cancelled()) {
      puzzle = OMITTED('cancelled');
    } else {
      try {
        const outcome = await features.puzzleGeneration.generate({
          fen: input.fen,
          variant: input.variant,
        });
        puzzle = projectPuzzle(outcome);
        if (puzzle.kind === 'present') featuresFired.push('puzzleGeneration');
      } catch (error: unknown) {
        puzzle = sectionFailure(error);
      }
    }

    // ---- 5. Endgame identification. No engine, no provider, no solution. ----
    let endgame: CoachSection<EndgameNextOutcome> = OMITTED('not_applicable');
    if (cancelled()) {
      endgame = OMITTED('cancelled');
    } else if (features.endgameTraining === undefined) {
      endgame = OMITTED('unsupported');
    } else {
      const identified = features.endgameTraining.identify(input.fen);
      if (identified) {
        endgame = { kind: 'present', value: identified };
        featuresFired.push('endgameTraining');
      }
    }

    // Nothing delivered, and something broken, is a 503 rather than a 200.
    //
    // Not "every section is unavailable", which is the obvious formulation and the wrong one: a
    // request that carries no move leaves three sections `not_requested`, so that condition would
    // almost never hold and a completely broken deployment would answer 200. And not "nothing
    // fired" either, which would turn a genuinely quiet position — no tactic, not a book line, not a
    // catalogue endgame — into an error when it is the most ordinary answer this endpoint gives.
    //
    // The distinction that matters is *why* nothing came back. If every empty section is empty
    // because there was nothing to say, that is coaching. If any of them is empty because a
    // dependency failed, the caller got nothing and a retry might do better, which is what a 503
    // with `Retry-After` means.
    const sections = [mistake, explanation, opening, puzzle, endgame];
    // `unavailable` only — a section this deployment never composed is `unsupported`, and a
    // permanently absent feature is not a reason to fail a request that a retry cannot fix.
    const anythingBroken = sections.some(
      (section) => section.kind === 'omitted' && section.reason === 'unavailable',
    );
    if (featuresFired.length === 0 && anythingBroken) {
      throw HttpError.unavailable('no coaching feature could answer');
    }

    return {
      fen: input.fen,
      variant: input.variant,
      move: input.move ?? null,
      mistake,
      explanation,
      opening,
      puzzle,
      endgame,
      featuresFired,
    };
  }
}

/**
 * The move worth explaining instead of the one that was played.
 *
 * `bestMove` is the engine's own choice from the position before the move. Three cases produce
 * nothing to explain, and each is a real answer rather than a failure: the engine reported no
 * preference (`null`); it preferred the move the player actually made, in which case there is no
 * *better* move and the equality is the compliment; or the value does not look like a move at all.
 *
 * That last check is defence in depth. `MistakePredictionOutcome.bestMove` is documented as never
 * being the `'(none)'` sentinel, and this does not take that on trust, because the string would be
 * passed straight to the explainer as a move to explain.
 *
 * @param outcome - the verdict.
 * @param played - the move the player made.
 * @returns a UCI move to explain, or `null` when there is nothing better to say.
 */
function betterMoveOf(outcome: MistakePredictionOutcome, played: string): string | null {
  const best = outcome.bestMove;
  if (best === null || best === played) return null;
  if (!isUciShape(best)) return null;
  return best;
}

/**
 * Reduce a puzzle outcome to the coaching hint.
 *
 * Built field by field and never by spreading the outcome. That is deliberate and load-bearing: a
 * spread would mean any field later added to `PuzzleGenerationOutcome` — including another form of
 * solution — appears in the Coach response the day it is added, with no diff here to review. The
 * explicit construction makes such a field require a decision.
 *
 * @param outcome - what the puzzle service found.
 * @returns a present section for a real tactic, or an omission naming why there is none.
 */
function projectPuzzle(outcome: PuzzleGenerationOutcome): CoachSection<CoachPuzzleOutcome> {
  if (outcome.kind !== 'puzzle') return OMITTED('not_applicable');
  return {
    kind: 'present',
    value: {
      kind: 'puzzle',
      fen: outcome.fen,
      variant: outcome.variant,
      difficulty: outcome.difficulty,
    },
  };
}
