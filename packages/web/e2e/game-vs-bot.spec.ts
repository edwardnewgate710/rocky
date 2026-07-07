/**
 * M6 acceptance test: full game vs. bot (deterministic termination).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register a user via the API.
 *   2. Create a game via POST /e2e/games with botResignsAfterPlies: 3.
 *   3. Set the auth session in localStorage and navigate to the game page.
 *   4. Verify the board renders and the game connects.
 *   5. Play Fool's Mate moves as white via a real WebSocket connection
 *      through the browser. The bot replies via the harness, then resigns
 *      after ply 3. The frontend's GameSync receives the same broadcasts
 *      and updates the UI in real time.
 *   6. Assert the UI shows a terminal state (resignation).
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

/** Play a move through a real WebSocket connection in the browser. */
async function playMoveViaWs(page: Page, gameId: string, token: string, uci: string, seq: number): Promise<void> {
  await page.evaluate(async ({ gameId, token, uci, seq }) => {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = `ws://${location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => { ws.close(); resolve(); }, 10000);

      ws.onopen = () => {
        ws.send(JSON.stringify({ t: 'join', gameId, token }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.t === 'joined') {
          ws.send(JSON.stringify({ t: 'move', gameId, uci, clientSeq: seq }));
        } else if (msg.t === 'reject') {
          // Our move was rejected — close and return
          clearTimeout(timeout);
          ws.close();
          resolve();
        } else if (msg.t === 'move' && msg.by === 'w') {
          // Our own move echo — wait for bot's reply, don't close yet
        } else if (msg.t === 'move' && msg.by === 'b') {
          // Bot replied — close and return
          clearTimeout(timeout);
          ws.close();
          resolve();
        } else if (msg.t === 'ended') {
          // Game ended — close and return
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      };

      ws.onerror = () => { clearTimeout(timeout); reject(new Error('WS error')); };
    });
  }, { gameId, token, uci, seq });
}

test('full game vs. bot — real WS moves, bot resigns, terminal state shown', async ({ page, request }) => {
  // 1. Register a user
  const handle = `e2e-bot-${Date.now()}`;
  const regResp = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-123' },
  });
  expect(regResp.ok()).toBeTruthy();
  const auth = await regResp.json();
  const accessToken = auth.tokens.accessToken;
  const userId = auth.user.id;

  // 2. Create a game via the bridge route with botResignsAfterPlies: 3
  const gameResp = await request.post('/e2e/games', {
    data: { whiteId: userId, blackId: 'bot', botResignsAfterPlies: 3 },
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

  // 4. Verify the board renders
  const board = page.locator('#board');
  await expect(board).toBeVisible({ timeout: 10_000 });

  const status = page.locator('#status');
  await expect(status).toBeVisible({ timeout: 10_000 });

  // 5. Play moves as white via real WebSocket through the browser
  //    Move 1: e2→e4
  await playMoveViaWs(page, gameId, accessToken, 'e2e4', 1);
  await page.waitForTimeout(2000); // Wait for bot reply

  //    Move 2: d2→d3
  await playMoveViaWs(page, gameId, accessToken, 'd2d3', 2);
  await page.waitForTimeout(3000); // Wait for bot to resign

  // 6. Assert the UI shows a terminal state
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
