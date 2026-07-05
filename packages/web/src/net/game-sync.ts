/**
 * Game synchronization layer — client state synchronization over {@link WsClient}.
 *
 * `GameSync` turns the raw message stream into an authoritative, observable
 * client-side game state. It:
 *   - joins on first connect and, after a drop, **resumes** from the last seen
 *     ply so the server can replay what was missed;
 *   - keeps the last full authoritative {@link StateView} snapshot plus the live
 *     move ledger (ply/turn/clock/status) applied from move/ended broadcasts;
 *   - detects a ply gap (a missed broadcast) and requests a resync;
 *   - tracks an optimistic pending move by `clientSeq` and clears it when the
 *     matching broadcast confirms it or a {@link RejectMessage} rolls it back.
 *
 * It performs no chess rules and no rendering: legality and board projection
 * stay with `@chess-platform/core` / the UI. `fen` is only valid at
 * `snapshot.ply`; consumers replay `moves` after it with the view-only mover.
 */
import type { WsClient } from './ws-client.js';
import type {
  EndedBroadcast,
  GameStatus,
  MoveBroadcast,
  MoveView,
  RejectMessage,
  Role,
  ServerMessage,
  StateView,
  WsColor,
} from './ws-protocol.js';
import { colorForRole, opposite } from './ws-protocol.js';

export interface PresenceInfo {
  readonly white: boolean;
  readonly black: boolean;
  readonly spectators: number;
}

export interface PendingMove {
  readonly uci: string;
  readonly clientSeq: number;
}

/** Observable, authoritative client-side game state. */
export interface GameSyncState {
  readonly gameId: string;
  /** True while the underlying socket is open. */
  readonly connected: boolean;
  readonly role: Role | null;
  /** Our wire color, or null when spectating / unknown. */
  readonly myColor: WsColor | null;
  /** Last full authoritative snapshot; `fen` is valid at `snapshot.ply`. */
  readonly snapshot: StateView | null;
  /** Full authoritative move ledger (snapshot moves + live broadcasts). */
  readonly moves: readonly MoveView[];
  readonly ply: number;
  readonly turn: WsColor | null;
  readonly clock: { readonly w: number; readonly b: number } | null;
  readonly status: GameStatus | null;
  readonly drawOffer: WsColor | null;
  readonly fenHash: string | null;
  readonly presence: PresenceInfo | null;
  /** Our un-acknowledged optimistic move, if any. */
  readonly pending: PendingMove | null;
  /** The most recent rejection (e.g. for surfacing a rollback reason). */
  readonly lastReject: RejectMessage | null;
}

export interface GameSyncOptions {
  readonly gameId: string;
  readonly userId: string;
}

export type GameSyncListener = (state: GameSyncState) => void;

function initialState(gameId: string): GameSyncState {
  return {
    gameId,
    connected: false,
    role: null,
    myColor: null,
    snapshot: null,
    moves: [],
    ply: 0,
    turn: null,
    clock: null,
    status: null,
    drawOffer: null,
    fenHash: null,
    presence: null,
    pending: null,
    lastReject: null,
  };
}

export class GameSync {
  private readonly client: WsClient;
  private readonly gameId: string;
  private readonly userId: string;
  private state: GameSyncState;
  private clientSeq = 0;
  private joined = false;
  private readonly listeners = new Set<GameSyncListener>();
  private unsubscribe: (() => void) | null = null;

  constructor(client: WsClient, options: GameSyncOptions) {
    this.client = client;
    this.gameId = options.gameId;
    this.userId = options.userId;
    this.state = initialState(options.gameId);
  }

  getState(): GameSyncState {
    return this.state;
  }

  subscribe(listener: GameSyncListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Wire up the client and open the connection. */
  start(): void {
    this.unsubscribe = this.client.on({
      open: () => this.handleOpen(),
      message: (msg) => this.handleMessage(msg),
      statechange: (state) => this.patch({ connected: state === 'open' }),
    });
    this.client.connect();
  }

  /** Tear down: close the connection (observing the final state change), then unsubscribe. */
  stop(): void {
    this.client.close();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Submit an intended move. Assigns the next `clientSeq`, records it as the
   * optimistic pending move, and sends it. Returns the pending move, or null if
   * we are not a player or the send failed (e.g. socket not open).
   */
  submitMove(uci: string): PendingMove | null {
    if (this.state.myColor === null) return null;
    const clientSeq = this.clientSeq + 1;
    const sent = this.client.send({ t: 'move', gameId: this.gameId, uci, clientSeq });
    if (!sent) return null;
    this.clientSeq = clientSeq;
    const pending: PendingMove = { uci, clientSeq };
    this.patch({ pending, lastReject: null });
    return pending;
  }

  resign(): boolean {
    return this.client.send({ t: 'resign', gameId: this.gameId });
  }
  offerDraw(): boolean {
    return this.client.send({ t: 'offerDraw', gameId: this.gameId });
  }
  acceptDraw(): boolean {
    return this.client.send({ t: 'acceptDraw', gameId: this.gameId });
  }
  declineDraw(): boolean {
    return this.client.send({ t: 'declineDraw', gameId: this.gameId });
  }
  claimFlag(): boolean {
    return this.client.send({ t: 'claimFlag', gameId: this.gameId });
  }
  abort(): boolean {
    return this.client.send({ t: 'abort', gameId: this.gameId });
  }

  private handleOpen(): void {
    if (this.joined) {
      this.client.send({ t: 'resume', gameId: this.gameId, lastPly: this.state.ply });
    } else {
      this.client.send({ t: 'join', gameId: this.gameId, userId: this.userId });
    }
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case 'joined':
        this.joined = true;
        this.applySnapshot(msg.state, msg.role);
        break;
      case 'state':
        this.applySnapshot(msg.state, this.state.role);
        break;
      case 'resumed':
        // The snapshot is complete and authoritative; `missed` is only needed for
        // move-by-move animation, which is a UI concern (deferred to that increment).
        this.applySnapshot(msg.state, this.state.role);
        break;
      case 'move':
        this.applyMove(msg);
        break;
      case 'ended':
        this.applyEnded(msg);
        break;
      case 'presence':
        this.patch({ presence: { white: msg.white, black: msg.black, spectators: msg.spectators } });
        break;
      case 'reject':
        this.applyReject(msg);
        break;
      case 'pong':
        // Latency is tracked by WsClient; nothing to synchronize here.
        break;
    }
  }

  private applySnapshot(view: StateView, role: Role | null): void {
    const myColor = role ? colorForRole(role) : this.state.myColor;
    this.patch({
      role: role ?? this.state.role,
      myColor,
      snapshot: view,
      moves: view.moves,
      ply: view.ply,
      turn: view.turn,
      clock: view.clock,
      status: view.status,
      drawOffer: view.drawOffer,
      fenHash: view.fenHash,
      // A full authoritative snapshot supersedes any optimistic pending move.
      pending: null,
    });
  }

  private applyMove(msg: MoveBroadcast): void {
    if (msg.ply !== this.state.ply + 1) {
      // Sequence gap — we missed at least one broadcast. Ask the server to resync.
      this.client.send({ t: 'resume', gameId: this.gameId, lastPly: this.state.ply });
      return;
    }
    const move: MoveView = { ply: msg.ply, uci: msg.uci, san: msg.san, by: msg.by };
    const pending = this.state.pending;
    const confirmsPending = pending !== null && this.state.myColor === msg.by && pending.uci === msg.uci;
    this.patch({
      moves: [...this.state.moves, move],
      ply: msg.ply,
      turn: opposite(msg.by),
      clock: msg.clock,
      fenHash: msg.fenHash,
      drawOffer: null,
      pending: confirmsPending ? null : pending,
    });
  }

  private applyEnded(msg: EndedBroadcast): void {
    this.patch({
      status: { over: true, result: msg.result, termination: msg.termination, winner: msg.winner },
    });
  }

  private applyReject(msg: RejectMessage): void {
    const pending = this.state.pending;
    const rollsBack = pending !== null && (msg.ref === null || msg.ref === pending.clientSeq);
    this.patch({ lastReject: msg, pending: rollsBack ? null : pending });
  }

  private patch(patch: Partial<GameSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}
