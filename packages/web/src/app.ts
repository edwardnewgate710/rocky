/**
 * App composition root (Increment 3C).
 *
 * Wires the REST client, WebSocket client, GameSync, and CoreMoveOracle into
 * the game view. The server remains authoritative; the client sends intents
 * and reconciles from authoritative snapshots/broadcasts.
 *
 * Architecture:
 *   main.ts (entry)
 *     → App (composition root)
 *         → GambitClient (REST, auth/session)
 *         → WsClient (WebSocket, reconnect, heartbeat)
 *         → GameSync (game state sync, optimistic moves)
 *         → CoreMoveOracle (local legality via @chess-platform/core)
 *         → BoardInteraction (UI state machine)
 *         → BoardView (DOM rendering)
 *
 * The REST client handles auth (register/login/refresh); the WS client handles
 * real-time game communication; GameSync bridges the two into a unified game
 * state observable. No lobby/matchmaking/profile UI yet.
 */
import { GambitClient } from './api/client.js';
import { FetchTransport } from './ports/http.js';
import { browserWebSocketFactory } from './ports/ws.js';
import { CoreMoveOracle } from './ports/core-oracle.js';
import { WsClient } from './net/ws-client.js';
import { GameSync } from './net/game-sync.js';
import { SessionManager } from './net/session.js';
import { BoardView, type ResolvedMove } from './ui/board-view.js';
import { BoardInteraction } from './core/interaction.js';
import { applyMove } from './core/mover.js';
import { STARTING_FEN } from './core/position.js';

const DEFAULT_API_BASE = '/api/v1';
const DEFAULT_WS_URL = (loc: Location) =>
  `ws://${loc.host}/ws`;

export interface AppConfig {
  apiBase?: string;
  wsUrl?: string | ((loc: Location) => string);
  boardEl: HTMLElement;
  statusEl?: HTMLElement | null;
  flipEl?: HTMLElement | null;
}

export class App {
  private readonly client: GambitClient;
  private readonly wsClient: WsClient;
  private readonly gameSync: GameSync;
  private readonly oracle: CoreMoveOracle;
  private readonly interaction: BoardInteraction;
  private readonly boardView: BoardView;
  private readonly statusEl: HTMLElement | null;
  private fen: string;

  constructor(config: AppConfig) {
    const apiBase = config.apiBase ?? DEFAULT_API_BASE;
    const wsUrl = typeof config.wsUrl === 'function'
      ? config.wsUrl(location)
      : (config.wsUrl ?? DEFAULT_WS_URL(location));

    // Transport layer
    const transport = new FetchTransport();

    // Session / auth
    const session = new SessionManager({
      store: new (class implements import('./net/session.js').TokenStore {
        private data: import('./api/models.js').TokenPair | null = null;
        load() { return Promise.resolve(this.data); }
        save(t: import('./api/models.js').TokenPair) { this.data = t; return Promise.resolve(); }
        clear() { this.data = null; return Promise.resolve(); }
      })(),
      refreshFn: async (refreshToken) => {
        const res = await transport.send({
          method: 'POST',
          url: `${apiBase}/auth/refresh`,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        return JSON.parse(res.body);
      },
    });

    // REST client
    this.client = new GambitClient(transport, apiBase, session);

    // WebSocket client
    this.wsClient = new WsClient({
      url: wsUrl,
      factory: browserWebSocketFactory(),
    });

    // Game sync layer
    this.gameSync = new GameSync({
      wsClient: this.wsClient,
      sendMove: async (gameId, move) => {
        // Moves are sent via WS; the REST fallback is a future concern.
        this.wsClient.send({ kind: 'move', gameId, ...move });
      },
    });

    // Legal move oracle (backed by core)
    this.oracle = new CoreMoveOracle();

    // Board interaction state machine
    this.interaction = new BoardInteraction({
      oracle: this.oracle,
      myTurn: true,
    });

    // Status element
    this.statusEl = config.statusEl ?? null;

    // Initial FEN
    this.fen = STARTING_FEN;
    this.oracle.setPosition(this.fen);

    // Board view
    this.boardView = new BoardView(config.boardEl, {
      interaction: this.interaction,
      orientation: 'white',
      onResult: (r: ResolvedMove) => this.handleResult(r),
    });
    this.boardView.setPosition(this.fen);

    // Wire flip button
    config.flipEl?.addEventListener('click', () => this.boardView.flip());

    // Wire GameSync state changes to the board
    this.gameSync.subscribe((state) => {
      if (state.snapshot) {
        this.fen = state.snapshot.fen;
        this.oracle.setPosition(this.fen);
        this.boardView.setPosition(this.fen);
        this.interaction.setMyTurn(state.snapshot.myTurn);
      }
      if (state.lastReject) {
        this.setStatus(`Move rejected: ${state.lastReject.reason}`);
      }
    });
  }

  private handleResult(r: ResolvedMove): void {
    if (r.kind === 'move') {
      this.fen = applyMove(this.fen, r.move);
      this.oracle.setPosition(this.fen);
      this.boardView.setPosition(this.fen);
      this.boardView.setLastMove(r.move.from, r.move.to);
      this.setStatus(`Played ${r.move.from}–${r.move.to}${r.move.promotion ? `=${r.move.promotion.toUpperCase()}` : ''}.`);
    } else {
      this.setStatus(`Premove set: ${r.premove.from}–${r.premove.to}.`);
    }
  }

  private setStatus(msg: string): void {
    if (this.statusEl) this.statusEl.textContent = msg;
  }

  /** Expose the REST client for external use (e.g. login UI). */
  getClient(): GambitClient { return this.client; }

  /** Expose the WS client for external use. */
  getWsClient(): WsClient { return this.wsClient; }

  /** Expose the game sync for external use. */
  getGameSync(): GameSync { return this.gameSync; }
}
