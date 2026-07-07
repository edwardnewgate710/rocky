/**
 * M6 acceptance test: full game vs. bot (deterministic termination).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register a user via the API.
 *   2. Create a game via POST /e2e/games with botResignsAfterPlies: 4
 *      (bot resigns on its turn after ply 4 — i.e. after 2 human + 2 bot moves).
 *   3. Set the auth session in localStorage so the frontend joins as a player.
 *   4. Navigate to the game page, verify the board renders.
 *   5. Play real DOM moves as white by clicking squares (e2→e4, then d2→d3).
 *      The bot replies to each move via the harness.
 *   6. After the bot's second reply (ply 4), the bot resigns.
 *   7. Assert the UI shows a terminal state (resignation).
 *
 * The bridge route is test infrastructure inside the harness — it is NOT part
 * of the product API. The botResignsAfterPlies lever gives deterministic
 * termination without unbounded random play.
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

/** Click a square on the board by its algebraic name (e.g. "e2"). */
async function clickSquare(page: Page, square: string) {
  const el = page.locator(`[data-square="${square}"]`);
  await el.click();
}

test('full game vs. bot — play moves through DOM, bot resigns, terminal state shown', async ({ page, request }) => {
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

  // 3. Set the auth session in localStorage so the frontend joins as a player
  await page.goto('/');
  await page.evaluate(({ token, handle: h }) => {
    localStorage.setItem('gambit-session', JSON.stringify({
      accessToken: token,
      handle: h,
      userId: '',
      roles: [],
    }));
  }, { token: accessToken, handle });

  // 4. Navigate to the game page
  await page.goto(`/game/${gameId}`);

  // Wait for the board to render
  const board = page.locator('#board');
  await expect(board).toBeVisible({ timeout: 10_000 });

  // Wait for the status element
  const status = page.locator('#status');
  await expect(status).toBeVisible({ timeout: 10_000 });

  // 5. Play move 1 as white: e2→e4
  await clickSquare(page, 'e2');
  await clickSquare(page, 'e4');

  // Wait for the bot to reply
  await page.waitForTimeout(2000);

  // 6. Play move 2 as white: d2→d3
  await clickSquare(page, 'd2');
  await clickSquare(page, 'd3');

  // Wait for the bot to reply and then resign (ply 4 reached)
  await page.waitForTimeout(3000);

  // 7. Assert the UI shows a terminal state
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
      statusText.includes('insufficient') ||
      statusText.includes('fifty') ||
      statusText.includes('threefold') ||
      statusText.includes('variant') ||
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
