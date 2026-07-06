/**
 * @packageDocumentation
 * The real-time wire protocol between chess clients and the gateway.
 *
 * Two message families flow over a single duplex connection:
 * - {@link ClientMessage}: intents sent by a client (join, move, resume, ping…).
 * - {@link ServerMessage}: authoritative responses and broadcasts.
 *
 * Design rules (see `docs/ARCHITECTURE.md` §4):
 * - The **server is the authority**: a client sends an *intended* move with a
 *   monotonic `clientSeq`; the gateway validates it against the core engine and
 *   either broadcasts the applied move or returns a {@link RejectMessage} so the
 *   client rolls back its optimistic render.
 * - Clocks are authoritative on the server. Move broadcasts carry remaining
 *   time and a `serverTs`; clients interpolate locally (see `latency.ts`).
 * - Reconnection is `lastPly`-based: a resuming client receives the current
 *   authoritative {@link StateView} plus every move it missed.
 *
 * The protocol is transport- and codec-agnostic. {@link encode}/{@link decode}
 * provide a default JSON codec; production deployments may swap in MessagePack
 * binary frames for the move channel without changing these types.
 */

import type { Color, Variant } from '@chess-platform/core';
import type { ResultString, Termination, Players, TimeControl } from '@chess-platform/game';

/** The role a connection holds in a game. */
export type Role = 'white' | 'black' | 'spectator';

/** Remaining clock, milliseconds, for both sides. */
export interface ClockView {
  readonly w: number;
  readonly b: number;
}

/** A single played move, in the compact form clients render/animate. */
export interface MoveView {
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: Color;
}

/**
 * Legal destination squares for the side to move, keyed by origin square (both
 * in UCI square notation, e.g. `{ "e2": ["e3", "e4"] }`).
 *
 * Server-authoritative and computed by the perft-verified core engine — the
 * client never derives legality itself. Empty (`{}`) once the game is over.
 * Promotions collapse to their destination square (the promotion piece is
 * chosen by the client on submission, then re-validated by the server).
 */
export type LegalMoves = { readonly [from: string]: readonly string[] };

/**
 * A complete, authoritative snapshot of a game. Sufficient on its own for a
 * client to render correctly (used on join and on resume).
 */
export interface StateView {
  readonly gameId: string;
  readonly variant: Variant;
  readonly players: Players;
  readonly timeControl: TimeControl;
  readonly fen: string;
  /** Short stable hash of `fen`; lets clients cheaply detect desync. */
  readonly fenHash: string;
  readonly ply: number;
  readonly turn: Color;
  readonly clock: ClockView;
  readonly status:
    | { readonly over: false }
    | {
        readonly over: true;
        readonly result: ResultString;
        readonly termination: Termination;
        readonly winner: Color | null;
      };
  /** The side with an open draw offer, if any. */
  readonly drawOffer: Color | null;
  readonly moves: readonly MoveView[];
  /** Legal destinations for the side to move (authoritative; empty once over). */
  readonly legalMoves: LegalMoves;
}

// ─── Client → Server ────────────────────────────────────────────────────────

/** Join a game as a player (auto-resolved by identity) or spectator. */
export interface JoinMessage {
  readonly t: 'join';
  readonly gameId: string;
  /** Stable user identity; matched against the game's players to assign a role. */
  readonly userId: string;
}

/** An intended move. `clientSeq` must strictly increase per connection+game. */
export interface MoveMessage {
  readonly t: 'move';
  readonly gameId: string;
  readonly uci: string;
  readonly clientSeq: number;
}

/** Commands that do not carry extra data beyond the game id. */
export interface SimpleCommandMessage {
  readonly t: 'resign' | 'offerDraw' | 'acceptDraw' | 'declineDraw' | 'claimFlag' | 'abort';
  readonly gameId: string;
}

/** Reconnect: ask for current state plus everything after `lastPly`. */
export interface ResumeMessage {
  readonly t: 'resume';
  readonly gameId: string;
  readonly lastPly: number;
}

/** Latency probe; the server echoes `ts` and adds its own timestamp. */
export interface PingMessage {
  readonly t: 'ping';
  readonly ts: number;
}

/** The discriminated union of everything a client may send. */
export type ClientMessage =
  | JoinMessage
  | MoveMessage
  | SimpleCommandMessage
  | ResumeMessage
  | PingMessage;

// ─── Server → Client ────────────────────────────────────────────────────────

/** Acknowledges a join and delivers the assigned role + current state. */
export interface JoinedMessage {
  readonly t: 'joined';
  readonly gameId: string;
  readonly role: Role;
  readonly state: StateView;
}

/** A full authoritative state push (e.g. after resume or reconciliation). */
export interface StateMessage {
  readonly t: 'state';
  readonly gameId: string;
  readonly state: StateView;
}

/** An applied, authoritative move broadcast to every member of a room. */
export interface MoveBroadcast {
  readonly t: 'move';
  readonly gameId: string;
  readonly ply: number;
  readonly uci: string;
  readonly san: string;
  readonly by: Color;
  readonly fenHash: string;
  readonly clock: ClockView;
  readonly serverTs: number;
  /**
   * Legal destinations for the side to move in the **resulting** position
   * (after this move has been applied). Empty (`{}`) when the move ended the
   * game. This is the push-based refresh mechanism: every broadcast carries
   * the authoritative legal-move map so clients never starve after a live move.
   */
  readonly legalMoves: LegalMoves;
}

/** A terminal event broadcast to every member of a room. */
export interface EndedBroadcast {
  readonly t: 'ended';
  readonly gameId: string;
  readonly result: ResultString;
  readonly termination: Termination;
  readonly winner: Color | null;
  readonly serverTs: number;
}

/** Room presence: who occupies the player seats and how many are watching. */
export interface PresenceMessage {
  readonly t: 'presence';
  readonly gameId: string;
  readonly white: boolean;
  readonly black: boolean;
  readonly spectators: number;
}

/** Response to {@link ResumeMessage}: current state + missed broadcasts. */
export interface ResumedMessage {
  readonly t: 'resumed';
  readonly gameId: string;
  readonly state: StateView;
  readonly missed: readonly (MoveBroadcast | EndedBroadcast)[];
}

/**
 * A rejected intent. `ref` echoes the `clientSeq` of the offending move so the
 * client can roll back exactly that optimistic render.
 */
export interface RejectMessage {
  readonly t: 'reject';
  readonly gameId: string;
  readonly ref: number | null;
  readonly code: RejectCode;
  readonly message: string;
}

/** Machine-readable rejection reasons. */
export type RejectCode =
  | 'illegal_move'
  | 'not_your_turn'
  | 'not_a_player'
  | 'stale_seq'
  | 'unknown_game'
  | 'not_joined'
  | 'invalid_command';

/** Echoed latency probe; carries the server timestamp for RTT estimation. */
export interface PongMessage {
  readonly t: 'pong';
  readonly ts: number;
  readonly serverTs: number;
}

/** The discriminated union of everything the server may send. */
export type ServerMessage =
  | JoinedMessage
  | StateMessage
  | MoveBroadcast
  | EndedBroadcast
  | PresenceMessage
  | ResumedMessage
  | RejectMessage
  | PongMessage;

/** Broadcasts fanned out to a whole room (as opposed to point-to-point replies). */
export type Broadcast = MoveBroadcast | EndedBroadcast;

// ─── Default JSON codec ─────────────────────────────────────────────────────

/** Serialize a server message to a string frame (default JSON codec). */
export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a client frame. Returns `null` for malformed input or unknown message
 * types rather than throwing, so a hostile client cannot crash the gateway.
 */
export function decode(frame: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  switch (t) {
    case 'join':
    case 'move':
    case 'resign':
    case 'offerDraw':
    case 'acceptDraw':
    case 'declineDraw':
    case 'claimFlag':
    case 'abort':
    case 'resume':
    case 'ping':
      return parsed as ClientMessage;
    default:
      return null;
  }
}
