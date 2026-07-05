/**
 * Application composition root.
 *
 * This is the single place where the web app's object graph is assembled. It
 * wires the REST stack (`GambitClient`, which itself composes `HttpClient` +
 * `SessionManager`) and the realtime stack (`WsClient` plus a `GameSync`
 * factory) from their injectable seams. Everything is built by dependency
 * injection: the concrete browser adapters (`fetch`, `WebSocket`, `localStorage`)
 * are the defaults, and tests inject fakes instead.
 *
 * Deliberately out of scope here: opening any connection, driving gameplay
 * synchronization, touching the DOM, or importing the UI. The root only builds
 * and returns the wired services; connecting `GameSync`/`WsClient` to the board
 * lands in a later increment.
 */
import { GambitClient } from '../api/client.js';
import type { GambitClientOptions } from '../api/client.js';
import { WsClient } from '../net/ws-client.js';
import { GameSync } from '../net/game-sync.js';
import type { GameSyncOptions } from '../net/game-sync.js';
import { MemoryTokenStore, WebStorageTokenStore } from '../net/session.js';
import type { KeyValueStorage, TokenStore } from '../net/session.js';
import type { HttpTransport } from '../ports/http.js';
import type { WebSocketFactory } from '../ports/ws.js';
import type { AppConfig } from './config.js';

/** Injectable seams for the composition root. Omit any to use browser defaults. */
export interface AppDependencies {
  readonly config: AppConfig;
  /** HTTP transport seam; defaults to the platform `fetch` adapter. */
  readonly httpTransport?: HttpTransport;
  /** WebSocket factory seam; defaults to the browser `WebSocket` adapter. */
  readonly wsFactory?: WebSocketFactory;
  /** Explicit token store; takes precedence over {@link AppDependencies.storage}. */
  readonly tokenStore?: TokenStore;
  /** Web Storage used to persist the session; defaults to `localStorage`. */
  readonly storage?: KeyValueStorage;
}

/** The wired application services produced by {@link createApp}. */
export interface App {
  readonly config: AppConfig;
  /** Typed REST client (auth/session, users/profile, ratings, leaderboard, games). */
  readonly api: GambitClient;
  /** Realtime client (connection lifecycle, reconnect, heartbeat). Not yet connected. */
  readonly ws: WsClient;
  /** Build a per-game synchronization layer over the shared realtime client. */
  createGameSync(options: GameSyncOptions): GameSync;
}

/** Pick the session store: explicit store, else Web Storage, else in-memory. */
function resolveTokenStore(deps: AppDependencies): TokenStore {
  if (deps.tokenStore !== undefined) return deps.tokenStore;
  const storage =
    deps.storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  return storage !== undefined ? new WebStorageTokenStore(storage) : new MemoryTokenStore();
}

/** Assemble the application object graph from its (optionally injected) seams. */
export function createApp(deps: AppDependencies): App {
  const clientOptions: GambitClientOptions = {
    baseUrl: deps.config.apiBaseUrl,
    tokenStore: resolveTokenStore(deps),
    ...(deps.httpTransport !== undefined ? { transport: deps.httpTransport } : {}),
  };
  const api = new GambitClient(clientOptions);

  const ws = new WsClient({
    url: deps.config.wsUrl,
    ...(deps.wsFactory !== undefined ? { factory: deps.wsFactory } : {}),
  });

  return {
    config: deps.config,
    api,
    ws,
    createGameSync: (options: GameSyncOptions): GameSync => new GameSync(ws, options),
  };
}
