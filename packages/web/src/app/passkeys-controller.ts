/**
 * Passkeys controller — a pure, DOM-free orchestrator that manages the
 * user's WebAuthn passkey credentials (listing, registering, deleting).
 *
 * Like {@link ProfileController} and {@link SocialController}, it never
 * touches the DOM; the bootstrap layer wires callbacks to DOM elements.
 */
import type { GambitClient } from '../api/client.js';
import type { PasskeyView } from '../api/models.js';
import { NativeWebAuthnAdapter } from '../ports/webauthn.js';
import type { WebAuthnAdapter } from '../ports/webauthn.js';

export interface PasskeysCallbacks {
  /** Called when the passkey list updates. */
  onPasskeys: (passkeys: readonly PasskeyView[]) => void;
  /** Called when an async operation is pending (for UI spinner/disabled state). */
  onPending: (pending: boolean) => void;
  /** Called when an error occurs. */
  onError: (message: string) => void;
  /** Called when a status message should be announced. */
  onStatus?: (message: string) => void;
}

export interface PasskeysControllerOptions {
  readonly client: GambitClient;
  readonly callbacks: PasskeysCallbacks;
  readonly webauthnAdapter?: WebAuthnAdapter;
}

export class PasskeysController {
  private readonly client: GambitClient;
  private readonly callbacks: PasskeysCallbacks;
  private readonly webauthnAdapter: WebAuthnAdapter;
  private passkeys: readonly PasskeyView[] = [];
  private requestGeneration = 0;
  private pendingGeneration = 0;
  private disposed = false;

  constructor(opts: PasskeysControllerOptions) {
    this.client = opts.client;
    this.callbacks = opts.callbacks;
    this.webauthnAdapter = opts.webauthnAdapter ?? new NativeWebAuthnAdapter();
  }

  /** Current passkeys snapshot. */
  get currentPasskeys(): readonly PasskeyView[] {
    return this.passkeys;
  }

  /** Fetch the authoritative list of passkeys. */
  async load(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    try {
      const list = await this.client.auth.listPasskeys();
      if (!this.isCurrent(generation)) return;
      this.passkeys = list;
      this.callbacks.onPasskeys(list);
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Register a new passkey using native browser WebAuthn ceremony. */
  async registerPasskey(): Promise<void> {
    if (this.disposed) return;
    if (!this.webauthnAdapter.isSupported()) {
      this.callbacks.onError('Passkeys are not supported in this browser.');
      return;
    }
    const generation = ++this.requestGeneration;
    const pendingGeneration = this.beginPending();
    try {
      const options = await this.client.auth.registerPasskeyOptions();
      if (!this.isCurrent(generation)) return;

      const response = await this.webauthnAdapter.createCredential(options);
      if (!this.isCurrent(generation)) return;

      await this.client.auth.verifyPasskeyRegister(response);
      if (!this.isCurrent(generation)) return;

      this.callbacks.onStatus?.('Passkey registered successfully.');
      await this.load();
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.endPending(pendingGeneration);
    }
  }

  /** Delete a passkey by ID. */
  async deletePasskey(id: string): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.requestGeneration;
    const pendingGeneration = this.beginPending();
    try {
      await this.client.auth.deletePasskey(id);
      if (!this.isCurrent(generation)) return;

      this.callbacks.onStatus?.('Passkey deleted.');
      await this.load();
    } catch (err) {
      if (this.isCurrent(generation)) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      this.endPending(pendingGeneration);
    }
  }

  /** Invalidate pending requests and clear local passkeys state. */
  reset(): void {
    if (this.disposed) return;
    this.requestGeneration++;
    this.passkeys = [];
  }

  /** Permanently dispose the controller. */
  dispose(): void {
    this.disposed = true;
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
