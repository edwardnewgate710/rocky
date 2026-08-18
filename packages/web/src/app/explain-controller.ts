/**
 * Move Explanation controller — a pure, DOM-free orchestrator for the sidebar's explain block.
 *
 * Deliberately the same lifecycle idiom as {@link AnalysisController}: generation guard, `disposed`
 * flag, `AbortController`, and `settle()` before the terminal callbacks. They sit in the same panel
 * under the same route disposal, and a second idiom here would be one more thing to get wrong.
 *
 * Two behaviours carry over for the same reasons, and both matter more here:
 *
 * - **A repeat request is ignored, not superseded.** The API still cannot observe a client
 *   disconnect (ADR-0113), so aborting does not stop the work: an accepted request has already
 *   bought engine searches and a paid completion. Superseding on every click would multiply real
 *   spend while merely looking responsive.
 * - **A position change supersedes.** The explanation describes a move the player has moved past, so
 *   it is aborted and discarded — and never re-run, because explaining is on demand and nobody asked
 *   for an explanation of every half-move.
 */
import type { GambitClient } from '../api/client.js';
import type { MoveExplanationResponse } from '../api/models.js';

export type ExplainPhase = 'idle' | 'loading' | 'result' | 'error';

export type ExplainFailure =
  /** 429 — the caller's own per-user limit, which is deliberately low because each call costs money. */
  | 'rate-limited'
  /** 503 — not configured, no provider, or the provider is unavailable. */
  | 'unavailable'
  /** 401 — explanation requires a signed-in caller. */
  | 'unauthenticated'
  /** 422 — the position or move was rejected. A bug on our side if a player sees it. */
  | 'rejected'
  /** Anything else: transport, timeout, decode. */
  | 'failed';

export interface ExplainCallbacks {
  onPhase: (phase: ExplainPhase) => void;
  onResult: (result: MoveExplanationResponse) => void;
  onFailure: (failure: ExplainFailure) => void;
  /** The displayed or pending explanation no longer describes the move on the board. */
  onInvalidated: () => void;
}

/** The move to explain: the position it was played from, and the move itself in full UCI. */
export interface ExplainTarget {
  readonly fen: string;
  readonly variant: string;
  readonly move: string;
}

export interface ExplainControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: ExplainCallbacks;
  /** Read at request time so it can never be stale. `null` when there is no move to explain. */
  readonly getTarget: () => ExplainTarget | null;
}

/**
 * Classify a rejection from its status alone.
 *
 * Never reads a message: the API deliberately returns fixed strings for provider failures precisely
 * so that nothing a vendor said reaches a user, and re-deriving meaning from that text would defeat
 * it. There is no `unsupported-variant` case here — the control is gated on the capability's variant
 * list before it is ever offered.
 */
export function classifyExplainFailure(err: unknown): ExplainFailure {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 429) return 'rate-limited';
  if (status === 503) return 'unavailable';
  if (status === 401) return 'unauthenticated';
  if (status === 422 || status === 400) return 'rejected';
  return 'failed';
}

export class ExplainController {
  private readonly client: GambitClient;
  private readonly callbacks: ExplainCallbacks;
  private readonly getTarget: ExplainControllerOptions['getTarget'];

  private generation = 0;
  private pending = false;
  private inFlight: AbortController | null = null;
  private disposed = false;
  /** The move the displayed or pending explanation belongs to, as `fen|move`. */
  private explainedKey: string | null = null;

  constructor(opts: ExplainControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.getTarget = opts.getTarget;
  }

  /** True while a request is on the wire. The view disables its control on this. */
  get isPending(): boolean {
    return this.pending;
  }

  async explain(): Promise<void> {
    if (this.disposed || this.pending) return;

    const target = this.getTarget();
    if (!target || target.fen === '' || target.move === '') return;

    const generation = ++this.generation;
    const controller = new AbortController();
    this.inFlight = controller;
    this.pending = true;
    this.explainedKey = keyOf(target);
    this.callbacks.onPhase('loading');

    try {
      const result = await this.client.explainMove(
        { fen: target.fen, variant: target.variant, move: target.move },
        controller.signal,
      );
      if (!this.isCurrent(generation)) return;
      // Settle before reporting, for the reason `AnalysisController` documents: a listener told the
      // phase is `result` re-derives the control's enabled state from `isPending`, and the honest
      // answer once the result exists is "not pending". Clearing only in `finally` left it disabled
      // with no further event to re-enable it.
      this.settle(controller);
      this.callbacks.onResult(result);
      this.callbacks.onPhase('result');
    } catch (err: unknown) {
      if (!this.isCurrent(generation) || controller.signal.aborted) return;
      this.settle(controller);
      this.callbacks.onFailure(classifyExplainFailure(err));
      this.callbacks.onPhase('error');
    } finally {
      this.settle(controller);
    }
  }

  /**
   * Tell the controller which move the board is showing now.
   *
   * Invalidates only when the target actually differs from the explained one, so the position
   * callbacks that fire on every snapshot — including ones re-reporting the same state — do not wipe
   * an explanation the player is still reading.
   */
  targetChanged(): void {
    if (this.disposed) return;
    const target = this.getTarget();
    const key = target ? keyOf(target) : null;
    if (this.explainedKey === null || key === this.explainedKey) return;

    this.explainedKey = null;
    this.abortInFlight();
    this.callbacks.onInvalidated();
    this.callbacks.onPhase('idle');
  }

  dispose(): void {
    this.disposed = true;
    this.abortInFlight();
    this.explainedKey = null;
  }

  private abortInFlight(): void {
    // Bumping the generation as well as aborting, exactly as `AnalysisController` does and for the
    // reason recorded there: `abort()` alone races a response that has already resolved and is only
    // waiting for its microtask. That response would still pass `isCurrent`, so an explanation of the
    // move the player has just moved past would paint over the cleared panel. The abort was here and
    // the bump was not — found in the independent review of PR #135.
    this.generation += 1;
    this.inFlight?.abort();
    this.settleAll();
  }

  private settle(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.pending = false;
    }
  }

  private settleAll(): void {
    this.inFlight = null;
    this.pending = false;
  }

  /** A result is current only if it is the newest request and the controller still exists. */
  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }
}

/** Identity of an explanation: the same move from the same position is the same answer. */
function keyOf(target: ExplainTarget): string {
  return `${target.fen}|${target.move}`;
}
