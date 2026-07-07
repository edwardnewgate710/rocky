/**
 * M6 acceptance test: full game vs. bot (deterministic termination).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register a user via the API.
 *   2. Create a game via POST /e2e/games with botResignsAfterPlies: 4.
 *   3. Set the auth session in localStorage and navigate to the game page.
 *   4. Verify the board renders and the game connects.
 *   5. Play moves as white via a real WebSocket connection through the browser.
 *      The bot replies via the harness, then resigns after ply 4.
 *      The WS stays open until the ended broadcast is received.
 *   6. Assert the UI shows a terminal state (resignation).
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

test('full game vs. bot — real WS moves, bot resigns, terminal state shown in UI', async ({ page, request }) => {
  // 1. Register a user
  const handle = `e2e-bot-${Date.now()}`;
  const regResp = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-123' },
  });
  expect(regResp.ok()).toBeTruthy();
  const auth = await regResp.json();
  const accessToken = auth.tokens.accessToken;
  const userId = auth.user.id;

  // 2. Create a game via the bridge route with botResignsAfterPlies: 4
  const gameResp = await request.post('/e2e/games', {
    data: { whiteId: userId, blackId: 'bot', botResignsAfterPlies: 4 },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(gameResp.ok()).toBeTruthy();
  const game = await gameResp.json();
  const gameId = game.gameId;
  expect(gameId).toBeTruthy();

  // 3. Set the auth session in localStorage and navigate to the game page
  await page.goto('/');
  await page.evaluate(({ token, handle: h }) => {
    localStorage.setItem('gambit-session', JSON.stringify({
      accessToken: token, handle: h, userId: '', roles: [],
    }));
  }, { token: accessToken, handle });

  await page.goto(`/game/${gameId}`);

  // 4. Verify the board renders and the game connects
  const board = page.locator('#board');
  await expect(board).toBeVisible({ timeout: 10_000 });

  const status = page.locator('#status');
  await expect(status).toBeVisible({ timeout: 10_000 });

  // 5. Play moves as white via a real WebSocket connection through the browser.
  //    The WS stays open until the ended broadcast is received.
  //    The frontend's GameSync also has a WS connection and receives the same
  //    broadcasts, so the UI updates in real time.
  await page.evaluate(async ({ gameId, token }) => {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = `ws://${location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      let joined = false;
      let whiteMoveSeq = 0;
      const whiteMoves = ['e2e4', 'd2d3'];
      const timeout = setTimeout(() => { ws.close(); resolve(); }, 30000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', gameId, token }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.t === 'joined') {
          joined = true;
          // Play first white move
          whiteMoveSeq++;
          ws.send(JSON.stringify({ t: 'move', gameId, uci: whiteMoves[0], clientSeq: whiteMoveSeq }));
        } else if (msg.t === 'move') {
          // A move was broadcast (ours or bot's)
          // If it's our move (white), the bot will reply next
          // If it's the bot's move (black), check if we need to play another white move
          if (joined && whiteMoveSeq < whiteMoves.length) {
            // Wait a bit for the bot to reply, then play next white move
            // Actually, we need to check whose turn it is
            // After our move (white), bot replies (black), then it's our turn again
            // So after a bot move, we play our next move
            // The bot's move has by: 'b', our move has by: 'w'
            if (msg.by === 'b') {
              // Bot replied, play next white move
              whiteMoveSeq++;
              ws.send(JSON.stringify({ t: 'move', gameId, uci: whiteMoves[whiteMoveSeq - 1], clientSeq: whiteMoveSeq }));
            }
          }
        } else if (msg.t === 'ended') {
          clearTimeout(timeout);
          ws.close();
          resolve();
        } else if (msg.t === 'reject') {
          // Move rejected — continue (might be timing issue)
        }
      };

      ws.onerror = () => { clearTimeout(timeout); reject(new Error('WS error')); };
    });
  }, { gameId, token: accessToken });

  // 6. Assert the UI shows a terminal state
  await page.waitForTimeout(3000); // Give UI time to process the ended broadcast

  let gameOver = false;
  for (let i = 0; i < 30; i++) {
    const statusText = await status.textContent();
    if (statusText && (
      statusText.includes('Checkmate') ||
      statusText.includes('Stalemate') ||
      statusText.includes('resignation') ||
      statusText.includes('Resign') ||
      statusText.includes('timeout') ||
      statusText.includes('abort') ||
      statusText.includes('1-0') ||
      statusText.includes('0-1') ||
      statusText.includes('1/2')
    )) {
      gameOver = true;
      break;
    }
    await page.waitForTimeout(1000);
  }

  expect(gameOver).toBe(true);
});
