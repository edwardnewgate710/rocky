/**
 * Redis-backed CommandRouter: routes game commands to the owning node.
 *
 * If this node owns the game, the command is applied locally. If not, the
 * command is forwarded to the owner via a Redis list queue (RPUSH/BLPOP),
 * and the result is relayed back via a per-request response queue.
 *
 * Redis Pub/Sub is NOT used for command forwarding — it is fire-and-forget
 * (ADR-0008). Command forwarding requires reliable delivery, so we use
 * Redis lists with BLPOP for request/response semantics.
 *
 * On ownership claim, the router starts the OwnerCommandConsumer for that
 * game so forwarded commands are actually processed (M14 inc 5 fix).
 *
 * See ADR-0010 for the design rationale.
 */

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  GameAuthority,
  AuthorityError,
  type ApplyResult,
  type AuthorityErrorCode,
  type Command,
  type Broadcast,
  type StateView,
} from '@chess-platform/realtime-gateway';
import type { GameEvent } from '@chess-platform/game';
import { OwnershipRegistry } from './ownership.js';

export interface RedisCommandRouterOptions {
  /** The local GameAuthority instance. */
  authority: GameAuthority;
  /** Ownership registry for claim/check operations. */
  registry: OwnershipRegistry;
  /** Redis client for command queue operations (RPUSH/BLPOP). */
  redis: Redis;
  /** This node's unique identifier. */
  nodeId: string;
  /** Timeout for forwarded command responses, in ms (default 5000). */
  forwardTimeoutMs?: number;
  /**
   * Owner command consumer. When this node claims ownership, the router
   * starts the consumer for that game so forwarded commands are processed.
   */
  consumer: OwnerCommandConsumer;
}

const DEFAULT_FORWARD_TIMEOUT_MS = 5000;
const CMD_PREFIX = 'game:cmd';
const RESP_PREFIX = 'game:resp';

/** Wire format for a forwarded command. */
export interface ForwardedCommand {
  readonly requestId: string;
  readonly gameId: string;
  readonly userId: string;
  readonly cmd: Command;
  readonly responseKey: string;
}

/** Wire format for a successful forwarded command result. */
export interface ForwardedSuccess {
  readonly ok: true;
  readonly events: readonly GameEvent[];
  readonly broadcasts: readonly Broadcast[];
  readonly state: StateView;
}

/** Wire format for a failed forwarded command result. */
export interface ForwardedFailure {
  readonly ok: false;
  readonly error: { readonly code: AuthorityErrorCode; readonly message: string };
}

export type ForwardedResult = ForwardedSuccess | ForwardedFailure;

/**
 * A CommandRouter backed by Redis. Checks ownership via the
 * OwnershipRegistry; forwards non-owned commands via Redis lists.
 * Starts the owner consumer when this node claims a game.
 */
export class RedisCommandRouter {
  private readonly authority: GameAuthority;
  private readonly registry: OwnershipRegistry;
  private readonly redis: Redis;
  private readonly nodeId: string;
  private readonly forwardTimeoutMs: number;
  private readonly consumer: OwnerCommandConsumer;
  private hooksInstalled = false;

  constructor(opts: RedisCommandRouterOptions) {
    this.authority = opts.authority;
    this.registry = opts.registry;
    this.redis = opts.redis;
    this.nodeId = opts.nodeId;
    this.forwardTimeoutMs = opts.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;
    this.consumer = opts.consumer;
    this.installHooks();
  }

  /**
   * Wire ownership hooks so claiming a game starts the consumer and
   * releasing stops it. Idempotent.
   */
  private installHooks(): void {
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    this.registry.setHooks({
      onClaimed: (gameId) => this.consumer.startConsumer(gameId),
      onReleased: (gameId) => this.consumer.stopConsumer(gameId),
    });
  }

  async route(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    const claim = await this.registry.claim(gameId);

    if (claim.owned) {
      // Consumer was started by the onClaimed hook (or already running).
      return this.authority.apply(gameId, userId, cmd);
    }

    // Another node owns the game — forward the command.
    return this.forward(gameId, userId, cmd);
  }

  /**
   * Forward a command to the owning node via a Redis list queue.
   * The owner processes it and pushes the result to a response queue.
   *
   * Important: do NOT DEL the response key after RPUSH — that races the
   * sender's BLPOP and can eat the response. The sender's BLPOP consumes
   * the value; use a short EXPIRE on the response key for cleanup.
   */
  private async forward(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    const requestId = `${this.nodeId}-${randomUUID()}`;
    const cmdKey = `${CMD_PREFIX}:${gameId}`;
    const respKey = `${RESP_PREFIX}:${requestId}`;

    const envelope: ForwardedCommand = {
      requestId,
      gameId,
      userId,
      cmd,
      responseKey: respKey,
    };

    // Push the command to the owner's queue (non-blocking, shared connection).
    await this.redis.rpush(cmdKey, JSON.stringify(envelope));

    // Wait for the response with a timeout (BLPOP timeout is in seconds).
    // A blocking BLPOP holds its connection until it returns, so it must run
    // on a DEDICATED connection — never the shared command/ownership one, or it
    // would stall ownership claims, lease renewals, and concurrent forwards
    // behind it (ioredis serializes commands on a single connection).
    const timeoutSec = Math.max(1, Math.ceil(this.forwardTimeoutMs / 1000));
    const blockingConn = this.redis.duplicate();
    let raw: [string, string] | null;
    try {
      raw = await blockingConn.blpop(respKey, timeoutSec);
    } finally {
      blockingConn.disconnect();
    }

    if (!raw) {
      // Timeout — the owner may have crashed. Try to claim ownership.
      // If the owner's lease has expired, SET NX EX succeeds.
      const reclaimed = await this.registry.claim(gameId);
      if (reclaimed.owned) {
        await this.authority.ensureLoaded(gameId);
        return this.authority.apply(gameId, userId, cmd);
      }
      throw new AuthorityError('invalid_command', 'command forward timeout');
    }

    // blpop returns [key, value]; we only need the value.
    const payload = Array.isArray(raw) ? raw[1] : raw;
    const result = JSON.parse(payload) as ForwardedResult;

    if (!result.ok) {
      throw new AuthorityError(
        result.error.code,
        result.error.message,
      );
    }

    // Broadcasts were already published by the owner via pub/sub.
    return {
      events: result.events,
      broadcasts: result.broadcasts,
      state: result.state,
    };
  }
}

/**
 * Consumer loop for the owner node: processes forwarded commands from the
 * Redis queue and pushes results back to the response queue.
 *
 * Must be started via {@link startConsumer} when this node claims a game
 * (wired automatically by {@link RedisCommandRouter} through ownership hooks).
 */
export class OwnerCommandConsumer {
  private running = false;
  private readonly loops = new Map<string, Promise<void>>();
  /** Dedicated blocking connection per loop (BLPOP holds its connection). */
  private readonly blockingConns = new Map<string, Redis>();
  private readonly authority: GameAuthority;
  private readonly redis: Redis;
  private readonly blpopTimeoutSec = 15;
  /** Response key TTL (seconds) so abandoned responses don't leak. */
  private readonly responseTtlSec = 30;

  constructor(authority: GameAuthority, redis: Redis) {
    this.authority = authority;
    this.redis = redis;
  }

  /**
   * Start consuming commands for a game this node owns.
   * Safe to call multiple times for the same game (idempotent).
   */
  startConsumer(gameId: string): void {
    if (this.loops.has(gameId)) return;
    this.running = true;
    // Dedicated blocking connection: a BLPOP holds its connection until it
    // returns, so each loop needs its own client. Sharing the command/ownership
    // connection would stall claims, lease renewals, and other loops behind it.
    const conn = this.redis.duplicate();
    this.blockingConns.set(gameId, conn);
    const loop = this.consumeLoop(gameId, conn);
    this.loops.set(gameId, loop);
  }

  /** Stop all consumer loops (for graceful shutdown). */
  stop(): void {
    this.running = false;
    this.loops.clear();
    for (const conn of this.blockingConns.values()) conn.disconnect();
    this.blockingConns.clear();
  }

  /** Stop consuming for a specific game (when ownership is released). */
  stopConsumer(gameId: string): void {
    this.loops.delete(gameId);
    const conn = this.blockingConns.get(gameId);
    if (conn) {
      this.blockingConns.delete(gameId);
      conn.disconnect();
    }
  }

  /** Whether a consumer loop is active for `gameId` (diagnostics/tests). */
  isConsuming(gameId: string): boolean {
    return this.loops.has(gameId);
  }

  private async consumeLoop(gameId: string, conn: Redis): Promise<void> {
    const cmdKey = `${CMD_PREFIX}:${gameId}`;
    // Liveness is tracked by `blockingConns`, which is populated *before* this
    // loop launches — unlike `loops`, whose entry is assigned only after this
    // method's synchronous prefix runs (so the first guard check would see it
    // absent and exit immediately).
    while (this.running && this.blockingConns.has(gameId)) {
      try {
        const raw = await conn.blpop(cmdKey, this.blpopTimeoutSec);
        if (!raw) continue; // timeout, loop back

        const payload = Array.isArray(raw) ? raw[1] : raw;
        await this.processCommand(payload);
      } catch (err) {
        // A forced disconnect (stop/stopConsumer) rejects the pending BLPOP;
        // exit quietly in that case rather than logging a spurious error.
        if (!this.running || !this.blockingConns.has(gameId)) break;
        console.error(`[OwnerCommandConsumer] error for ${gameId}:`, err);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  private async processCommand(raw: string): Promise<void> {
    const envelope = JSON.parse(raw) as ForwardedCommand;

    try {
      await this.authority.ensureLoaded(envelope.gameId);
      const result = await this.authority.apply(
        envelope.gameId,
        envelope.userId,
        envelope.cmd,
      );

      const response: ForwardedSuccess = {
        ok: true,
        events: result.events,
        broadcasts: result.broadcasts,
        state: result.state,
      };
      // RPUSH then EXPIRE — do NOT DEL; the sender's BLPOP consumes the value.
      await this.redis.rpush(envelope.responseKey, JSON.stringify(response));
      await this.redis.expire(envelope.responseKey, this.responseTtlSec);
    } catch (err) {
      const response: ForwardedFailure = {
        ok: false,
        error: {
          code: err instanceof AuthorityError ? err.code : 'invalid_command',
          message: err instanceof Error ? err.message : String(err),
        },
      };
      await this.redis.rpush(envelope.responseKey, JSON.stringify(response));
      await this.redis.expire(envelope.responseKey, this.responseTtlSec);
    }
  }
}
