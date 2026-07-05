/**
 * @packageDocumentation
 * The Game Authority: the single owner of live game state.
 *
 * Responsibilities (`docs/ARCHITECTURE.md` §3):
 * - Owns the in-memory {@link Game} aggregate for each live game, keyed by id
 *   (a shard owns a disjoint set of games; one owner per game).
 * - Validates every command via `@chess-platform/game` (which itself uses the
 *   perft-verified core engine) — the server is the sole authority on legality.
 * - Appends emitted events to an append-only log and publishes the resulting
 *   authoritative broadcasts to the game's channel for gateway fanout.
 * - Serializes commands **per game** so concurrent intents can never interleave
 *   and corrupt state (the explicit race-condition guard from the roadmap).
 *
 * The authority is transport-agnostic: it neither knows nor cares whether a
 * command arrived over WebSocket, HTTP, or a test harness.
 */

import { createHash } from 'node:crypto';
import { Game, type GameEvent } from '@chess-platform/game';
import type { Color, Position } from '@chess-platform/core';
import type { CreateGameParams } from '@chess-platform/game';
import type { Broadcast, LegalMoves, StateView } from './protocol';
import { gameChannel, type PubSub } from './pubsub';

/** A command an authenticated player may issue against a game. */
export type Command =
  | { readonly kind: 'move'; readonly uci: string }
  | { readonly kind: 'resign' }
  | { readonly kind: 'offerDraw' }
  | { readonly kind: 'acceptDraw' }
  | { readonly kind: 'declineDraw' }
  | { readonly kind: 'claimFlag' }
  | { readonly kind: 'abort' };

/** Reasons a command can be refused, aligned with the protocol reject codes. */
export type AuthorityErrorCode =
  | 'illegal_move'
  | 'not_your_turn'
  | 'not_a_player'
  | 'unknown_game'
  | 'invalid_command';

/** A refused command. `code` maps directly onto a protocol `RejectCode`. */
export class AuthorityError extends Error {
  constructor(readonly code: AuthorityErrorCode, message: string) {
    super(message);
    this.name = 'AuthorityError';
  }
}

interface BroadcastLogEntry {
  readonly seq: number;
  readonly ply: number | null;
  readonly msg: Broadcast;
}

interface GameRecord {
  game: Game;
  readonly events: GameEvent[];
  readonly broadcasts: BroadcastLogEntry[];
  /** Serialization tail: commands await the previous command's completion. */
  lock: Promise<void>;
  broadcastSeq: number;
}

/** Short, stable hash of a FEN string for cheap desync detection. */
export function fenHash(fen: string): string {
  return createHash('sha1').update(fen).digest('hex').slice(0, 12);
}

/**
 * Legal destinations for the side to move, keyed by origin square. Reuses the
 * position's own (perft-verified) move generator — the single source of truth
 * for legality — and collapses promotions to their shared destination square.
 * Returns `{}` for terminal positions (no legal moves).
 */
export function legalMovesOf(position: Position): LegalMoves {
  const byFrom = new Map<string, Set<string>>();
  for (const move of position.legalMoves()) {
    const uci = position.toUci(move);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    let dests = byFrom.get(from);
    if (dests === undefined) {
      dests = new Set<string>();
      byFrom.set(from, dests);
    }
    dests.add(to);
  }
  const out: Record<string, readonly string[]> = {};
  for (const [from, dests] of byFrom) {
    out[from] = [...dests];
  }
  return out;
}

/** The result of applying a command. */
export interface ApplyResult {
  readonly events: readonly GameEvent[];
  readonly broadcasts: readonly Broadcast[];
  readonly state: StateView;
}

export class GameAuthority {
  private readonly games = new Map<string, GameRecord>();

  constructor(
    private readonly pubsub: PubSub,
    /** Injectable clock so tests are deterministic; defaults to wall time. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Whether a live game exists. */
  has(gameId: string): boolean {
    return this.games.has(gameId);
  }

  /**
   * Create and register a new game. Throws if the id is already in use.
   * `at` defaults to the authority's clock. The `GameCreated` event is logged;
   * creation is not a broadcast (joiners receive the full state instead).
   */
  createGame(params: Omit<CreateGameParams, 'at'> & { at?: number }): StateView {
    if (this.games.has(params.gameId)) {
      throw new AuthorityError('invalid_command', `game ${params.gameId} already exists`);
    }
    const at = params.at ?? this.now();
    const { game, events } = Game.create({ ...params, at });
    this.games.set(params.gameId, {
      game,
      events: [...events],
      broadcasts: [],
      lock: Promise.resolve(),
      broadcastSeq: 0,
    });
    return this.viewOf(game);
  }

  /** Current authoritative state view. Throws if the game is unknown. */
  getState(gameId: string): StateView {
    return this.viewOf(this.require(gameId).game);
  }

  /**
   * Every broadcast a resuming client missed: all broadcasts recorded after the
   * move whose ply equals `lastPly`. `lastPly <= 0` returns the full history.
   */
  getMissedSince(gameId: string, lastPly: number): Broadcast[] {
    const rec = this.require(gameId);
    if (lastPly <= 0) return rec.broadcasts.map((e) => e.msg);
    let cutSeq = -1;
    for (const e of rec.broadcasts) {
      if (e.ply === lastPly) cutSeq = e.seq;
    }
    return rec.broadcasts.filter((e) => e.seq > cutSeq).map((e) => e.msg);
  }

  /** Resolve a user's seat in a game, or `null` if they are a spectator. */
  colorOf(gameId: string, userId: string): Color | null {
    const { players } = this.require(gameId).game.snapshot();
    if (players.white === userId) return 'w';
    if (players.black === userId) return 'b';
    return null;
  }

  /**
   * Apply a command from `userId`. Serialized per game: the returned promise
   * resolves only after any in-flight command for the same game completes, so
   * two moves can never race. Rejections surface as {@link AuthorityError}.
   */
  apply(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    const rec = this.require(gameId);
    const run = rec.lock.then(() => this.applyNow(gameId, rec, userId, cmd));
    // Keep the chain alive regardless of this command's success/failure.
    rec.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private applyNow(gameId: string, rec: GameRecord, userId: string, cmd: Command): ApplyResult {
    const color = this.colorOf(gameId, userId);
    if (color === null) {
      throw new AuthorityError('not_a_player', 'only players may issue commands');
    }
    const at = this.now();
    let result: { game: Game; events: GameEvent[] };

    switch (cmd.kind) {
      case 'move': {
        if (rec.game.turn !== color) {
          throw new AuthorityError('not_your_turn', 'it is not your turn');
        }
        try {
          result = rec.game.playMove(cmd.uci, at);
        } catch (err) {
          throw new AuthorityError('illegal_move', (err as Error).message);
        }
        break;
      }
      case 'resign':
        result = this.guard(() => rec.game.resign(color, at));
        break;
      case 'offerDraw':
        result = this.guard(() => rec.game.offerDraw(color, at));
        break;
      case 'acceptDraw':
        result = this.guard(() => rec.game.acceptDraw(color, at));
        break;
      case 'declineDraw':
        result = this.guard(() => rec.game.declineDraw(color, at));
        break;
      case 'claimFlag':
        result = this.guard(() => rec.game.claimFlag(at));
        break;
      case 'abort':
        result = this.guard(() => rec.game.abort(at));
        break;
      default: {
        const _exhaustive: never = cmd;
        throw new AuthorityError('invalid_command', `unknown command ${JSON.stringify(_exhaustive)}`);
      }
    }

    rec.game = result.game;
    rec.events.push(...result.events);

    const resultingFenHash = fenHash(rec.game.fen);
    const broadcasts: Broadcast[] = [];
    for (const ev of result.events) {
      const msg = this.toBroadcast(gameId, ev, resultingFenHash);
      if (!msg) continue;
      const seq = ++rec.broadcastSeq;
      rec.broadcasts.push({ seq, ply: msg.t === 'move' ? msg.ply : null, msg });
      broadcasts.push(msg);
    }
    // Publish only after state is committed, so a subscriber can never observe
    // a broadcast for a state the authority has not yet recorded.
    for (const msg of broadcasts) this.pubsub.publish(gameChannel(gameId), msg);

    return { events: result.events, broadcasts, state: this.viewOf(rec.game) };
  }

  private guard(fn: () => { game: Game; events: GameEvent[] }): { game: Game; events: GameEvent[] } {
    try {
      return fn();
    } catch (err) {
      throw new AuthorityError('invalid_command', (err as Error).message);
    }
  }

  private toBroadcast(gameId: string, ev: GameEvent, resultingFenHash: string): Broadcast | null {
    switch (ev.type) {
      case 'MovePlayed':
        return {
          t: 'move',
          gameId,
          ply: ev.ply,
          uci: ev.uci,
          san: ev.san,
          by: ev.by,
          fenHash: resultingFenHash,
          clock: { w: ev.remaining.w, b: ev.remaining.b },
          serverTs: ev.at,
        };
      case 'GameEnded':
        return {
          t: 'ended',
          gameId,
          result: ev.result,
          termination: ev.termination,
          winner: ev.winner,
          serverTs: ev.at,
        };
      default:
        return null;
    }
  }

  private viewOf(game: Game): StateView {
    const snap = game.snapshot();
    const fen = game.fen;
    return {
      gameId: snap.gameId,
      variant: snap.variant,
      players: snap.players,
      timeControl: snap.timeControl,
      fen,
      fenHash: fenHash(fen),
      ply: snap.ply,
      turn: game.turn,
      clock: { w: snap.clock.remaining.w, b: snap.clock.remaining.b },
      status: snap.status,
      drawOffer: snap.drawOffer,
      moves: snap.moves.map((m) => ({ ply: m.ply, uci: m.uci, san: m.san, by: m.by })),
      legalMoves: legalMovesOf(snap.position),
    };
  }

  private require(gameId: string): GameRecord {
    const rec = this.games.get(gameId);
    if (!rec) throw new AuthorityError('unknown_game', `no such game ${gameId}`);
    return rec;
  }
}
