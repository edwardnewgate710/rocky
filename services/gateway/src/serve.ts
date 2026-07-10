/**
 * @packageDocumentation
 * Production entry point for the realtime gateway service (M14).
 *
 * Creates a WebSocket server that wraps the `RealtimeGateway` behind the
 * `Connection` interface, using `InMemoryPubSub` for single-node operation.
 * Token verification is shared with the API via the same `ACCESS_TOKEN_SECRET`
 * — the gateway constructs its own `AccessTokenService` (from `@chess-platform/api`)
 * to verify tokens without a network round-trip to the API.
 *
 * Config via environment:
 * - `PORT` (default 4175) — WebSocket listen port
 * - `ACCESS_TOKEN_SECRET` (required) — HMAC secret, must match the API
 * - `ACCESS_TOKEN_TTL_SEC` (default 900) — token lifetime, must match the API
 *
 * Horizontal scale (Redis pub/sub, multi-node) is a later M14 increment.
 * Documented in ADR-0007.
 */

import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
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

  if (!secret || secret.length < 32) {
    console.error('ACCESS_TOKEN_SECRET is required and must be at least 32 bytes');
    process.exit(1);
  }

  // --- Gateway (in-memory pub/sub for single-node) ---
  const pubsub = new InMemoryPubSub();
  const authority = new GameAuthority(pubsub, () => Date.now());
  const tokenVerifier = new SharedSecretTokenVerifier(secret, ttlSec);
  const gateway = new RealtimeGateway(authority, pubsub, tokenVerifier, () => Date.now());

  // --- HTTP health server ---
  const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'realtime-gateway' }));
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

  // Wait for the WS listener to actually bind before exposing /health, so a
  // failed bind (e.g. port in use) fails startup instead of reporting healthy.
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  // Health server on port+1
  const healthPort = port + 1;
  await new Promise<void>((resolve, reject) => {
    healthServer.once('error', reject);
    healthServer.listen(healthPort, host, () => resolve());
  });

  console.log(`[realtime-gateway] WS  listening on ws://${host}:${port}`);
  console.log(`[realtime-gateway] Health on http://${host}:${healthPort}/health`);

  // Graceful shutdown — close active client sockets first, since wss.close()
  // only stops accepting new connections and its callback would otherwise
  // stall until every existing client disconnects on its own.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Shutdown signal received — closing');
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close(() => {
      healthServer.close(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((err: unknown) => {
  console.error('Failed to start realtime gateway:', err);
  process.exit(1);
});
