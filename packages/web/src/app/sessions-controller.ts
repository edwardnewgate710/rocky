/**
 * Sessions controller — a pure, DOM-free orchestrator for the account-security screen's active
 * sessions list (listing and revoking).
 *
 * Mirrors {@link PasskeysController} deliberately: same dual-generation guards, same `disposed`
 * flag, same callback shape. The two sit side by side in the same panel and are torn down by the
 * same route disposal, so a second lifecycle idiom here would be one more thing to get wrong.
 *
 * On what revoking reaches: a session row is the refresh capability, so revoking one stops it
 * minting further access tokens. An access token already issued for that session is a stateless
 * HMAC the API verifies by signature alone, so it keeps working until it expires. The UI must not
 * promise an instant cutoff it cannot deliver.
 */
import type { GambitClient } from '../api/client.js';
import type { SessionView } from '../api/models.js';

export interface SessionsCallbacks {
  /** Called when the session list updates. */
  onSessions: (sessions: readonly SessionView[]) => void;
  /** Called when an async operation is pending (for disabled state). */
  onPending: (pending: boolean) => void;
  /** Called when an error occurs. */
  onError: (message: string) => void;
  /** Called when a status message should be announced. */
  onStatus?: (message: string) => void;
}

export interface SessionsControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: SessionsCallbacks;
}

export class SessionsController {
  private readonly client: GambitClient;
  private readonly callbacks: SessionsCallbacks;
  private sessions: readonly SessionView[] = [];
  private requestGeneration = 0;
  private pendingGeneration = 0;
  private disposed = false;
  /**
   * Ids with a revocation in flight. `pending` alone disables the whole list, but a second click
   * can still land in the same tick before the flag propagates to the DOM, and two DELETEs for one
   * id would produce a second audit record for a state change that happened once.
   */
  private readonly inFlight = new Set<string>();

  constructor(opts: SessionsControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
  }

  /** Current sessions snapshot. */
  get currentSessions(): readonly SessionView[] {
    return this.sessions;
  }

  /** Fetch the authoritative list of sessions. */
  async load(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    try {
      const list = await this.client.auth.sessions();
      if (!this.isCurrent(generation)) return;
      this.sessions = list;
      this.callbacks.onSessions(list);
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Revoke one session by id, then refresh the list from the server. */
  async revokeSession(id: string): Promise<void> {
    if (this.disposed) return;
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);

    const generation = ++this.requestGeneration;
    const pendingGeneration = this.beginPending();
    try {
      await this.client.auth.revokeSession(id);
      if (!this.isCurrent(generation)) return;

      this.callbacks.onStatus?.('Session revoked.');
      await this.load();
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.inFlight.delete(id);
      this.endPending(pendingGeneration);
    }
  }

  /** Invalidate pending requests and clear local session state. */
  reset(): void {
    if (this.disposed) return;
    this.requestGeneration++;
    this.sessions = [];
    this.inFlight.clear();
  }

  /** Permanently dispose the controller. */
  dispose(): void {
    this.disposed = true;
    this.inFlight.clear();
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.requestGeneration;
  }

  private beginPending(): number {
    const generation = ++this.pendingGeneration;
    this.callbacks.onPending(true);
    return generation;
  }

  private endPending(generation: number): void {
    if (!this.disposed && generation === this.pendingGeneration) {
      this.callbacks.onPending(false);
    }
  }
}
