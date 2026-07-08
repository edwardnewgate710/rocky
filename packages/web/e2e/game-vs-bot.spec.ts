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
 *   5. Play moves as white by clicking squares on the board (select-then-drop):
 *        Click e2, click e4   (ply 1)
 *        Bot replies          (ply 2)
 *        Click d2, click d3   (ply 3)
 *        Bot resigns          (ply 3 >= 3, bot's turn)
 *      Each move goes through the real UI loop: click → BoardInteraction →
 *      oracle → GameSync.submitMove → WS → authority → broadcast → UI update.
 *   6. Assert the UI shows a terminal state (resignation).
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

/** Wait for the status text to change (indicates a move/broadcast was processed). */
async function waitForStatusChange(page: Page, status: Page.Locator, lastText: string, timeoutMs = 15000): Promise<string> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const text = await status.textContent();
    if (text !== lastText) return text ?? '';
    await page.waitForTimeout(500);
  }
  return lastText;
}

test('full game vs. bot — DOM clicks, bot resigns, terminal state shown', async ({ page, request }) => {
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
  //    Bot (auto-seated as black by bridge) resigns on its turn after ply 3.
  const gameResp = await request.post('/e2e/games', {
    data: { whiteId: userId, botResignsAfterPlies: 3 },
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

  // Wait for the WS to connect and join (status should show "Your move" or "White to move")
  await page.waitForTimeout(3000);

  // 5. Play moves as white by clicking squares
  //    Move 1: e2→e4 (click e2 to select, click e4 to drop)
  let statusBefore = await status.textContent();
  await clickSquare(page, 'e2');
  await page.waitForTimeout(200);
  await clickSquare(page, 'e4');
  // Wait for the move to be processed and the bot to reply
  await waitForStatusChange(page, status, statusBefore ?? '', 15000);
  // Wait for bot's reply to be received (status should change again)
  statusBefore = await status.textContent();
  await waitForStatusChange(page, status, statusBefore ?? '', 15000);

  //    Move 2: d2→d3
  statusBefore = await status.textContent();
  await clickSquare(page, 'd2');
  await page.waitForTimeout(200);
  await clickSquare(page, 'd3');
  // Wait for the move to be processed and the bot to resign
  await waitForStatusChange(page, status, statusBefore ?? '', 15000);

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
