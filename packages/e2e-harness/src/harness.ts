/**
 * The backend harness: composes API (in-memory) + gateway (in-memory pub/sub)
 * + WebSocket server + random-move bot in a single process.
 *
 * This module wires the existing, tested packages together with zero external
 * infrastructure (no Postgres, no Redis). The API uses in-memory fakes from
 * `@chess-platform/api/fakes`; the gateway uses `InMemoryPubSub`; the WebSocket
 * server uses the `ws` package behind the gateway's `Connection` interface.
 *
 * A `BotPlayer` auto-joins any game where it is seated as a player and plays
 * random legal moves from the authoritative `StateView.legalMoves` map.
 *
 * ## Bridge route: `POST /e2e/games`
 *
 * The product API has no `POST /v1/games` endpoint (game creation is M7
 * matchmaking). The harness exposes a **test-only** bridge route,
 * `POST /e2e/games`, that creates a game in the authority and seats the bot.
 * This is clearly namespaced under `/e2e/` so it never leaks into the product
 * API surface. Body: `{ whiteId, blackId?, botResignsAfterPlies? }` (auth:
 * bearer token of a registered user; `blackId` defaults to the bot's user id).
 * Returns `{ gameId }`.
 *
 * `botResignsAfterPlies` is a determinism lever for e2e specs: if set, the bot
 * resigns on its turn once the game's ply count reaches the given value.
 */
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createApiServer,
  createInMemoryRepositories,
  resolveConfig,
  ScryptPasswordHasher,
  AccessTokenService,
  systemClock,
  uuidv7Generator,
  InMemoryRateLimiter,
  InMemoryTournamentsRepository,
  TournamentService,
  ArenaService,
  TournamentResultReporter,
  type ApiServer,
  type ApiDependencies,
} from '@chess-platform/api';
import {
  GameAuthority,
  InMemoryPubSub,
  RealtimeGateway,
  type PubSub,
  type Connection,
  type ClientMessage,
  type ServerMessage,
  type TokenVerifier,
  encode,
  decode,
} from '@chess-platform/realtime-gateway';
import { BotPlayer } from './bot.js';
import { AuthorityGameLauncher } from './launcher.js';
import { TournamentBroadcaster } from './broadcaster.js';
/** Options for the harness. */
export interface HarnessOptions {
  readonly apiPort?: number;
  readonly wsPort?: number;
  readonly apiHost?: string;
  readonly wsHost?: string;
}

/** The running harness. */
export interface Harness {
  readonly apiServer: ApiServer;
  readonly httpServer: Server;
  readonly wss: WebSocketServer;
  readonly gateway: RealtimeGateway;
  readonly pubsub: PubSub;
  readonly authority: GameAuthority;
  readonly bot: BotPlayer;
  readonly apiPort: number;
  readonly wsPort: number;
  readonly deps: ApiDependencies;
  /** Stop the harness and close all servers. */
  close(): Promise<void>;
}

/** A TokenVerifier backed by the API's AccessTokenService. */
class ApiTokenVerifier implements TokenVerifier {
  private readonly verifyFn: (token: string) => { readonly userId: string } | null;
  constructor(verifyFn: (token: string) => { readonly userId: string } | null) {
    this.verifyFn = verifyFn;
  }
  verify(token: string): { readonly userId: string } | null {
    return this.verifyFn(token);
  }
}

/** Body for the bridge route `POST /e2e/games`. */
interface BridgeGameBody {
  readonly whiteId: string;
  readonly blackId?: string;
  /** If set and the bot is a player, the bot resigns after this many plies. */
  readonly botResignsAfterPlies?: number;
}

/**
 * Create and start the backend harness.
 */
export function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const apiPort = options.apiPort ?? 4174;
  const wsPort = options.wsPort ?? 4175;
  const apiHost = options.apiHost ?? '127.0.0.1';
  const wsHost = options.wsHost ?? '127.0.0.1';

  // --- Gateway (in-memory pub/sub) ---
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => Date.now());

  // --- Tournament Realtime Bridge ---
  const ids = uuidv7Generator;
  const tournamentRepo = new InMemoryTournamentsRepository();
  let reporter: TournamentResultReporter;
  const broadcaster = new TournamentBroadcaster(authority, pubsub);
  const gameLauncher = new AuthorityGameLauncher(authority, (tid, gid) => {
    reporter.watch(tid, gid);
    broadcaster.track(tid, gid);
  });
  const reporterTournamentService = new TournamentService(tournamentRepo, gameLauncher);
  const reporterArenaService = new ArenaService(tournamentRepo, gameLauncher, () => systemClock.now());
  reporter = new TournamentResultReporter(pubsub, tournamentRepo, reporterTournamentService, reporterArenaService);

  // --- API (in-memory) ---
  const clock = systemClock;
  const config = resolveConfig({
    accessTokenSecret: 'e2e-harness-test-secret-at-least-32-bytes-long!!',
    // The e2e stack runs over plain HTTP (vite preview), so the refresh cookie
    // must not carry the `Secure` attribute or the browser would drop it.
    cookieSecure: false,
  });
  const hasher = new ScryptPasswordHasher();
  const tokens = new AccessTokenService({
    secret: config.accessTokenSecret,
    ttlSec: config.accessTokenTtlSec,
    clock,
    ids,
  });
  const repos = createInMemoryRepositories(clock);
  const rateLimiter = new InMemoryRateLimiter(clock);
  const deps: ApiDependencies = { repos, hasher, tokens, clock, ids, config, rateLimiter, tournamentRepo, gameLauncher, liveView: broadcaster };
  const apiServer = createApiServer(deps);

  const tokenVerifier = new ApiTokenVerifier((token: string) => {
    const identity = tokens.identify(token);
    return identity ? { userId: identity.userId } : null;
  });

  const gateway = new RealtimeGateway(authority, pubsub, tokenVerifier, () => Date.now());

  // --- Bot ---
  const bot = new BotPlayer(authority, pubsub);

  // --- HTTP server with bridge route ---
  const bridgeHandler: import('node:http').RequestListener = (req, res) => {
    if (req.method === 'POST' && req.url === '/e2e/games') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        void (async () => {
        try {
          const parsed = JSON.parse(body) as BridgeGameBody;
          const whiteId = parsed.whiteId;
          const blackId = parsed.blackId ?? bot.userId;

          if (!whiteId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'bad_request', message: 'whiteId is required' }));
            return;
          }

          const gameId = ids.next();

          // Await creation (now durable/write-through) before seating the bot
          // or responding, so a join cannot race ahead of the persisted game.
          await authority.createGame({
            gameId,
            variant: 'standard',
            timeControl: {
              initialMs: 300_000,
              incrementMs: 0,
              delayMs: 0,
              kind: 'sudden_death',
            },
            players: { white: whiteId, black: blackId },
            rated: false,
          });

          if (blackId === bot.userId || whiteId === bot.userId) {
            bot.registerGame(
              gameId,
              whiteId,
              blackId,
              parsed.botResignsAfterPlies ?? null,
            );
          }

          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ gameId }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'internal_error', message: (err as Error).message }));
        }
        })();
      });
      return;
    }

    apiServer.handler(req, res);
  };

  const httpServer = createServer(bridgeHandler);

  // --- WebSocket server ---
  const wss = new WebSocketServer({ port: wsPort, host: wsHost });

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

  return new Promise((resolve, reject) => {
    httpServer.listen(apiPort, apiHost, () => {
      bot.start();
      // Resolve the actual bound ports: when 0 is requested the OS assigns an
      // ephemeral port, so the requested value would be a useless 0.
      const httpAddr = httpServer.address();
      const wssAddr = wss.address();
      const boundApiPort = typeof httpAddr === 'object' && httpAddr ? httpAddr.port : apiPort;
      const boundWsPort = typeof wssAddr === 'object' && wssAddr ? wssAddr.port : wsPort;
      resolve({
        apiServer,
        httpServer,
        wss,
        gateway,
        pubsub,
        authority,
        bot,
        apiPort: boundApiPort,
        wsPort: boundWsPort,
        deps,
        close: async () => {
          bot.stop();
          reporter.stop();
          await Promise.all([
            new Promise<void>((resolveClose) => {
              wss.close(() => resolveClose());
            }),
            new Promise<void>((resolveClose) => {
              httpServer.close(() => resolveClose());
            }),
          ]);
        },
      });
    });
    httpServer.on('error', reject);
  });
}
