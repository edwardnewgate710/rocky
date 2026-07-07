/**
 * M6 acceptance test: full game vs. bot.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register a new user via the API.
 *   2. Create a game via the harness bridge route POST /e2e/games (bot as black).
 *   3. Navigate to the game page, verify the board renders.
 *   4. The bot plays automatically; verify the game reaches a terminal state.
 *
 * The bridge route is test infrastructure inside the harness — it is NOT part
 * of the product API. It calls authority.createGame(...) + bot.registerGame(...).
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

test('full game vs. bot plays to completion', async ({ page, request }) => {
  // 1. Register a user via the API
  const handle = `e2e-bot-${Date.now()}`;
  const password = 'test-password-123';
  const regResp = await request.post('/v1/auth/register', {
    data: { handle, password },
  });
  expect(regResp.ok()).toBeTruthy();
  const auth = await regResp.json();
  const accessToken = auth.tokens.accessToken;
  const userId = auth.user.id;

  // 2. Create a game via the harness bridge route POST /e2e/games
  //    The bot is seated as black automatically.
  const gameResp = await request.post('/e2e/games', {
    data: {
      whiteId: userId,
      blackId: 'bot',
    },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(gameResp.ok()).toBeTruthy();
  const game = await gameResp.json();
  const gameId = game.gameId;
  expect(gameId).toBeTruthy();

  // 3. Navigate to the game page
  await page.goto(`/game/${gameId}`);

  // Wait for the board to render
  const board = page.locator('#board');
  await expect(board).toBeVisible({ timeout: 10_000 });

  // Wait for the game to connect (the WS connection is established by bootstrap)
  const status = page.locator('#status');
  await expect(status).toBeVisible({ timeout: 10_000 });

  // 4. Wait for the game to end — the bot plays automatically.
  // We poll the status text for a terminal state.
  let gameOver = false;
  for (let i = 0; i < 120; i++) {
    const statusText = await status.textContent();
    if (statusText && (statusText.includes('Checkmate') || statusText.includes('Stalemate') ||
        statusText.includes('Draw') || statusText.includes('resign') || statusText.includes('timeout') ||
        statusText.includes('abort') || statusText.includes('insufficient') ||
        statusText.includes('fifty') || statusText.includes('threefold') ||
        statusText.includes('variant'))) {
      gameOver = true;
      break;
    }
    await page.waitForTimeout(500);
  }

  // 5. Verify the game reached a terminal state
  expect(gameOver).toBe(true);
});
