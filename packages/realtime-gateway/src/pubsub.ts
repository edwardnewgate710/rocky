/**
 * @packageDocumentation
 * Publish/subscribe fanout for authoritative broadcasts.
 *
 * The Game Authority publishes each applied move/terminal event to a per-game
 * channel; every gateway node holding subscribers for that game fans it out to
 * its local connections. This decoupling is what lets 100k spectators watch a
 * single game whose state is owned by one authoritative shard
 * (see `docs/ARCHITECTURE.md` §3).
 *
 * {@link InMemoryPubSub} is the single-process implementation used in tests and
 * for local/dev; {@link RedisPubSub} is the production seam (same interface,
 * backed by Redis pub/sub) — documented at the bottom of this file.
 */

import type { Broadcast } from './protocol';

/** A subscription handle; call to stop receiving messages on a channel. */
export type Unsubscribe = () => void;

/** Minimal pub/sub surface the gateway depends on. */
export interface PubSub {
  /** Publish a broadcast to all subscribers of `channel`. */
  publish(channel: string, msg: Broadcast): void;
  /** Subscribe to `channel`; returns an unsubscribe handle. */
  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe;
}

/** Channel name for a game's authoritative event stream. */
export function gameChannel(gameId: string): string {
  return `game:${gameId}`;
}

/** In-process {@link PubSub}. Synchronous delivery, deterministic ordering. */
export class InMemoryPubSub implements PubSub {
  private readonly channels = new Map<string, Set<(msg: Broadcast) => void>>();

  publish(channel: string, msg: Broadcast): void {
    const subs = this.channels.get(channel);
    if (!subs) return;
    // Snapshot so a handler that (un)subscribes during delivery is safe.
    for (const handler of [...subs]) handler(msg);
  }

  subscribe(channel: string, handler: (msg: Broadcast) => void): Unsubscribe {
    let subs = this.channels.get(channel);
    if (!subs) {
      subs = new Set();
      this.channels.set(channel, subs);
    }
    subs.add(handler);
    return () => {
      const set = this.channels.get(channel);
      if (!set) return;
      set.delete(handler);
      if (set.size === 0) this.channels.delete(channel);
    };
  }

  /** Number of active subscribers on a channel (diagnostics/tests). */
  subscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

/*
 * ── Redis adapter seam ──────────────────────────────────────────────────────
 * Production fanout uses Redis pub/sub so any gateway node can broadcast to
 * subscribers on any other node:
 *
 *   class RedisPubSub implements PubSub {
 *     constructor(private pub: Redis, private sub: Redis) {}
 *     publish(channel, msg) { this.pub.publish(channel, encode(msg)); }
 *     subscribe(channel, handler) {
 *       this.sub.subscribe(channel);
 *       const listener = (ch: string, payload: string) => {
 *         if (ch === channel) handler(JSON.parse(payload));
 *       };
 *       this.sub.on('message', listener);
 *       return () => { this.sub.off('message', listener); this.sub.unsubscribe(channel); };
 *     }
 *   }
 *
 * The interface is identical, so the gateway and authority are unchanged
 * between in-memory and Redis-backed deployments.
 */
