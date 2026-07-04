/**
 * @packageDocumentation
 * Transport abstraction for the gateway.
 *
 * The gateway logic never touches a socket directly — it talks to
 * {@link Connection}, a minimal duplex message channel. This keeps the
 * session/room/authority logic deterministically unit-testable via
 * {@link InMemoryConnection}, while a production build binds the same interface
 * to a WebSocket server (see the adapter seam below).
 */

import type { ClientMessage, ServerMessage } from './protocol';

/** A single bidirectional client connection, decoupled from any socket impl. */
export interface Connection {
  /** Stable per-connection id (unique for the lifetime of the process). */
  readonly id: string;
  /** Send an authoritative message to the client. Must not throw. */
  send(msg: ServerMessage): void;
  /** Register the handler invoked for each inbound client message. */
  onMessage(handler: (msg: ClientMessage) => void): void;
  /** Register the handler invoked once when the connection closes. */
  onClose(handler: () => void): void;
  /** Close the connection and trigger close handlers. Idempotent. */
  close(): void;
}

let counter = 0;

/**
 * In-memory {@link Connection} for tests and benchmarks. The test drives the
 * client side with {@link deliver}; server output is captured in {@link sent}.
 */
export class InMemoryConnection implements Connection {
  readonly id: string;
  /** Every server message sent to this connection, in order. */
  readonly sent: ServerMessage[] = [];
  private messageHandler: ((msg: ClientMessage) => void) | null = null;
  private closeHandlers: (() => void)[] = [];
  private closed = false;

  constructor(id?: string) {
    this.id = id ?? `mem-${++counter}`;
  }

  send(msg: ServerMessage): void {
    if (this.closed) return;
    this.sent.push(msg);
  }

  onMessage(handler: (msg: ClientMessage) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers) h();
  }

  /** Simulate the client sending a message to the server. */
  deliver(msg: ClientMessage): void {
    if (this.closed) throw new Error('connection is closed');
    this.messageHandler?.(msg);
  }

  /** The most recent server message of a given type, or `undefined`. */
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]!.t === t) return this.sent[i] as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }

  /** All server messages of a given type, in order. */
  all<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m) => m.t === t) as Extract<ServerMessage, { t: T }>[];
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/*
 * ── WebSocket adapter seam ──────────────────────────────────────────────────
 * A production build wraps a `ws` (or `uWebSockets.js`) socket in this same
 * `Connection` interface, e.g.:
 *
 *   import { WebSocketServer } from 'ws';
 *   import { decode, encode } from './protocol';
 *
 *   export function serveWebSocket(gateway: RealtimeGateway, port: number) {
 *     const wss = new WebSocketServer({ port });
 *     wss.on('connection', (ws) => {
 *       const conn: Connection = {
 *         id: crypto.randomUUID(),
 *         send: (m) => ws.send(encode(m)),
 *         onMessage: (h) => ws.on('message', (d) => { const m = decode(String(d)); if (m) h(m); }),
 *         onClose: (h) => ws.on('close', h),
 *         close: () => ws.close(),
 *       };
 *       gateway.handleConnection(conn);
 *     });
 *   }
 *
 * `ws` is kept out of this package's dependencies so the domain stays
 * dependency-free and CI needs no network. The binding lives in the deployable
 * service (roadmap M14) and is exercised by integration/load tests there.
 */
