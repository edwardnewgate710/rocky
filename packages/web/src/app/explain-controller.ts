/**
 * Move Explanation controller — a pure, DOM-free orchestrator for the sidebar's explain block.
 *
 * The lifecycle lives in {@link MoveRequestController}, which this and `AssessController` share: two
 * controls in one panel, asking two questions about the same last move, with identical currency
 * rules. Keeping the machine in one place is not tidiness — the only defect the independent review
 * of PR #135 found was a divergence between two hand-maintained copies of it (M15 increment 5).
 *
 * The public surface here is unchanged from increment 4, deliberately: `game-mount.ts` and
 * `explain-controller.test.ts` both drive it, and a rename would turn a contained refactor into a
 * change to a shipped feature.
 */
import type { GambitClient } from '../api/client.js';
import type { MoveExplanationResponse } from '../api/models.js';
import type {
  MoveRequestCallbacks,
  MoveTarget,
  RequestFailure,
  RequestPhase,
} from './move-request-controller.js';
import { MoveRequestController, classifyRequestFailure } from './move-request-controller.js';

export type ExplainPhase = RequestPhase;
export type ExplainFailure = RequestFailure;
export type ExplainCallbacks = MoveRequestCallbacks<MoveExplanationResponse>;
export type ExplainTarget = MoveTarget;

export interface ExplainControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: ExplainCallbacks;
  /** Read at request time so it can never be stale. `null` when there is no move to explain. */
  readonly getTarget: () => ExplainTarget | null;
}

/** Kept exported: `classifyExplainFailure` is the name the increment-4 tests and callers know. */
export const classifyExplainFailure = classifyRequestFailure;

export class ExplainController {
  private readonly inner: MoveRequestController<MoveExplanationResponse>;

  constructor(opts: ExplainControllerOptions) {
    this.inner = new MoveRequestController<MoveExplanationResponse>({
      client: opts.client,
      callbacks: opts.callbacks,
      getTarget: opts.getTarget,
      send: (client, target, signal) =>
        client.explainMove(
          { fen: target.fen, variant: target.variant, move: target.move },
          signal,
        ),
    });
  }

  get isPending(): boolean {
    return this.inner.isPending;
  }

  async explain(): Promise<void> {
    return this.inner.run();
  }

  targetChanged(): void {
    this.inner.targetChanged();
  }

  dispose(): void {
    this.inner.dispose();
  }
}
