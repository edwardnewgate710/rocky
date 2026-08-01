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
 * - `TOURNAMENT_REPORTER` (optional, "1" to enable) — hosts the tournament
 *   result reporter (ADR-0025) in this process; requires `DATABASE_URL`.
 * - `TOURNAMENT_REPORTER_SCAN_MS` (default 30000) — how often the reporter
 *   re-scans running tournaments for games launched by other processes.
 * - `BOT_AUTO_ANALYZE` (optional, "1" to enable) — hosts the bot-detection
 *   auto-analyzer in this process; requires `DATABASE_URL`; needs no engine.
 * - `ANTICHEAT_AUTO_ANALYZE` (optional, "1" to enable) — hosts the anti-cheat
 *   auto-analyzer; requires `DATABASE_URL` and an engine binary (`STOCKFISH_PATH`).
 * - `SEARCH_INDEXER` (optional, "1" to enable) — hosts the live search index
 *   worker (ADR-0056); requires `DATABASE_URL`. Dedup is process-local, so set
 *   this on exactly ONE replica: every replica that enables it will index every
 *   finished game. Indexing is an idempotent upsert, so extra replicas waste a
 *   read + write per game rather than corrupting the index.
 * - `SEARCH_ENABLED` (optional, "0" to disable) — absolute kill switch for
 *   search (ADR-0055); when `0`, `SEARCH_INDEXER` is suppressed too.
 * - `SEMANTIC_SEARCH_ENABLED` (optional, "0" to disable) — when "0", search
 *   indexer writes only to the keyword index (`search_documents`), skipping
 *   vector embedding generation (`search_embeddings`).

 *
 * Durable event log: ADR-0007 (M14 inc 2).
 * Redis pub/sub: ADR-0008 (M14 inc 3).
 * Command routing: ADR-0010 (M14 inc 5).
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from 'ws';
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
import { AccessTokenService, systemClock, uuidv7Generator, JsonLogger, InMemoryMetrics } from '@chess-platform/api';
import type { TournamentResultReporter, LaunchInput } from '@chess-platform/api';
import type { EventStore } from '@chess-platform/persistence';

/** A TokenVerifier backed by the API's AccessTokenService (shared secret). */
class SharedSecretTokenVerifier implements TokenVerifier {
  private readonly tokens: AccessTokenService;

  /**
   * `onFailure` fires when a supplied token fails to verify. The gateway only
   * calls `verify` when a token is present (anonymous spectators skip it), so a
   * null result is a genuine authentication failure worth counting.
   */
  constructor(secret: string, ttlSec: number, private readonly onFailure: () => void = () => {}) {
    this.tokens = new AccessTokenService({
      secret,
      ttlSec,
      clock: systemClock,
      ids: uuidv7Generator,
    });
  }

  verify(token: string): { readonly userId: string } | null {
    const identity = this.tokens.identify(token);
    if (!identity) {
      this.onFailure();
      return null;
    }
    return { userId: identity.userId };
  }
}

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 4175);
  const healthPort = Number(process.env['HEALTH_PORT'] ?? port + 1);
  const host = process.env['HOST'] ?? '0.0.0.0';
  const secret = process.env['ACCESS_TOKEN_SECRET'] ?? '';
  const ttlSec = Number(process.env['ACCESS_TOKEN_TTL_SEC'] ?? 15 * 60);
  const redisUrl = process.env['REDIS_URL'];
  const nodeId = process.env['NODE_ID'] ?? `gw-${randomUUID()}`;
  const cmdForwardTimeoutMs = Number(process.env['CMD_FORWARD_TIMEOUT_MS'] ?? 5000);
  const ownershipLeaseTtlSec = Number(process.env['OWNERSHIP_LEASE_TTL_SEC'] ?? 30);
  const ownershipRenewalIntervalSec = Number(process.env['OWNERSHIP_RENEWAL_INTERVAL_SEC'] ?? 15);
  const maxPayload = positiveIntEnv('WS_MAX_PAYLOAD_BYTES', 32 * 1024);
  const maxConnections = positiveIntEnv('WS_MAX_CONNECTIONS', 10_000);
  const maxConnectionsPerIp = positiveIntEnv('WS_MAX_CONNECTIONS_PER_IP', 20);
  const maxMessagesPerWindow = positiveIntEnv('WS_MAX_MESSAGES_PER_WINDOW', 60);
  const messageWindowMs = positiveIntEnv('WS_MESSAGE_WINDOW_MS', 10_000);
  const joinTimeoutMs = positiveIntEnv('WS_JOIN_TIMEOUT_MS', 10_000);
  const heartbeatIntervalMs = positiveIntEnv('WS_HEARTBEAT_INTERVAL_MS', 30_000);
  const maxRoomsPerConnection = positiveIntEnv('WS_MAX_ROOMS_PER_CONNECTION', 4);

  const logger = new JsonLogger({ service: 'realtime-gateway', nodeId });
  const metrics = new InMemoryMetrics();
  
  const connectionsCounter = metrics.counter('gateway_connections_opened_total');
  const messagesCounter = metrics.counter('gateway_messages_received_total');
  const authFailuresCounter = metrics.counter('gateway_auth_failures_total');
  if (!secret || secret.length < 32) {
    logger.error('ACCESS_TOKEN_SECRET is required and must be at least 32 bytes');
    process.exit(1);
  }

  // --- Durable event log (M14 inc 2) ---
  let store: EventLog | undefined;
  let eventStore: EventStore | undefined;
  let pgPool: ReturnType<typeof import('@chess-platform/persistence/pg')['createPool']> | undefined;
  let pingDatabase: (() => Promise<void>) | undefined;
  let closeDatabase: (() => Promise<void>) | undefined;
  if (process.env['DATABASE_URL']) {
    const { createPool, PostgresEventStore } = await import('@chess-platform/persistence/pg');
    const pool = createPool();
    pgPool = pool;
    const pgEventStore = new PostgresEventStore(pool);
    store = pgEventStore;
    eventStore = pgEventStore;
    pingDatabase = async () => { await pool.query('SELECT 1'); };
    closeDatabase = async () => { await pool.end(); };
    logger.info('durable event log: Postgres');
  } else {
    logger.info('durable event log: in-memory (state lost on restart)');
  }

  // --- PubSub: Redis (multi-node) or InMemory (single-node) (M14 inc 3) ---
  let pubsub: PubSub;
  let closePubSub: (() => Promise<void>) | undefined;
  let pingRedis: (() => Promise<void>) | undefined;

  if (redisUrl) {
    const { createRedisPubSub } = await import('./redis-pubsub.js');
    const redis = createRedisPubSub({ url: redisUrl, nodeId });
    pubsub = redis.pubsub;
    closePubSub = redis.close;
    pingRedis = redis.ping;
    logger.info(`pub/sub: Redis`);
  } else {
    pubsub = new InMemoryPubSub();
    logger.info('pub/sub: in-memory (single-node)');
  }

  const authority = new GameAuthority(pubsub, () => Date.now(), store);

  // --- Tournament Result Reporter (M9 inc 13, ADR-0025) ---
  let reporter: TournamentResultReporter | undefined;
  if (process.env['TOURNAMENT_REPORTER'] === '1') {
    if (!pgPool || !eventStore) {
      logger.warn('TOURNAMENT_REPORTER requires DATABASE_URL to be set');
    } else {
      const { PgTournamentsRepository } = await import('@chess-platform/persistence/pg');
      const api = await import('@chess-platform/api');

      const tournamentsRepo = new PgTournamentsRepository(pgPool);
      const durableLauncher = new api.DurableGameLauncher(eventStore, systemClock);

      // Games launched by THIS process are watched immediately; games launched
      // by API replicas are picked up by the reporter's periodic scan.
      const reportingLauncher = {
        launch: async (input: LaunchInput): Promise<{ gameId: string }> => {
          const res = await durableLauncher.launch(input);
          reporter?.watch(input.tournamentId, res.gameId);
          return res;
        },
      };

      const tournamentService = new api.TournamentService(tournamentsRepo, reportingLauncher);
      const arenaService = new api.ArenaService(tournamentsRepo, reportingLauncher, () => Date.now());

      reporter = new api.TournamentResultReporter(pubsub, tournamentsRepo, tournamentService, arenaService, {
        scanIntervalMs: positiveIntEnv('TOURNAMENT_REPORTER_SCAN_MS', 30_000),
      });
      reporter.start().catch((err: unknown) => {
        logger.error('Failed to start TournamentResultReporter', { err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      });
      logger.info('TournamentResultReporter is enabled');
    }
  }

  // --- Bot Detection Auto-Analyzer (M12 inc 6, ADR-0041) ---
  let botAutoAnalyzer: { stop(): void } | undefined;
  if (process.env['BOT_AUTO_ANALYZE'] === '1') {
    if (!pgPool || !eventStore) {
      logger.warn('BOT_AUTO_ANALYZE requires DATABASE_URL to be set');
    } else {
      const { PgBotBehaviorReportRepository } = await import('@chess-platform/persistence/pg');
      const api = await import('@chess-platform/api');

      const botRepo = new PgBotBehaviorReportRepository(pgPool);
      const source = new api.EventStoreBotTimingSource(eventStore);
      const analysis = new api.BotAnalysisService(source, botRepo);

      // Start on the fully-typed instance, then hold only the stop() handle for shutdown.
      const worker = new api.BotAutoAnalyzer(pubsub, analysis);
      worker.start();
      botAutoAnalyzer = worker;
      logger.info('BotAutoAnalyzer is enabled');
    }
  }

  // --- Anti-Cheat Auto-Analyzer (M12 inc 8, ADR-0043) ---
  let antiCheatAutoAnalyzer: { stop(): void } | undefined;
  let antiCheatEngine: { shutdown(options?: { deadlineMs?: number }): Promise<void> } | undefined;
  if (process.env['ANTICHEAT_AUTO_ANALYZE'] === '1') {
    if (!pgPool || !eventStore) {
      logger.warn('ANTICHEAT_AUTO_ANALYZE requires DATABASE_URL to be set');
    } else {
      const { PgAntiCheatReportRepository } = await import('@chess-platform/persistence/pg');
      const api = await import('@chess-platform/api');

      const engine = api.createEngineProviderFromEnv();
      if (!engine) {
        logger.warn('ANTICHEAT_AUTO_ANALYZE requires an engine binary (set STOCKFISH_PATH)');
      } else {
        const source = new api.EventStoreGameSource(eventStore);
        const repo = new PgAntiCheatReportRepository(pgPool);
        const service = api.createEngineBackedAnalysisService(source, engine, repo);
        const worker = new api.AntiCheatAutoAnalyzer(pubsub, service);
        worker.start();
        antiCheatAutoAnalyzer = worker;
        antiCheatEngine = engine;
        logger.info('AntiCheatAutoAnalyzer is enabled');
      }
    }
  }

  // --- Search Index Worker (M11 inc 8, ADR-0056) ---
  let searchIndexWorker: { stop(): void } | undefined;
  if (process.env['SEARCH_INDEXER'] === '1') {
    if (process.env['SEARCH_ENABLED'] === '0') {
      logger.info('SEARCH_INDEXER is suppressed because SEARCH_ENABLED=0');
    } else if (!pgPool) {
      logger.warn('SEARCH_INDEXER requires DATABASE_URL to be set');
    } else {
      const { PgSearchRepository, PgSearchBackfillSource, PgSemanticSearchRepository } = await import('@chess-platform/persistence/pg');
      const { gamesEndedChannel } = await import('@chess-platform/realtime-gateway');
      const { HashingEmbeddingProvider, SEARCH_EMBEDDING_DIMENSIONS } = await import('@chess-platform/search');
      const api = await import('@chess-platform/api');

      const searchRepo = new PgSearchRepository(pgPool);
      const backfillSource = new PgSearchBackfillSource(pgPool);

      const semanticEnabled = process.env['SEMANTIC_SEARCH_ENABLED'] !== '0';
      const semantic = semanticEnabled
        ? {
            repository: new PgSemanticSearchRepository(pgPool),
            embeddingProvider: new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS),
          }
        : undefined;

      const worker = new api.SearchIndexWorker(
        pubsub,
        gamesEndedChannel(),
        backfillSource,
        searchRepo,
        semantic ? { semantic } : {},
      );
      worker.start();
      searchIndexWorker = worker;
      // Dedup is process-local: if more than one replica enables SEARCH_INDEXER, each
      // one indexes every finished game. Harmless (upsert) but wasteful — see ADR-0056.
      logger.info(
        `SearchIndexWorker is enabled (${semantic ? 'semantic mode: search_documents + search_embeddings' : 'keyword mode: search_documents only'}; run on a single replica; dedup is process-local)`
      );
    }
  }

  // --- Command router: local (single-node) or Redis (multi-node) (M14 inc 5) ---
  let commandRouter: CommandRouter;
  let ownershipRegistry: { releaseAll: () => Promise<void>; startRenewal: () => void; stopRenewal: () => void; ownedCount: number } | undefined;
  let commandConsumer: { stop: () => void } | undefined;
  let closeCommandRedis: (() => Promise<void>) | undefined;

  if (redisUrl) {
    const { OwnershipRegistry } = await import('./ownership.js');
    const { RedisCommandRouter, OwnerCommandConsumer } = await import('./command-forwarder.js');
    const { Redis } = await import('ioredis');
    // Separate Redis connection for command queues / ownership so BLPOP
    // never blocks the pub/sub publish connection path.
    const cmdRedis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
    closeCommandRedis = async () => { await cmdRedis.quit(); };
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
    logger.info(`command routing: Redis (forwardTimeout=${cmdForwardTimeoutMs}ms, leaseTtl=${ownershipLeaseTtlSec}s)`);
  } else {
    commandRouter = new LocalCommandRouter(authority);
    logger.info('command routing: local (single-node)');
  }

  const tokenVerifier = new SharedSecretTokenVerifier(secret, ttlSec, () => authFailuresCounter.inc());
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
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(metrics.render());
      return;
    }
    if (req.url === '/ready') {
      void Promise.all([
        pingDatabase?.() ?? Promise.resolve(),
        pingRedis?.() ?? Promise.resolve(),
      ]).then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ready', service: 'realtime-gateway' }));
      }).catch((err) => {
        logger.warn('readiness check failed', { err: err instanceof Error ? (err.stack ?? err.message) : String(err) });
        res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ status: 'unavailable', service: 'realtime-gateway' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // --- WebSocket server ---
  const allowedOrigins = new Set(
    (process.env['WS_ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const verifyClient: VerifyClientCallbackSync = ({ origin, req }) =>
    originAllowed(origin, req.headers.host, allowedOrigins);
  const wss = new WebSocketServer({
    port,
    host,
    maxPayload,
    verifyClient,
  });
  const connectionsByIp = new Map<string, number>();
  const alive = new WeakSet<WebSocket>();

  wss.on('connection', (ws: WebSocket, request) => {
    const ip = request.socket.remoteAddress ?? 'unknown';
    const ipConnections = connectionsByIp.get(ip) ?? 0;
    if (wss.clients.size > maxConnections || ipConnections >= maxConnectionsPerIp) {
      ws.close(1013, 'connection limit exceeded');
      return;
    }
    connectionsByIp.set(ip, ipConnections + 1);
    connectionsCounter.inc();
    
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('error', () => undefined);

    let windowStartedAt = Date.now();
    let messagesInWindow = 0;
    const joinedGames = new Set<string>();
    const joinTimer = setTimeout(() => ws.close(1008, 'join timeout'), joinTimeoutMs);
    ws.once('close', () => {
      clearTimeout(joinTimer);
      const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) connectionsByIp.delete(ip);
      else connectionsByIp.set(ip, remaining);
    });

    const conn: Connection = {
      id: `ws-${crypto.randomUUID()}`,
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(encode(msg));
      },
      onMessage: (handler: (msg: ClientMessage) => void) => {
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          const now = Date.now();
          if (now - windowStartedAt >= messageWindowMs) {
            windowStartedAt = now;
            messagesInWindow = 0;
          }
          messagesInWindow += 1;
          if (messagesInWindow > maxMessagesPerWindow) {
            ws.close(1008, 'message rate exceeded');
            return;
          }
          if (isBinary) {
            ws.close(1003, 'binary frames are not supported');
            return;
          }
          const msg = decode(data.toString());
          messagesCounter.inc();
          
          if (!msg) {
            ws.close(1008, 'malformed client message');
            return;
          }
          // Token verification (and thus auth-failure counting) happens inside
          // the gateway's join handling via the wrapped TokenVerifier above.
          if (msg.t === 'join' && !joinedGames.has(msg.gameId)) {
            if (joinedGames.size >= maxRoomsPerConnection) {
              ws.close(1008, 'room limit exceeded');
              return;
            }
            joinedGames.add(msg.gameId);
            clearTimeout(joinTimer);
          }
          handler(msg);
        });
      },
      onClose: (handler: () => void) => {
        ws.on('close', handler);
      },
      close: (code = 1000, reason?: string) => ws.close(code, reason),
    };
    gateway.handleConnection(conn);
  });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  await new Promise<void>((resolve, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(healthPort, host, () => resolve());
  });

  logger.info(`WS listening on ws://${host}:${port}`);
  logger.info(`Health on http://${host}:${healthPort}/health`);

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();

  // Graceful shutdown — close active client sockets first, then command
  // routing, then pub/sub.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    reporter?.stop();
    botAutoAnalyzer?.stop();
    antiCheatAutoAnalyzer?.stop();
    searchIndexWorker?.stop();
    // Start engine (subprocess) shutdown now so it runs concurrently with the
    // socket drain, but await it below before process.exit so cleanup can't be cut short.
    const engineShutdown = antiCheatEngine?.shutdown().catch((err: unknown) =>
      logger.error('AntiCheat engine shutdown failed', { err: err instanceof Error ? (err.stack ?? err.message) : String(err) }),
    );
    logger.info('Shutdown signal received — closing');
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(() => {
      healthServer.close(async () => {
        await engineShutdown; // ensure engine subprocesses are cleaned up before exit
        if (commandConsumer) commandConsumer.stop();
        if (ownershipRegistry) {
          ownershipRegistry.stopRenewal();
          await ownershipRegistry.releaseAll();
        }
        if (closePubSub) await closePubSub();
        if (closeCommandRedis) await closeCommandRedis();
        if (closeDatabase) await closeDatabase();
        process.exit(0);
      });
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err: unknown) => {
  // Use console.error here as we might not have initialized the logger yet
  console.error('Failed to start realtime gateway:', err);
  process.exit(1);
});

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function originAllowed(origin: string | undefined, hostHeader: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return true; // Non-browser clients do not send Origin.
  if (allowed.size > 0) return allowed.has(origin);
  if (!hostHeader) return false;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}
