/**
 * Lobby controller — a pure, DOM-free orchestrator that manages the seek list
 * and seek creation/cancellation lifecycle.
 *
 * It fetches open seeks from the API, exposes callbacks for list updates,
 * and forwards create/cancel actions to the `SeeksApi`. Like
 * {@link GameController}, it never touches the DOM; the bootstrap layer wires
 * callbacks to DOM elements.
 *
 * This module is the "lobby view" wiring that M6 requires. It imports from the
 * API layer (`GambitClient`) only — no chess rules, no networking internals.
 */
import type { GambitClient } from '../api/client.js';
import type { SeekView, CreateSeekRequest, Variant, TimeControl } from '../api/models.js';

/** Callbacks the bootstrap wires to DOM elements. */
export interface LobbyCallbacks {
  /** Called when the seek list is refreshed (full replacement). */
  onSeeks: (seeks: readonly SeekView[]) => void;
  /** Called when a seek is being created (for UI spinner/disabled state). */
  onCreatePending: (pending: boolean) => void;
  /** Called when an error occurs (for UI error display). */
  onError: (message: string) => void;
}

export interface LobbyControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: LobbyCallbacks;
  /** Auto-refresh interval in milliseconds (0 = disabled). */
  readonly refreshIntervalMs?: number;
  /** Whether the user is authenticated (gates create-seek). */
  readonly isAuthenticated?: () => boolean;
  /** Injected timer (for tests). */
  readonly setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

/**
 * Manages the lobby seek list lifecycle: fetching, creating, and cancelling seeks.
 *
 * The controller is framework-independent and DOM-free. It owns the refresh
 * timer and drives the UI through callbacks. The caller is responsible for
 * connecting callbacks to DOM elements in the bootstrap layer.
 */
export class LobbyController {
  private readonly client: GambitClient;
  private readonly callbacks: LobbyCallbacks;
  private readonly refreshIntervalMs: number;
  private readonly isAuthenticated: (() => boolean) | undefined;
  private readonly _setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly _clearInterval: (id: ReturnType<typeof setInterval>) => void;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private seeks: readonly SeekView[] = [];
  private disposed = false;

  constructor(opts: LobbyControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 10_000;
    this.isAuthenticated = opts.isAuthenticated;
    this._setInterval = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this._clearInterval = opts.clearInterval ?? ((id) => clearInterval(id));
  }

  /** Current seek list (snapshot). */
  get currentSeeks(): readonly SeekView[] {
    return this.seeks;
  }

  /** Fetch the seek list once and notify callbacks. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      this.seeks = await this.client.seeks.list();
      this.callbacks.onSeeks(this.seeks);
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Start the auto-refresh timer and do an immediate fetch. */
  start(): void {
    if (this.timerId !== null) return;
    void this.refresh();
    if (this.refreshIntervalMs > 0) {
      this.timerId = this._setInterval(() => void this.refresh(), this.refreshIntervalMs);
    }
  }

  /** Stop the auto-refresh timer. */
  stop(): void {
    if (this.timerId !== null) {
      this._clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /** Create a new seek. Returns the created seek on success. */
  async createSeek(params: {
    variant: Variant;
    timeControl: TimeControl;
    rated?: boolean;
    minRating?: number | null;
    maxRating?: number | null;
  }): Promise<SeekView | null> {
    if (this.disposed) return null;
    // M2: gate create-seek on session presence — POST /v1/seeks requires bearer auth.
    if (this.isAuthenticated !== undefined && !this.isAuthenticated()) {
      this.callbacks.onError('Sign in to create a seek.');
      return null;
    }
    this.callbacks.onCreatePending(true);
    try {
      const body: CreateSeekRequest = {
        variant: params.variant,
        timeControl: params.timeControl,
        ...(params.rated !== undefined ? { rated: params.rated } : {}),
        ...(params.minRating !== undefined ? { minRating: params.minRating } : {}),
        ...(params.maxRating !== undefined ? { maxRating: params.maxRating } : {}),
      };
      const seek = await this.client.seeks.create(body);
      // Refresh the list to include the new seek.
      await this.refresh();
      return seek;
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      this.callbacks.onCreatePending(false);
    }
  }

  /** Cancel (delete) a seek by ID. */
  async cancelSeek(id: string): Promise<boolean> {
    if (this.disposed) return false;
    try {
      await this.client.seeks.cancel(id);
      await this.refresh();
      return true;
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /** Permanently dispose the controller: stop the timer and ignore future calls. */
  dispose(): void {
    this.stop();
    this.disposed = true;
  }
}
