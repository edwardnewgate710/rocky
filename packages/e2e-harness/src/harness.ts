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
  type ApiServer,
  type ApiDependencies,
} from '@chess-platform/api';
import {
  GameAuthority,
  InMemoryPubSub,
  RealtimeGateway,
  type Connection,
  type ClientMessage,
  type ServerMessage,
  type TokenVerifier,
  encode,
  decode,
} from '@chess-platform/realtime-gateway';
import { BotPlayer } from './bot.js';

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
  readonly authority: GameAuthority;
  readonly bot: BotPlayer;
  readonly apiPort: number;
  readonly wsPort: number;
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

/**
 * Create and start the backend harness.
 *
 * 1. Builds the API with in-memory repositories + a fixed test secret.
 * 2. Builds the gateway with in-memory pub/sub + the API's token verifier.
 * 3. Starts an HTTP server for the API and a WebSocket server for the gateway.
 * 4. Starts a bot that plays random legal moves.
 */
export function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const apiPort = options.apiPort ?? 4174;
  const wsPort = options.wsPort ?? 4175;
  const apiHost = options.apiHost ?? '127.0.0.1';
  const wsHost = options.wsHost ?? '127.0.0.1';

  // --- API (in-memory) ---
  const clock = systemClock;
  const ids = uuidv7Generator;
  const config = resolveConfig({
    accessTokenSecret: 'e2e-harness-test-secret-at-least-32-bytes-long!!',
  });
  const hasher = new ScryptPasswordHasher();
  const tokens = new AccessTokenService({
    secret: config.accessTokenSecret,
    ttlSec: config.accessTokenTtlSec,
    clock,
    ids,
  });
  const repos = createInMemoryRepositories(clock);
  const deps: ApiDependencies = { repos, hasher, tokens, clock, ids, config };
  const apiServer = createApiServer(deps);

  // --- Gateway (in-memory pub/sub) ---
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => Date.now());

  // Token verifier: use the API's AccessTokenService.identify
  const tokenVerifier = new ApiTokenVerifier((token: string) => {
    const identity = tokens.identify(token);
    return identity ? { userId: identity.userId } : null;
  });

  const gateway = new RealtimeGateway(authority, pubsub, tokenVerifier, () => Date.now());

  // --- Bot ---
  const bot = new BotPlayer(authority, pubsub);

  // --- HTTP server ---
  const httpServer = createServer(apiServer.handler);

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
      // wss is already listening (constructed with port)
      bot.start();
      resolve({
        apiServer,
        httpServer,
        wss,
        gateway,
        authority,
        bot,
        apiPort,
        wsPort,
        close: async () => {
          bot.stop();
          wss.close();
          httpServer.close();
        },
      });
    });
    httpServer.on('error', reject);
  });
}
