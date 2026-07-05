/**
 * WebSocket transport port.
 *
 * The realtime client must not bind to the platform `WebSocket` directly — that
 * would make connection lifecycle, reconnect and heartbeat logic untestable
 * without a browser. Everything above this seam drives a connection through
 * {@link SocketHandlers} callbacks and a {@link WebSocketConnection} handle; the
 * concrete `WebSocket` adapter lives here, mirroring the `HttpTransport` port.
 */

export interface WsCloseInfo {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

/** Callbacks the client registers when opening a connection. */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(info: WsCloseInfo): void;
  onError(error: unknown): void;
}

/** A handle to an open (or opening) connection. */
export interface WebSocketConnection {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Opens a connection to `url`, wiring platform events to `handlers`. */
export type WebSocketFactory = (url: string, handlers: SocketHandlers) => WebSocketConnection;

/**
 * `WebSocket`-based factory: the only place the frontend touches the platform
 * socket API. Inject a custom constructor (or a fake factory) in tests.
 */
export function browserWebSocketFactory(ctor?: typeof WebSocket): WebSocketFactory {
  const Ctor = ctor ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!Ctor) {
    throw new Error('browserWebSocketFactory: no WebSocket implementation available');
  }
  return (url, handlers) => {
    const socket = new Ctor(url);
    socket.onopen = (): void => handlers.onOpen();
    socket.onmessage = (event: MessageEvent): void => {
      if (typeof event.data === 'string') handlers.onMessage(event.data);
    };
    socket.onclose = (event: CloseEvent): void =>
      handlers.onClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
    socket.onerror = (): void => handlers.onError(new Error('websocket error'));
    return {
      send: (data): void => socket.send(data),
      close: (code, reason): void => socket.close(code, reason),
    };
  };
}
