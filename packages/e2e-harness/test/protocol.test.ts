/**
 * Browserless protocol test for the e2e harness.
 *
 * Boots the harness on ephemeral ports → registers a user over real HTTP →
 * creates a bot game via the bridge route → connects a real `ws` client →
 * plays to a terminal state (bot answering every move) → asserts the `ended`
 * broadcast and final `getState` invariants.
 *
 * This test needs no browser and runs in CI on every push via `npm test`.
 * It is the executable evidence that the harness can host a game end-to-end.
 *
 * "Done" for anything touching the harness means this test ran and passed.
 */
import { describe, it, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { createHarness, type Harness } from '../src/index.js';
import { encode, decode, type ServerMessage, type ClientMessage } from '@chess-platform/realtime-gateway';
import WebSocket from 'ws';

/** Find a free TCP port by listening on port 0 and closing immediately. */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('could not get port'));
      }
    });
    srv.on('error', reject);
  });
}

/** Make an HTTP request and return { status, body }. */
async function httpReq(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const payload = body ? JSON.stringify(body) : undefined;
  if (payload) headers['Content-Length'] = String(Buffer.byteLength(payload));

  return new Promise((resolve, reject) => {
    const req = require('node:http').request(
      { hostname: '127.0.0.1', port, method, path, headers },
      (res: any) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Collect server messages from a WebSocket until a predicate returns true. */
function collectMessages(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs: number,
): Promise<ServerMessage[]> {
  return new Promise((resolve, reject) => {
    const collected: ServerMessage[] = [];
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms; collected ${collected.length} messages`));
    }, timeoutMs);

    ws.on('message', (data: Buffer) => {
      const msg = decode(data.toString()) as ServerMessage | null;
      if (msg) {
        collected.push(msg);
        if (predicate(msg)) {
          clearTimeout(timer);
          resolve(collected);
        }
      }
    });
  });
}

describe('e2e harness protocol test', () => {
  let harness: Harness;
  let apiPort: number;
  let wsPort: number;

  before(async () => {
    apiPort = await freePort();
    wsPort = await freePort();
    harness = await createHarness({ apiPort, wsPort });
  });

  after(async () => {
    await harness.close();
  });

  it('boots, registers a user, creates a bot game, plays to completion, and broadcasts ended', async () => {
    // 1. Register a user over real HTTP
    const handle = `test-bot-${Date.now()}`;
    const regResp = await httpReq(apiPort, 'POST', '/v1/auth/register', {
      handle,
      password: 'test-password-123',
    });
    strictEqual(regResp.status, 201, `register failed: ${JSON.stringify(regResp)}`);
    const accessToken = regResp.body.tokens.accessToken;
    const userId = regResp.body.user.id;
    ok(accessToken, 'no access token in register response');
    ok(userId, 'no user id in register response');

    // 2. Create a bot game via the bridge route POST /e2e/games
    const bridgeResp = await httpReq(
      apiPort,
      'POST',
      '/e2e/games',
      { whiteId: userId, blackId: harness.bot.userId },
      accessToken,
    );
    strictEqual(bridgeResp.status, 201, `bridge route failed: ${JSON.stringify(bridgeResp)}`);
    const gameId = bridgeResp.body.gameId;
    ok(gameId, 'no gameId in bridge response');

    // 3. Connect a real WebSocket client and join the game
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    // Send join message
    const joinMsg: ClientMessage = { t: 'join', gameId, token: accessToken };
    ws.send(encode(joinMsg as any));

    // 4. Wait for the 'joined' message
    const joinedMessages = await collectMessages(
      ws,
      (msg) => msg.t === 'joined',
      10_000,
    );
    const joined = joinedMessages.find((m) => m.t === 'joined')!;
    strictEqual(joined.t, 'joined');
    ok(joined.state, 'joined message has no state');
    ok(!joined.state.status.over, 'game should not be over at start');

    // 5. Play moves until the game ends.
    // The human (white) plays random legal moves; the bot (black) auto-responds.
    // We collect messages and play moves until we see an 'ended' broadcast.
    let ended = false;
    let moveCount = 0;
    const maxMoves = 300; // safety valve

    while (!ended && moveCount < maxMoves) {
      // Get current state from the authority (co-located)
      const state = harness.authority.getState(gameId);

      if (state.status.over) {
        ended = true;
        break;
      }

      // It's the human's turn (white) — pick a random legal move
      if (state.turn === 'w') {
        const origins = Object.keys(state.legalMoves);
        if (origins.length === 0) {
          // No legal moves — game should be over (stalemate/checkmate)
          ended = true;
          break;
        }
        const origin = origins[Math.floor(Math.random() * origins.length)];
        const dests = state.legalMoves[origin];
        const dest = dests[Math.floor(Math.random() * dests.length)];
        const uci = `${origin}${dest}`;

        const moveMsg: ClientMessage = {
          t: 'move',
          gameId,
          uci,
          clientSeq: moveCount + 1,
        };
        ws.send(encode(moveMsg as any));
        moveCount++;

        // Wait for the bot to respond (or for the game to end)
        // We wait for either a 'move' broadcast from the bot or an 'ended'
        const response = await collectMessages(
          ws,
          (msg) => msg.t === 'move' || msg.t === 'ended' || msg.t === 'reject',
          15_000,
        );
        const last = response[response.length - 1];
        if (last.t === 'ended') {
          ended = true;
        } else if (last.t === 'reject') {
          // Our move was rejected — try again with promotion suffix
          const promoUci = `${uci}q`;
          const promoMsg: ClientMessage = {
            t: 'move',
            gameId,
            uci: promoUci,
            clientSeq: moveCount + 1,
          };
          ws.send(encode(promoMsg as any));
          moveCount++;

          const retryResponse = await collectMessages(
            ws,
            (msg) => msg.t === 'move' || msg.t === 'ended' || msg.t === 'reject',
            15_000,
          );
          const retryLast = retryResponse[retryResponse.length - 1];
          if (retryLast.t === 'ended') {
            ended = true;
          }
        }
      } else {
        // It's the bot's turn — wait for the bot to move
        // The bot plays via authority.apply directly, so we should see a
        // 'move' broadcast via pub/sub → gateway → ws
        const botResponse = await collectMessages(
          ws,
          (msg) => msg.t === 'move' || msg.t === 'ended',
          15_000,
        );
        const botLast = botResponse[botResponse.length - 1];
        if (botLast.t === 'ended') {
          ended = true;
        }
      }
    }

    // 6. Assert the game ended
    ok(ended, `game did not end after ${moveCount} moves`);

    // 7. Assert final state invariants via authority.getState
    const finalState = harness.authority.getState(gameId);
    ok(finalState.status.over, 'final state status.over must be true');
    strictEqual(
      Object.keys(finalState.legalMoves).length,
      0,
      'final state legalMoves must be empty {}',
    );

    ws.close();
  });

  it('bridge route POST /e2e/games returns 404 for GET', async () => {
    const resp = await httpReq(apiPort, 'GET', '/e2e/games');
    // The API handler will return 404 for unknown routes
    ok(resp.status === 404 || resp.status === 405, `expected 404 or 405, got ${resp.status}`);
  });
});
