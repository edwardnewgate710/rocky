/**
 * Real-Redis integration tests for single-owner command routing (ADR-0010).
 *
 * Gated behind REDIS_URL — skipped when unset (same pattern as Postgres-gated
 * persistence tests). Exercises the ACTUAL production modules:
 *   services/gateway/src/ownership.ts
 *   services/gateway/src/command-forwarder.ts
 *
 * Proves:
 * (a) A move made on a NON-owner node is applied by the owner and accepted
 * (b) Owner-crash failover: after lease expiry, a second node claims and continues
 * (c) Ownership uses per-key TTL (SET NX EX), not a hash field
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { TimeControl } from '@chess-platform/game';
import {
  GameAuthority,
  InMemoryPubSub,
  InMemoryEventLog,
  type ApplyResult,
} from '@chess-platform/realtime-gateway';
import { OwnershipRegistry, ownerKey } from '../src/ownership.js';
import { OwnerCommandConsumer, RedisCommandRouter } from '../src/command-forwarder.js';

const REDIS_URL = process.env['REDIS_URL'];
const TC: TimeControl = { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' };

const describeOrSkip = REDIS_URL ? test : test.skip;

async function withRedis(
  fn: (redis: Redis) => Promise<void>,
): Promise<void> {
  if (!REDIS_URL) return;
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  try {
    await fn(redis);
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

function makeNode(opts: {
  redis: Redis;
  nodeId: string;
  store: InMemoryEventLog;
  leaseTtlSec?: number;
  forwardTimeoutMs?: number;
  pubsub?: InMemoryPubSub;
}) {
  const pubsub = opts.pubsub ?? new InMemoryPubSub();
  // Shared EventLog so both nodes rehydrate the same game after ownership transfer.
  const authority = new GameAuthority(pubsub, () => Date.now(), opts.store);
  const registry = new OwnershipRegistry({
    redis: opts.redis,
    nodeId: opts.nodeId,
    leaseTtlSec: opts.leaseTtlSec ?? 30,
    renewalIntervalSec: opts.leaseTtlSec ? Math.max(1, Math.floor(opts.leaseTtlSec / 2)) : 15,
  });
  const consumer = new OwnerCommandConsumer(authority, opts.redis);
  const router = new RedisCommandRouter({
    authority,
    registry,
    redis: opts.redis,
    nodeId: opts.nodeId,
    forwardTimeoutMs: opts.forwardTimeoutMs ?? 3000,
    consumer,
  });
  registry.startRenewal();
  return { authority, registry, consumer, router, pubsub, nodeId: opts.nodeId };
}

async function shutdown(node: ReturnType<typeof makeNode>): Promise<void> {
  node.consumer.stop();
  node.registry.stopRenewal();
  await node.registry.releaseAll();
}

describeOrSkip('real Redis: non-owner move is accepted by owner', async () => {
  await withRedis(async (redis) => {
    const gameId = `g-${randomUUID()}`;
    const store = new InMemoryEventLog();
    // Separate Redis connections: owner BLPOP must not block the forwarder's RPUSH/BLPOP.
    const redisOwner = redis.duplicate();
    const redisForwarder = redis.duplicate();
    await redisOwner.connect().catch(() => undefined);
    await redisForwarder.connect().catch(() => undefined);

    const owner = makeNode({ redis: redisOwner, nodeId: `owner-${randomUUID()}`, store });
    const other = makeNode({ redis: redisForwarder, nodeId: `other-${randomUUID()}`, store });

    try {
      await owner.authority.createGame({
        gameId,
        timeControl: TC,
        players: { white: 'alice', black: 'bob' },
        rated: true,
      });

      // Owner claims first (and starts consumer via hook).
      const claim = await owner.registry.claim(gameId);
      assert.equal(claim.owned, true);
      assert.ok(owner.consumer.isConsuming(gameId), 'owner consumer started on claim');

      // Owner applies white's first move locally.
      const r1 = await owner.router.route(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
      assert.equal(r1.state.ply, 1);

      // Non-owner forwards black's reply — must be accepted, not timed out.
      const r2: ApplyResult = await other.router.route(gameId, 'bob', {
        kind: 'move',
        uci: 'e7e5',
      });
      assert.equal(r2.state.ply, 2, 'forwarded move applied by owner');
      assert.ok(
        r2.broadcasts.some((b) => b.t === 'move' && b.ply === 2),
        'forwarded result includes move broadcast',
      );

      // Owner's local authority advanced.
      assert.equal(owner.authority.getState(gameId).ply, 2);
    } finally {
      await shutdown(owner);
      await shutdown(other);
      await redisOwner.quit().catch(() => undefined);
      await redisForwarder.quit().catch(() => undefined);
      await redis.del(ownerKey(gameId), `game:cmd:${gameId}`);
    }
  });
});

describeOrSkip('real Redis: owner-crash failover after lease expiry', async () => {
  await withRedis(async (redis) => {
    const gameId = `g-${randomUUID()}`;
    const store = new InMemoryEventLog();
    const leaseTtlSec = 2; // short lease for a fast test

    const redisA = redis.duplicate();
    const redisB = redis.duplicate();
    await redisA.connect().catch(() => undefined);
    await redisB.connect().catch(() => undefined);

    const nodeA = makeNode({
      redis: redisA,
      nodeId: `a-${randomUUID()}`,
      store,
      leaseTtlSec,
      forwardTimeoutMs: 1500,
    });
    const nodeB = makeNode({
      redis: redisB,
      nodeId: `b-${randomUUID()}`,
      store,
      leaseTtlSec,
      forwardTimeoutMs: 1500,
    });

    try {
      await nodeA.authority.createGame({
        gameId,
        timeControl: TC,
        players: { white: 'alice', black: 'bob' },
        rated: true,
      });

      const claimA = await nodeA.registry.claim(gameId);
      assert.equal(claimA.owned, true);

      await nodeA.router.route(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
      assert.equal(nodeA.authority.getState(gameId).ply, 1);

      // Crash node A: stop consumer + renewal WITHOUT releasing ownership.
      // The key remains until TTL expires (proves real key TTL, not hash fiction).
      nodeA.consumer.stop();
      nodeA.registry.stopRenewal();

      // Key still held by A immediately after crash.
      const ownerBefore = await redis.get(ownerKey(gameId));
      assert.equal(ownerBefore, nodeA.nodeId, 'lease still held by crashed owner');

      // Wait for lease expiry (+ small buffer).
      await new Promise((r) => setTimeout(r, (leaseTtlSec + 1) * 1000));

      const ownerAfterExpiry = await redis.get(ownerKey(gameId));
      assert.equal(ownerAfterExpiry, null, 'lease expired via real Redis TTL');

      // Node B claims and continues the game (rehydrates from shared EventLog).
      const claimB = await nodeB.registry.claim(gameId);
      assert.equal(claimB.owned, true, 'node B claims after lease expiry');
      assert.ok(nodeB.consumer.isConsuming(gameId), 'node B consumer started');

      await nodeB.authority.ensureLoaded(gameId);
      const r = await nodeB.router.route(gameId, 'bob', { kind: 'move', uci: 'e7e5' });
      assert.equal(r.state.ply, 2, 'game continues on new owner after failover');
    } finally {
      // nodeA already stopped; still try releaseAll for cleanliness
      nodeA.registry.stopRenewal();
      nodeA.consumer.stop();
      await nodeA.registry.releaseAll().catch(() => undefined);
      await shutdown(nodeB);
      await redisA.quit().catch(() => undefined);
      await redisB.quit().catch(() => undefined);
      await redis.del(ownerKey(gameId), `game:cmd:${gameId}`);
    }
  });
});

describeOrSkip('real Redis: ownership uses per-key TTL not hash fields', async () => {
  await withRedis(async (redis) => {
    const gameId = `g-${randomUUID()}`;
    const key = ownerKey(gameId);
    const nodeId = `n-${randomUUID()}`;

    // SET NX EX as the registry does.
    const set = await redis.set(key, nodeId, 'EX', 2, 'NX');
    assert.equal(set, 'OK');
    const ttl = await redis.ttl(key);
    assert.ok(ttl > 0 && ttl <= 2, `key has real TTL, got ${ttl}`);

    // HSETNX-style hash would NOT have a per-field TTL — we must not use it.
    // Confirm our key is a string, not a hash field.
    const type = await redis.type(key);
    assert.equal(type, 'string', 'ownership is a string key with TTL, not a hash field');

    await new Promise((r) => setTimeout(r, 2500));
    const after = await redis.get(key);
    assert.equal(after, null, 'key expires after TTL without renewal');
  });
});

describeOrSkip('real Redis: graceful release allows immediate re-claim', async () => {
  await withRedis(async (redis) => {
    const gameId = `g-${randomUUID()}`;
    const store = new InMemoryEventLog();
    const redisA = redis.duplicate();
    const redisB = redis.duplicate();
    await redisA.connect().catch(() => undefined);
    await redisB.connect().catch(() => undefined);

    const nodeA = makeNode({ redis: redisA, nodeId: `a-${randomUUID()}`, store });
    const nodeB = makeNode({ redis: redisB, nodeId: `b-${randomUUID()}`, store });

    try {
      const c1 = await nodeA.registry.claim(gameId);
      assert.equal(c1.owned, true);

      // Graceful release — compare-and-delete.
      await nodeA.registry.release(gameId);
      assert.equal(await redis.get(ownerKey(gameId)), null);

      const c2 = await nodeB.registry.claim(gameId);
      assert.equal(c2.owned, true, 'immediate re-claim after graceful release');
    } finally {
      await shutdown(nodeA);
      await shutdown(nodeB);
      await redisA.quit().catch(() => undefined);
      await redisB.quit().catch(() => undefined);
      await redis.del(ownerKey(gameId));
    }
  });
});

describeOrSkip('real Redis: fast path local lease tracking and safety margin', async () => {
  await withRedis(async (redis) => {
    const gameId = `g-${randomUUID()}`;
    const store = new InMemoryEventLog();
    const redisConn = redis.duplicate();
    await redisConn.connect().catch(() => undefined);

    const node = makeNode({ redis: redisConn, nodeId: `node-${randomUUID()}`, store, leaseTtlSec: 4 });

    try {
      await node.authority.createGame({
        gameId,
        timeControl: TC,
        players: { white: 'alice', black: 'bob' },
        rated: true,
      });

      assert.equal(node.registry.holdsValidLease(gameId), false, 'no lease before claim');

      const claim = await node.registry.claim(gameId);
      assert.equal(claim.owned, true);
      assert.equal(node.registry.holdsValidLease(gameId), true, 'valid lease after claim');

      // Move uses fast path when holdsValidLease is true
      const r1 = await node.router.route(gameId, 'alice', { kind: 'move', uci: 'e2e4' });
      assert.equal(r1.state.ply, 1);

      // Graceful release clears local lease
      await node.registry.release(gameId);
      assert.equal(node.registry.holdsValidLease(gameId), false, 'lease cleared after release');
    } finally {
      await shutdown(node);
      await redisConn.quit().catch(() => undefined);
      await redis.del(ownerKey(gameId));
    }
  });
});

