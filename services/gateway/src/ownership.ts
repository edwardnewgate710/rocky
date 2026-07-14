/**
 * Ownership registry: tracks which gateway node owns each game.
 *
 * Uses a **per-game Redis key** with a real TTL:
 *   SET game:owner:{gameId} {nodeId} NX EX {leaseSec}
 *
 * Redis has no per-hash-field TTL, so a single `game:owners` hash cannot
 * expire individual games. A crashed owner's lease expires when the key's
 * TTL elapses, allowing another node to claim with SET NX EX.
 *
 * Renewal uses a compare-and-expire Lua script (only the current owner
 * refreshes the TTL). Release uses a compare-and-delete Lua script.
 *
 * See ADR-0010 for the design rationale.
 */

import type { Redis } from 'ioredis';

/** Result of an ownership claim attempt. */
export type ClaimResult =
  | { readonly owned: true; readonly nodeId: string }
  | { readonly owned: false; readonly ownerNodeId: string };

export interface OwnershipRegistryOptions {
  /** Redis client (the same connection used for pub/sub publish is fine). */
  redis: Redis;
  /** This node's unique identifier. */
  nodeId: string;
  /** Lease TTL in seconds (default 30). */
  leaseTtlSec?: number;
  /** Renewal interval in seconds (default 15). */
  renewalIntervalSec?: number;
}

const DEFAULT_LEASE_TTL_SEC = 30;
const DEFAULT_RENEWAL_INTERVAL_SEC = 15;

/** Per-game ownership key — real Redis TTL applies. */
export function ownerKey(gameId: string): string {
  return `game:owner:${gameId}`;
}

/** Compare-and-delete: DEL only if the value equals this node. */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Compare-and-expire: EXPIRE only if the value equals this node. */
const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

/**
 * Redis-backed ownership registry. Tracks which node owns each game using
 * per-game keys with real TTLs (SET NX EX).
 */
export class OwnershipRegistry {
  private readonly redis: Redis;
  private readonly nodeId: string;
  private readonly leaseTtlSec: number;
  private readonly renewalIntervalSec: number;
  private readonly ownedGames = new Set<string>();
  private renewalTimer: ReturnType<typeof setInterval> | undefined;
  private onClaimed: ((gameId: string) => void) | undefined;
  private onReleased: ((gameId: string) => void) | undefined;

  constructor(opts: OwnershipRegistryOptions) {
    this.redis = opts.redis;
    this.nodeId = opts.nodeId;
    this.leaseTtlSec = opts.leaseTtlSec ?? DEFAULT_LEASE_TTL_SEC;
    this.renewalIntervalSec = opts.renewalIntervalSec ?? DEFAULT_RENEWAL_INTERVAL_SEC;
  }

  /**
   * Optional hooks: called when this node newly claims or releases a game.
   * Used by the command router to start/stop the owner consumer loop.
   */
  setHooks(hooks: {
    onClaimed?: (gameId: string) => void;
    onReleased?: (gameId: string) => void;
  }): void {
    this.onClaimed = hooks.onClaimed;
    this.onReleased = hooks.onReleased;
  }

  /**
   * Try to claim ownership of `gameId`. If successful, this node is the
   * owner. If another node already owns it (and the lease hasn't expired),
   * returns the owner's node ID.
   */
  async claim(gameId: string): Promise<ClaimResult> {
    const key = ownerKey(gameId);
    // SET NX EX — atomic claim with a real key-level TTL.
    const set = await this.redis.set(key, this.nodeId, 'EX', this.leaseTtlSec, 'NX');
    if (set === 'OK') {
      const wasNew = !this.ownedGames.has(gameId);
      this.ownedGames.add(gameId);
      if (wasNew) this.onClaimed?.(gameId);
      return { owned: true, nodeId: this.nodeId };
    }

    // Another node owns it — or we already own it (SET NX fails if key exists).
    const ownerNodeId = await this.redis.get(key);
    if (ownerNodeId === this.nodeId) {
      // We already own it (e.g. re-claim after local state loss). Ensure local set.
      const wasNew = !this.ownedGames.has(gameId);
      this.ownedGames.add(gameId);
      if (wasNew) this.onClaimed?.(gameId);
      return { owned: true, nodeId: this.nodeId };
    }
    if (!ownerNodeId) {
      // Race: key expired between SET NX and GET. Retry once.
      const retry = await this.redis.set(key, this.nodeId, 'EX', this.leaseTtlSec, 'NX');
      if (retry === 'OK') {
        const wasNew = !this.ownedGames.has(gameId);
        this.ownedGames.add(gameId);
        if (wasNew) this.onClaimed?.(gameId);
        return { owned: true, nodeId: this.nodeId };
      }
      const retryOwner = await this.redis.get(key);
      if (retryOwner === this.nodeId) {
        this.ownedGames.add(gameId);
        return { owned: true, nodeId: this.nodeId };
      }
      return { owned: false, ownerNodeId: retryOwner ?? 'unknown' };
    }
    return { owned: false, ownerNodeId };
  }

  /**
   * Check who owns `gameId` without attempting to claim. Returns null if
   * no node owns it (or the lease has expired).
   */
  async getOwner(gameId: string): Promise<string | null> {
    return this.redis.get(ownerKey(gameId));
  }

  /** Check whether this node owns `gameId`. */
  async isOwner(gameId: string): Promise<boolean> {
    const owner = await this.redis.get(ownerKey(gameId));
    return owner === this.nodeId;
  }

  /**
   * Release ownership of `gameId`. Compare-and-delete so we never delete
   * another node's claim. Called during graceful shutdown.
   */
  async release(gameId: string): Promise<void> {
    const key = ownerKey(gameId);
    await this.redis.eval(RELEASE_LUA, 1, key, this.nodeId);
    if (this.ownedGames.delete(gameId)) {
      this.onReleased?.(gameId);
    }
  }

  /** Release all owned games. Called during graceful shutdown. */
  async releaseAll(): Promise<void> {
    const games = [...this.ownedGames];
    for (const gameId of games) {
      await this.release(gameId);
    }
  }

  /**
   * Start the lease renewal loop. The owner periodically refreshes the TTL
   * for all its owned games so the lease doesn't expire while it's alive.
   */
  startRenewal(): void {
    if (this.renewalTimer) return;
    this.renewalTimer = setInterval(() => {
      void this.renewAll();
    }, this.renewalIntervalSec * 1000);
    this.renewalTimer.unref?.();
  }

  /** Stop the lease renewal loop. */
  stopRenewal(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
      this.renewalTimer = undefined;
    }
  }

  /** Number of games this node currently owns (diagnostics). */
  get ownedCount(): number {
    return this.ownedGames.size;
  }

  /** Snapshot of game IDs this process believes it owns (local set). */
  get ownedGameIds(): readonly string[] {
    return [...this.ownedGames];
  }

  /**
   * Renew the lease for all owned games via compare-and-expire. If we no
   * longer own a key (lost the race / lease stolen), drop it from the local set.
   */
  private async renewAll(): Promise<void> {
    for (const gameId of [...this.ownedGames]) {
      try {
        const key = ownerKey(gameId);
        const renewed = await this.redis.eval(
          RENEW_LUA,
          1,
          key,
          this.nodeId,
          String(this.leaseTtlSec),
        );
        if (renewed === 0 || renewed === '0') {
          // Lost ownership — another node claimed after our key expired.
          this.ownedGames.delete(gameId);
          this.onReleased?.(gameId);
        }
      } catch (err) {
        console.error(`[OwnershipRegistry] renewal failed for ${gameId}:`, err);
      }
    }
  }
}
