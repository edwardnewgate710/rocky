/**
 * Lifecycle for the tournament commentary section (M15 inc 22, ADR-0130).
 *
 * DOM-free, like every other controller here: it owns *when* a request happens and which answer is
 * allowed to render, and knows nothing about how the result looks.
 *
 * It follows `CoachController` closely, and the one difference is worth stating. Coaching is about
 * a board that moves under the reader, so its staleness problem is that the answer arrives about a
 * position that has been left behind. Commentary is about a finished game and a completed round —
 * facts that cannot change — so the stale answer here is not wrong about chess, it is about a
 * *different tournament page* than the one now open. Same guard, different reason: a reader who
 * clicks through two tournaments while a request is in flight must not be shown the first one's
 * narrative under the second one's heading.
 */
import type { GambitClient } from '../api/client.js';
import type { TournamentGameCommentary, TournamentRoundRecap } from '../api/models.js';
import type { AnalysisFailure } from './analysis-controller.js';
import { classifyFailure } from './analysis-controller.js';

export type CommentaryPhase = 'idle' | 'loading' | 'result' | 'error';

/**
 * The analysis vocabulary plus the one refusal only this feature can receive.
 *
 * `AnalysisFailure` is imported rather than restated — a second copy would be free to drift from
 * `classifyFailure`, which is the function that decides which of them a response is. `not-ready` is
 * added here rather than there because 409 is not a failure any analysis route produces: it is this
 * feature's ordinary answer for a game still being played or a round still in progress, and the
 * shared classifier maps it to `failed`, which would tell a reader something went wrong when
 * nothing did.
 */
export type CommentaryFailure = AnalysisFailure | 'not-ready';

/**
 * Classify a commentary failure, handling the one status the shared classifier has no case for.
 *
 * @param error - the thrown value.
 * @returns the failure this section will render.
 */
function classifyCommentaryFailure(error: unknown): CommentaryFailure {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 409) return 'not-ready';
  return classifyFailure(error);
}

/** What a commentary request is about. */
export type CommentaryTarget =
  | { readonly kind: 'game'; readonly tournamentId: string; readonly gameId: string }
  | { readonly kind: 'round'; readonly tournamentId: string; readonly round: number };

/** What came back, tagged so a single section can render either. */
export type CommentaryResult =
  | { readonly kind: 'game'; readonly value: TournamentGameCommentary }
  | { readonly kind: 'round'; readonly value: TournamentRoundRecap };

export interface TournamentCommentaryControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: {
    onPhase: (phase: CommentaryPhase) => void;
    onResult: (result: CommentaryResult) => void;
    onFailure: (failure: CommentaryFailure) => void;
    onInvalidated: () => void;
  };
}

/**
 * Identity of a commentary question.
 *
 * @param target - the request about to be made.
 * @returns a key that changes whenever the question does.
 */
function key(target: CommentaryTarget): string {
  return target.kind === 'game'
    ? `game|${target.tournamentId}|${target.gameId}`
    : `round|${target.tournamentId}|${String(target.round)}`;
}

export class TournamentCommentaryController {
  private readonly client: GambitClient;
  private readonly callbacks: TournamentCommentaryControllerOptions['callbacks'];
  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;
  private targetKey: string | null = null;

  constructor(options: TournamentCommentaryControllerOptions) {
    this.client = options.client;
    this.callbacks = options.callbacks;
  }

  get isPending(): boolean {
    return this.pending;
  }

  /**
   * Ask the server for a commentary or a recap.
   *
   * A second call for the same target while one is in flight coalesces to nothing — the answer
   * already on its way is the answer, and each accepted request costs a metered completion, so
   * issuing a second one would spend the reader's quota to learn what is already coming. A call for
   * a *different* target abandons the first.
   *
   * @param target - the game or round to describe.
   */
  async request(target: CommentaryTarget): Promise<void> {
    if (this.disposed) return;

    const currentKey = key(target);
    if (this.pending) {
      if (this.targetKey === currentKey) return;
      this.abortInFlight();
    }

    const generation = ++this.generation;
    const controller = new AbortController();
    this.pending = true;
    this.inFlight = controller;
    this.targetKey = currentKey;
    this.callbacks.onPhase('loading');

    try {
      const result: CommentaryResult =
        target.kind === 'game'
          ? {
              kind: 'game',
              value: await this.client.tournaments.gameCommentary(
                target.tournamentId,
                target.gameId,
                controller.signal,
              ),
            }
          : {
              kind: 'round',
              value: await this.client.tournaments.roundRecap(
                target.tournamentId,
                target.round,
                controller.signal,
              ),
            };
      if (!this.isCurrent(generation)) return;
      this.settle(controller);
      this.callbacks.onResult(result);
      this.callbacks.onPhase('result');
    } catch (error: unknown) {
      // An aborted request is one this controller abandoned on purpose; reporting it as a failure
      // would show the reader an error for something they caused by moving on.
      //
      // The generation check is the whole of it. `abortInFlight` bumps the generation before it
      // aborts, and it is the only thing in this class that aborts, so a `controller.signal.aborted`
      // clause beside this one could never decide anything — and a test appearing to cover it would
      // be covering nothing. Raised in the adversarial review of this increment.
      if (!this.isCurrent(generation)) return;
      this.settle(controller);
      this.callbacks.onFailure(classifyCommentaryFailure(error));
      this.callbacks.onPhase('error');
    } finally {
      this.settle(controller);
    }
  }

  /**
   * The reader is looking at something else now.
   *
   * @param target - the new target, or `null` when there is none. A target identical to the one
   * already rendered is not a change, so a redundant refresh does not clear a good result.
   */
  targetChanged(target: CommentaryTarget | null): void {
    if (this.disposed || this.targetKey === null) return;
    if (target !== null && this.targetKey === key(target)) return;
    this.invalidate();
  }

  /** There is nothing to describe any more — the page closed, or the reader signed out. */
  targetLost(): void {
    if (this.disposed || this.targetKey === null) return;
    this.invalidate();
  }

  /** Abandon everything in flight and refuse to start anything further. */
  dispose(): void {
    this.disposed = true;
    this.abortInFlight();
    this.targetKey = null;
  }

  /** Drop the rendered answer and stop whatever was producing the next one. */
  private invalidate(): void {
    this.abortInFlight();
    this.targetKey = null;
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('idle');
  }

  /**
   * Release the pending flag, but only for the request that still owns it.
   *
   * @param controller - the request finishing. A superseded one must not clear a flag a newer
   * request set, which is why this compares identity rather than just assigning `false`.
   */
  private settle(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.pending = false;
    }
  }

  /**
   * Abandon whatever is open.
   *
   * The generation bump matters beside the `abort()`: a response that has already resolved and
   * queued as a microtask is past the point where aborting the request can stop it, and only the
   * generation check will keep it from rendering.
   */
  private abortInFlight(): void {
    this.generation += 1;
    this.inFlight?.abort();
    this.inFlight = null;
    this.pending = false;
  }

  /**
   * @param generation - the generation a request was issued under.
   * @returns whether its answer is still the one being waited for.
   */
  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
}
