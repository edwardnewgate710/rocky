/**
 * Lifecycle for the coaching sidebar section (M15 inc 21, ADR-0129).
 *
 * DOM-free, like every other controller here: it owns *when* a request happens and which answer is
 * allowed to render, and knows nothing about how the result looks.
 *
 * The stale-response problem is sharper for this section than for the others. Coaching is the most
 * expensive request the API serves — up to four engine searches and a provider call — so it is also
 * the slowest, which means a player who moves twice while one is in flight is the ordinary case
 * rather than the edge case. An answer about a position that is two moves stale would be rendered
 * beside a board that has moved on, and every word of it would be wrong about what the reader is
 * looking at. The generation counter, not the abort, is what guarantees that cannot happen: a
 * response that has already resolved and queued as a microtask is past the point where aborting the
 * request can stop it.
 */
import type { GambitClient } from '../api/client.js';
import type { CoachResponse } from '../api/models.js';
import type { AnalysisFailure } from './analysis-controller.js';
import { classifyFailure } from './analysis-controller.js';

/**
 * The server's ply ceiling, restated so the UI can decline a too-long sequence rather than spend a
 * request learning it. Pinned to the server's `MAX_COACH_PLIES` by a contract test.
 */
export const MAX_COACH_PLIES = 60;

export type CoachPhase = 'idle' | 'loading' | 'result' | 'error';

/**
 * The same failure vocabulary the analysis section uses, imported rather than restated.
 *
 * A second copy would be free to drift from `classifyFailure`, which is the function that actually
 * decides which of these a response is — and a union that disagrees with its own classifier fails
 * silently, by rendering the wrong message.
 */
export type CoachFailure = AnalysisFailure;

/** What a coaching request is about: the position, and optionally the move and the route to it. */
export interface CoachTarget {
  readonly fen: string;
  readonly variant: string;
  readonly move?: string | undefined;
  readonly moves?: readonly string[] | undefined;
}

export interface CoachControllerOptions {
  readonly client: GambitClient;
  readonly getTarget: () => CoachTarget | null;
  readonly callbacks: {
    onPhase: (phase: CoachPhase) => void;
    onResult: (result: CoachResponse) => void;
    onFailure: (failure: CoachFailure) => void;
    onInvalidated: () => void;
  };
}

/**
 * Identity of a coaching question.
 *
 * Every field the request carries is in the key, because two targets differing in any of them are
 * different questions with different answers. The move sequence is included even though the FEN
 * usually determines the position: the opening section is about the *route* to the position, and two
 * different move orders reaching the same FEN are a transposition the server declines to identify
 * (ADR-0127), so they are not interchangeable here either.
 *
 * @param target - the request about to be made.
 * @returns a key that changes whenever the question does.
 */
function key(target: CoachTarget): string {
  return [
    target.variant,
    target.fen,
    target.move ?? '',
    target.moves ? target.moves.join(' ') : '',
  ].join('|');
}

export class CoachController {
  private readonly client: GambitClient;
  private readonly getTarget: CoachControllerOptions['getTarget'];
  private readonly callbacks: CoachControllerOptions['callbacks'];
  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;
  private targetKey: string | null = null;

  constructor(options: CoachControllerOptions) {
    this.client = options.client;
    this.getTarget = options.getTarget;
    this.callbacks = options.callbacks;
  }

  get isPending(): boolean {
    return this.pending;
  }

  /**
   * Ask the server to coach the current target.
   *
   * A second call for the same target while one is in flight coalesces to nothing — the answer
   * already on its way is the answer. A call for a *different* target abandons the first, because
   * its answer is about a position the reader has left.
   */
  async coach(): Promise<void> {
    if (this.disposed) return;
    const target = this.getTarget();
    if (!target) return;

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
      const result = await this.client.analysis.coach(
        {
          fen: target.fen,
          variant: target.variant,
          ...(target.move !== undefined ? { move: target.move } : {}),
          ...(target.moves !== undefined ? { moves: target.moves } : {}),
        },
        controller.signal,
      );
      if (!this.isCurrent(generation)) return;
      this.settle(controller);
      this.callbacks.onResult(result);
      this.callbacks.onPhase('result');
    } catch (error: unknown) {
      // An aborted request is one this controller abandoned on purpose; reporting it as a failure
      // would show the reader an error for something they caused by moving on.
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      this.settle(controller);
      this.callbacks.onFailure(classifyFailure(error));
      this.callbacks.onPhase('error');
    } finally {
      this.settle(controller);
    }
  }

  /**
   * The board moved on.
   *
   * @param target - the new target, or `null` when there is none. A target identical to the one
   * already rendered is not a change, so a redundant refresh does not clear a good result.
   */
  positionChanged(target: CoachTarget | null): void {
    if (this.disposed || this.targetKey === null) return;
    if (target !== null && this.targetKey === key(target)) return;
    this.invalidate();
  }

  /** There is no position to coach any more — the game ended, or the reader signed out. */
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
