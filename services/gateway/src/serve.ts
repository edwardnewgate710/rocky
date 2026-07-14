/**
 * @packageDocumentation
 * Production entry point for the realtime gateway service (M14).
 *
 * Creates a WebSocket server that wraps the `RealtimeGateway` behind the
 * `Connection` interface, using `InMemoryPubSub` for single-node operation
 * or `RedisPubSub` for multi-node fanout (when `REDIS_URL` is set).
 * Token verification is shared with the API via the same `ACCESS_TOKEN_SECRET`
 * — the gateway constructs its own `AccessTokenService` (from `@chess-platform/api`)
 * to verify tokens without a network round-trip to the API.
 *
 * Config via environment:
 * - `PORT` (default 4175) — WebSocket listen port
 * - `HOST` (default 0.0.0.0) — WebSocket listen host
 * - `ACCESS_TOKEN_SECRET` (required) — HMAC secret, must match the API
 * - `ACCESS_TOKEN_TTL_SEC` (default 900) — token lifetime, must match the API
 * - `DATABASE_URL` (optional) — when set, the authority persists game events
 *   to the shared Postgres event store; when absent, falls back to in-memory
 *   (state lost on restart).
 * - `REDIS_URL` (optional) — when set, uses Redis pub/sub for multi-node
 *   fanout AND Redis-based command routing (ownership + forwarding);
 *   when absent, falls back to single-node (InMemoryPubSub + LocalCommandRouter).
 * - `NODE_ID` (optional) — unique node identifier for Redis origin tagging
 *   and ownership registry; defaults to a random UUID.
 * - `CMD_FORWARD_TIMEOUT_MS` (default 5000) — timeout for forwarded command
 *   responses when this node is not the owner.
 * - `OWNERSHIP_LEASE_TTL_SEC` (default 30) — TTL for game ownership leases.
 * - `OWNERSHIP_RENEWAL_INTERVAL_SEC` (default 15) — how often the owner
 *   renews its leases.
 *
 * Durable event log: ADR-0007 (M14 inc 2).
 * Redis pub/sub: ADR-0008 (M14 inc 3).
 * Command routing: ADR-0010 (M14 inc 5).
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  GameAuthority,
  InMemoryPubSub,
  LocalCommandRouter,
  RealtimeGateway,
  type CommandRouter,
  type Connection,
  type ClientMessage,
  type ServerMessage,
  type TokenVerifier,
  type EventLog,
  type PubSub,
  encode,
  decode,
} from '@chess-platform/realtime-gateway';
import { AccessTokenService, systemClock, uuidv7Generator } from '@chess-platform/api';

/** A TokenVerifier backed by the API's AccessTokenService (shared secret). */
class SharedSecretTokenVerifier implements TokenVerifier {
  private readonly tokens: AccessTokenService;

  constructor(secret: string, ttlSec: number) {
    this.tokens = new AccessTokenService({
      secret,
      ttlSec,
      clock: systemClock,
      ids: uuidv7Generator,
    });
  }

  verify(token: string): { readonly userId: string } | null {
    const identity = this.tokens.identify(token);
    return identity ? { userId: identity.userId } : null;
  }
}

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 4175);
  const host = process.env['HOST'] ?? '0.0.0.0';
  const secret = process.env['ACCESS_TOKEN_SECRET'] ?? '';
  const ttlSec = Number(process.env['ACCESS_TOKEN_TTL_SEC'] ?? 15 * 60);
  const redisUrl = process.env['REDIS_URL'];
  const nodeId = process.env['NODE_ID'] ?? `gw-${randomUUID()}`;
  const cmdForwardTimeoutMs = Number(process.env['CMD_FORWARD_TIMEOUT_MS'] ?? 5000);
  const ownershipLeaseTtlSec = Number(process.env['OWNERSHIP_LEASE_TTL_SEC'] ?? 30);
  const ownershipRenewalIntervalSec = Number(process.env['OWNERSHIP_RENEWAL_INTERVAL_SEC'] ?? 15);

  if (!secret || secret.length < 32) {
    console.error('ACCESS_TOKEN_SECRET is required and must be at least 32 bytes');
    process.exit(1);
  }

  // --- Durable event log (M14 inc 2) ---
  let store: EventLog | undefined;
  if (process.env['DATABASE_URL']) {
    const { createPool, PostgresEventStore } = await import('@chess-platform/persistence/pg');
    const pool = createPool();
    store = new PostgresEventStore(pool);
    console.log('[realtime-gateway] durable event log: Postgres');
  } else {
    console.log('[realtime-gateway] durable event log: in-memory (state lost on restart)');
  }

  // --- PubSub: Redis (multi-node) or InMemory (single-node) (M14 inc 3) ---
  let pubsub: PubSub;
  let closePubSub: (() => Promise<void>) | undefined;

  if (redisUrl) {
    const { createRedisPubSub } = await import('./redis-pubsub.js');
    const redis = createRedisPubSub({ url: redisUrl, nodeId });
    pubsub = redis.pubsub;
    closePubSub = redis.close;
    console.log(`[realtime-gateway] pub/sub: Redis (nodeId=${nodeId}, url=${redisUrl})`);
  } else {
    pubsub = new InMemoryPubSub();
    console.log('[realtime-gateway] pub/sub: in-memory (single-node)');
  }

  const authority = new GameAuthority(pubsub, () => Date.now(), store);

  // --- Command router: local (single-node) or Redis (multi-node) (M14 inc 5) ---
  let commandRouter: CommandRouter;
  let ownershipRegistry: { releaseAll: () => Promise<void>; startRenewal: () => void; stopRenewal: () => void; ownedCount: number } | undefined;
  let commandConsumer: { stop: () => void } | undefined;

  if (redisUrl) {
    const { OwnershipRegistry } = await import('./ownership.js');
    const { RedisCommandRouter, OwnerCommandConsumer } = await import('./command-forwarder.js');
    const { Redis } = await import('ioredis');
    // Separate Redis connection for command queues / ownership so BLPOP
    // never blocks the pub/sub publish connection path.
    const cmdRedis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    const registry = new OwnershipRegistry({
      redis: cmdRedis,
      nodeId,
      leaseTtlSec: ownershipLeaseTtlSec,
      renewalIntervalSec: ownershipRenewalIntervalSec,
    });
    // Consumer must exist before the router so ownership hooks can start it.
    const consumer = new OwnerCommandConsumer(authority, cmdRedis);
    commandRouter = new RedisCommandRouter({
      authority,
      registry,
      redis: cmdRedis,
      nodeId,
      forwardTimeoutMs: cmdForwardTimeoutMs,
      consumer,
    });
    commandConsumer = consumer;
    ownershipRegistry = registry;
    registry.startRenewal();
    console.log(`[realtime-gateway] command routing: Redis (nodeId=${nodeId}, forwardTimeout=${cmdForwardTimeoutMs}ms, leaseTtl=${ownershipLeaseTtlSec}s)`);
  } else {
    commandRouter = new LocalCommandRouter(authority);
    console.log('[realtime-gateway] command routing: local (single-node)');
  }

  const tokenVerifier = new SharedSecretTokenVerifier(secret, ttlSec);
  const gateway = new RealtimeGateway(authority, pubsub, tokenVerifier, () => Date.now(), commandRouter);

  // --- HTTP health server ---
  const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        service: 'realtime-gateway',
        pubsub: redisUrl ? 'redis' : 'memory',
        eventLog: process.env['DATABASE_URL'] ? 'postgres' : 'memory',
        commandRouting: redisUrl ? 'redis' : 'local',
        ownedGames: ownershipRegistry?.ownedCount ?? 0,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // --- WebSocket server ---
  const wss = new WebSocketServer({ port, host });

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      id: `ws-${crypto.randomUUID()}`,
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(encode(msg));
      },
      onMessage: (handler: (msg: ClientMessage) => void) => {
        ws.on('message', (data: Buffer) => {
          const msg = decode(data.toString());
          if (msg) handler(msg);
        });
      },
      onClose: (handler: () => void) => {
        ws.on('close', handler);
      },
      close: () => ws.close(),
    };
    gateway.handleConnection(conn);
  });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  const healthPort = port + 1;
  await new Promise<void>((resolve, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(healthPort, host, () => resolve());
  });

  console.log(`[realtime-gateway] WS  listening on ws://${host}:${port}`);
  console.log(`[realtime-gateway] Health on http://${host}:${healthPort}/health`);

  // Graceful shutdown — close active client sockets first, then command
  // routing, then pub/sub.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutdown signal received — closing');
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(() => {
      healthServer.close(async () => {
        if (commandConsumer) commandConsumer.stop();
        if (ownershipRegistry) {
          ownershipRegistry.stopRenewal();
          await ownershipRegistry.releaseAll();
        }
        if (closePubSub) await closePubSub();
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err: unknown) => {
  console.error('Failed to start realtime gateway:', err);
  process.exit(1);
});
