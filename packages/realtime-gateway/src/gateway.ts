/**
 * @packageDocumentation
 * The Realtime Gateway: binds client {@link Connection}s to game {@link Room}s
 * and the {@link GameAuthority}, and speaks the {@link ClientMessage} /
 * {@link ServerMessage} protocol.
 *
 * It owns exactly the concerns the architecture assigns to the edge:
 * - **Membership & presence** — join a game as player or spectator, track who
 *   is connected, fan authoritative broadcasts out to the room.
 * - **Optimistic-move reconciliation** — a client move carries a monotonic
 *   `clientSeq`; a stale/duplicate seq or an illegal move yields a
 *   {@link RejectMessage} referencing that seq so the client rolls back.
 * - **Reconnect/resume** — a reconnecting client rejoins (re-establishing its
 *   seat and receiving current state) and then asks for every move it missed
 *   since `lastPly`.
 * - **Latency** — `ping`/`pong` with a server timestamp for client-side clock
 *   interpolation.
 *
 * State ownership stays in the authority; cross-node fanout stays in pub/sub.
 * The gateway subscribes a room to its game channel on first join and
 * unsubscribes when the room empties, so a node only carries fanout for games
 * it actually serves.
 */

import { GameAuthority, AuthorityError, type Command } from './authority';
import { Room } from './room';
import { gameChannel, type PubSub, type Unsubscribe } from './pubsub';
import type { Connection } from './transport';
import type {
  ClientMessage,
  MoveMessage,
  RejectCode,
  Role,
  SimpleCommandMessage,
} from './protocol';

interface Membership {
  readonly userId: string;
  readonly role: Role;
  /** Highest accepted `clientSeq` for move replay protection. */
  lastSeq: number;
}

interface Session {
  readonly conn: Connection;
  readonly games: Map<string, Membership>;
}

interface RoomEntry {
  readonly room: Room;
  readonly unsubscribe: Unsubscribe;
}

const SIMPLE_TO_COMMAND: Record<SimpleCommandMessage['t'], Command['kind']> = {
  resign: 'resign',
  offerDraw: 'offerDraw',
  acceptDraw: 'acceptDraw',
  declineDraw: 'declineDraw',
  claimFlag: 'claimFlag',
  abort: 'abort',
};

export class RealtimeGateway {
  private readonly sessions = new Map<string, Session>();
  private readonly rooms = new Map<string, RoomEntry>();

  constructor(
    private readonly authority: GameAuthority,
    private readonly pubsub: PubSub,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Register a new connection and wire its lifecycle handlers. */
  handleConnection(conn: Connection): void {
    const session: Session = { conn, games: new Map() };
    this.sessions.set(conn.id, session);
    conn.onMessage((msg) => this.onMessage(session, msg));
    conn.onClose(() => this.onClose(session));
  }

  /** Number of rooms this node currently serves (diagnostics/tests). */
  get roomCount(): number {
    return this.rooms.size;
  }

  private onMessage(session: Session, msg: ClientMessage): void {
    switch (msg.t) {
      case 'join':
        this.onJoin(session, msg.gameId, msg.userId);
        return;
      case 'move':
        this.onMove(session, msg);
        return;
      case 'resign':
      case 'offerDraw':
      case 'acceptDraw':
      case 'declineDraw':
      case 'claimFlag':
      case 'abort':
        this.onSimpleCommand(session, msg);
        return;
      case 'resume':
        this.onResume(session, msg.gameId, msg.lastPly);
        return;
      case 'ping':
        session.conn.send({ t: 'pong', ts: msg.ts, serverTs: this.now() });
        return;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  private onJoin(session: Session, gameId: string, userId: string): void {
    if (!this.authority.has(gameId)) {
      this.reject(session, gameId, null, 'unknown_game', `no such game ${gameId}`);
      return;
    }
    const color = this.authority.colorOf(gameId, userId);
    const role: Role = color === 'w' ? 'white' : color === 'b' ? 'black' : 'spectator';

    const entry = this.ensureRoom(gameId);
    entry.room.add(session.conn, userId, role);
    session.games.set(gameId, { userId, role, lastSeq: 0 });

    session.conn.send({ t: 'joined', gameId, role, state: this.authority.getState(gameId) });
    entry.room.broadcastPresence();
  }

  private onMove(session: Session, msg: MoveMessage): void {
    const membership = session.games.get(msg.gameId);
    if (!membership) {
      this.reject(session, msg.gameId, msg.clientSeq, 'not_joined', 'join the game first');
      return;
    }
    if (membership.role === 'spectator') {
      this.reject(session, msg.gameId, msg.clientSeq, 'not_a_player', 'spectators cannot move');
      return;
    }
    // Replay protection: clientSeq must strictly increase per connection+game.
    if (msg.clientSeq <= membership.lastSeq) {
      this.reject(session, msg.gameId, msg.clientSeq, 'stale_seq', 'stale or duplicate clientSeq');
      return;
    }
    membership.lastSeq = msg.clientSeq;

    // Fire the (per-game serialized) command; broadcasts fan out via pub/sub.
    // A rejection is reported back referencing this exact clientSeq.
    void this.authority
      .apply(msg.gameId, membership.userId, { kind: 'move', uci: msg.uci })
      .catch((err: unknown) => {
        this.reject(session, msg.gameId, msg.clientSeq, codeOf(err), messageOf(err));
      });
  }

  private onSimpleCommand(session: Session, msg: SimpleCommandMessage): void {
    const membership = session.games.get(msg.gameId);
    if (!membership) {
      this.reject(session, msg.gameId, null, 'not_joined', 'join the game first');
      return;
    }
    if (membership.role === 'spectator') {
      this.reject(session, msg.gameId, null, 'not_a_player', 'spectators cannot issue commands');
      return;
    }
    const kind = SIMPLE_TO_COMMAND[msg.t];
    void this.authority
      .apply(msg.gameId, membership.userId, { kind } as Command)
      .then((result) => {
        // Commands that emit no move/terminal broadcast (draw offer/decline)
        // still change shared state; push an authoritative snapshot so both
        // sides see the updated draw offer.
        if (result.broadcasts.length === 0) {
          this.sendStateToRoom(msg.gameId);
        }
      })
      .catch((err: unknown) => {
        this.reject(session, msg.gameId, null, codeOf(err), messageOf(err));
      });
  }

  private onResume(session: Session, gameId: string, lastPly: number): void {
    const membership = session.games.get(gameId);
    if (!membership) {
      this.reject(session, gameId, null, 'not_joined', 'join before resuming');
      return;
    }
    session.conn.send({
      t: 'resumed',
      gameId,
      state: this.authority.getState(gameId),
      missed: this.authority.getMissedSince(gameId, lastPly),
    });
  }

  private onClose(session: Session): void {
    for (const gameId of session.games.keys()) {
      const entry = this.rooms.get(gameId);
      if (!entry) continue;
      entry.room.remove(session.conn.id);
      if (entry.room.size === 0) {
        entry.unsubscribe();
        this.rooms.delete(gameId);
      } else {
        entry.room.broadcastPresence();
      }
    }
    this.sessions.delete(session.conn.id);
  }

  private ensureRoom(gameId: string): RoomEntry {
    let entry = this.rooms.get(gameId);
    if (entry) return entry;
    const room = new Room(gameId);
    const unsubscribe = this.pubsub.subscribe(gameChannel(gameId), (msg) => room.broadcast(msg));
    entry = { room, unsubscribe };
    this.rooms.set(gameId, entry);
    return entry;
  }

  private sendStateToRoom(gameId: string): void {
    const entry = this.rooms.get(gameId);
    if (!entry) return;
    entry.room.sendAll({ t: 'state', gameId, state: this.authority.getState(gameId) });
  }

  private reject(
    session: Session,
    gameId: string,
    ref: number | null,
    code: RejectCode,
    message: string,
  ): void {
    session.conn.send({ t: 'reject', gameId, ref, code, message });
  }
}

function codeOf(err: unknown): RejectCode {
  if (err instanceof AuthorityError) return err.code;
  return 'invalid_command';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
