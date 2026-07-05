/**
 * Typed WebSocket client — connection lifecycle, automatic reconnect, and
 * heartbeat, sitting above the {@link WebSocketFactory} port.
 *
 * Responsibilities (transport-level, game-agnostic):
 *  - manage a small state machine (idle → connecting → open → reconnecting → closed);
 *  - encode/decode frames through {@link encodeClient}/{@link decodeServer} so
 *    callers exchange typed {@link ClientMessage}/{@link ServerMessage} values;
 *  - reconnect automatically on unexpected drops with exponential backoff +
 *    jitter (reusing the REST layer's {@link computeBackoff}), while never
 *    reconnecting after an intentional {@link WsClient.close};
 *  - keep the link alive with a ping/pong heartbeat and drop a silent socket so
 *    the reconnect path can recover it.
 *
 * Timers, clock and RNG are injected so the whole thing is deterministic in
 * tests. It knows nothing about games — {@link GameSync} layers that on top.
 */
import type { ClientMessage, ServerMessage } from './ws-protocol.js';
import { decodeServer, encodeClient } from './ws-protocol.js';
import type { SocketHandlers, WebSocketConnection, WebSocketFactory, WsCloseInfo } from '../ports/ws.js';
import { browserWebSocketFactory } from '../ports/ws.js';
import { computeBackoff } from './retry.js';

export type WsConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WsReconnectPolicy {
  readonly enabled: boolean;
  /** Max reconnect attempts before giving up. Use Infinity for unlimited. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitter: 'full' | 'none';
}

export const DEFAULT_RECONNECT_POLICY: WsReconnectPolicy = {
  enabled: true,
  maxAttempts: Number.POSITIVE_INFINITY,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitter: 'full',
};

/** Timer seam so reconnect/heartbeat scheduling is deterministic in tests. */
export interface Scheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultScheduler: Scheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WsClientListeners {
  readonly open?: () => void;
  readonly message?: (msg: ServerMessage) => void;
  readonly close?: (info: WsCloseInfo) => void;
  readonly error?: (error: unknown) => void;
  readonly statechange?: (state: WsConnectionState) => void;
  readonly reconnecting?: (attempt: number, delayMs: number) => void;
  readonly pong?: (rttMs: number) => void;
}

export interface WsClientOptions {
  /** Connection URL, or a factory called per-attempt (e.g. to inject a fresh token). */
  readonly url: string | (() => string);
  readonly factory?: WebSocketFactory;
  readonly reconnect?: Partial<WsReconnectPolicy>;
  /** Heartbeat ping interval in ms. 0 disables. Default 25000. */
  readonly heartbeatMs?: number;
  /** Extra grace beyond one interval before a silent link is considered dead. Default 10000. */
  readonly heartbeatTimeoutMs?: number;
  readonly scheduler?: Scheduler;
  readonly now?: () => number;
  readonly rng?: () => number;
}

export class WsClient {
  private readonly urlSource: string | (() => string);
  private readonly factory: WebSocketFactory;
  private readonly reconnect: WsReconnectPolicy;
  private readonly heartbeatMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly rng: () => number;

  private conn: WebSocketConnection | null = null;
  private stateValue: WsConnectionState = 'idle';
  private intentionalClose = false;
  private reconnectAttempts = 0;
  private reconnectHandle: unknown = null;
  private heartbeatHandle: unknown = null;
  private lastActivityAt = 0;
  private rttMs: number | null = null;
  private readonly listeners = new Set<WsClientListeners>();

  constructor(options: WsClientOptions) {
    this.urlSource = options.url;
    this.factory = options.factory ?? browserWebSocketFactory();
    this.reconnect = { ...DEFAULT_RECONNECT_POLICY, ...options.reconnect };
    this.heartbeatMs = options.heartbeatMs ?? 25_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.now = options.now ?? ((): number => Date.now());
    this.rng = options.rng ?? Math.random;
  }

  get state(): WsConnectionState {
    return this.stateValue;
  }

  /** Last measured round-trip time (ms) from ping/pong, or null. */
  get rtt(): number | null {
    return this.rttMs;
  }

  /** Register listeners; returns an unsubscribe function. */
  on(listeners: WsClientListeners): () => void {
    this.listeners.add(listeners);
    return () => {
      this.listeners.delete(listeners);
    };
  }

  connect(): void {
    if (this.stateValue === 'open' || this.stateValue === 'connecting' || this.stateValue === 'reconnecting') {
      return;
    }
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.openSocket();
  }

  /** Send a typed intent. Returns false if the socket is not open. */
  send(msg: ClientMessage): boolean {
    if (this.stateValue !== 'open' || !this.conn) return false;
    try {
      this.conn.send(encodeClient(msg));
      return true;
    } catch (error) {
      this.emit('error', error);
      return false;
    }
  }

  /** Close intentionally: cancels reconnect/heartbeat and never auto-reconnects. */
  close(code?: number, reason?: string): void {
    this.intentionalClose = true;
    this.clearReconnect();
    this.stopHeartbeat();
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      try {
        conn.close(code, reason);
      } catch {
        /* ignore close errors */
      }
    }
    this.setState('closed');
  }

  private openSocket(): void {
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    const url = typeof this.urlSource === 'function' ? this.urlSource() : this.urlSource;
    const handlers: SocketHandlers = {
      onOpen: () => this.handleOpen(),
      onMessage: (data) => this.handleMessage(data),
      onClose: (info) => this.handleClose(info),
      onError: (error) => this.emit('error', error),
    };
    try {
      this.conn = this.factory(url, handlers);
    } catch (error) {
      this.emit('error', error);
      this.conn = null;
      this.scheduleReconnect();
    }
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    this.lastActivityAt = this.now();
    this.setState('open');
    this.startHeartbeat();
    this.emit('open');
  }

  private handleMessage(data: string): void {
    this.lastActivityAt = this.now();
    const msg = decodeServer(data);
    if (!msg) {
      this.emit('error', new Error('received malformed server frame'));
      return;
    }
    if (msg.t === 'pong') {
      this.rttMs = Math.max(0, this.now() - msg.ts);
      this.emit('pong', this.rttMs);
      return;
    }
    this.emit('message', msg);
  }

  private handleClose(info: WsCloseInfo): void {
    this.stopHeartbeat();
    this.conn = null;
    this.emit('close', info);
    if (this.intentionalClose || !this.reconnect.enabled) {
      this.setState('closed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts + 1 > this.reconnect.maxAttempts) {
      this.setState('closed');
      return;
    }
    this.reconnectAttempts += 1;
    const delay = computeBackoff(
      this.reconnectAttempts - 1,
      {
        maxAttempts: this.reconnect.maxAttempts,
        baseDelayMs: this.reconnect.baseDelayMs,
        maxDelayMs: this.reconnect.maxDelayMs,
        jitter: this.reconnect.jitter,
      },
      this.rng,
    );
    this.setState('reconnecting');
    this.emit('reconnecting', this.reconnectAttempts, delay);
    this.reconnectHandle = this.scheduler.setTimeout(() => {
      this.reconnectHandle = null;
      this.openSocket();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.scheduler.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    this.reconnectAttempts = 0;
  }

  private startHeartbeat(): void {
    if (this.heartbeatMs <= 0) return;
    this.armHeartbeat();
  }

  private armHeartbeat(): void {
    this.heartbeatHandle = this.scheduler.setTimeout(() => this.heartbeatTick(), this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.scheduler.clearTimeout(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  private heartbeatTick(): void {
    if (this.stateValue !== 'open' || !this.conn) return;
    if (this.now() - this.lastActivityAt > this.heartbeatMs + this.heartbeatTimeoutMs) {
      // The link has gone silent; drop it so handleClose can reconnect it.
      try {
        this.conn.close(4000, 'heartbeat timeout');
      } catch {
        /* ignore */
      }
      return;
    }
    this.send({ t: 'ping', ts: this.now() });
    this.armHeartbeat();
  }

  private setState(next: WsConnectionState): void {
    if (this.stateValue === next) return;
    this.stateValue = next;
    this.emit('statechange', next);
  }

  private emit<K extends keyof WsClientListeners>(
    key: K,
    ...args: Parameters<NonNullable<WsClientListeners[K]>>
  ): void {
    for (const listener of [...this.listeners]) {
      const handler = listener[key];
      if (handler) (handler as (...a: unknown[]) => void)(...args);
    }
  }
}
