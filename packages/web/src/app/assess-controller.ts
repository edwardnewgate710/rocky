/**
 * Mistake Prediction controller — a pure, DOM-free orchestrator for the sidebar's assess block.
 *
 * The lifecycle is {@link MoveRequestController}, shared with `ExplainController`. The two controls
 * sit in one panel, ask two questions about the same last move, and have identical currency rules —
 * a repeat click is ignored rather than superseded because the request has already bought engine
 * searches, and a target change aborts, discards and does not re-run. Sharing the machine is what
 * keeps them from drifting apart the way `AnalysisController` and `ExplainController` did in
 * increment 4 (ADR-0118).
 */
import type { GambitClient } from '../api/client.js';
import type { MistakePredictionResponse } from '../api/models.js';
import type {
  MoveRequestCallbacks,
  MoveTarget,
  RequestFailure,
  RequestPhase,
} from './move-request-controller.js';
import { MoveRequestController } from './move-request-controller.js';

export type AssessPhase = RequestPhase;
export type AssessFailure = RequestFailure;
export type AssessCallbacks = MoveRequestCallbacks<MistakePredictionResponse>;
export type AssessTarget = MoveTarget;

export interface AssessControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: AssessCallbacks;
  /** Read at request time so it can never be stale. `null` when there is no move to assess. */
  readonly getTarget: () => AssessTarget | null;
}

export class AssessController {
  private readonly inner: MoveRequestController<MistakePredictionResponse>;

  constructor(opts: AssessControllerOptions) {
    this.inner = new MoveRequestController<MistakePredictionResponse>({
      client: opts.client,
      callbacks: opts.callbacks,
      getTarget: opts.getTarget,
      send: (client, target, signal) =>
        client.predictMistake(
          { fen: target.fen, variant: target.variant, move: target.move },
          signal,
        ),
    });
  }

  get isPending(): boolean {
    return this.inner.isPending;
  }

  async assess(): Promise<void> {
    return this.inner.run();
  }

  targetChanged(): void {
    this.inner.targetChanged();
  }

  dispose(): void {
    this.inner.dispose();
  }
}
