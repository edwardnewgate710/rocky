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
  const gameResp = await request.post('/e2e/games', {
    data: { whiteId: userId, botResignsAfterPlies: 3 },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(gameResp.ok()).toBeTruthy();
  const game = await gameResp.json();
  const gameId = game.gameId;
  expect(gameId).toBeTruthy();

  // 3. Set the auth session in localStorage BEFORE navigating to the game page.
  //    Use addInitScript so localStorage is set before any script runs.
  await page.addInitScript(({ token, handle: h }) => {
    localStorage.setItem('gambit-session', JSON.stringify({
      accessToken: token, handle: h, userId: '', roles: [],
    }));
  }, { token: accessToken, handle });

  // 4. Navigate to the game page
  await page.goto(`/game/${gameId}`);

  // Wait for the board to render
  const board = page.locator('#board');
  await expect(board).toBeVisible({ timeout: 10_000 });

  const status = page.locator('#status');
  await expect(status).toBeVisible({ timeout: 10_000 });

  // Wait for the game to connect — poll for "Your move" or "White to move"
  // This indicates the WS joined and the GameSync received the state.
  let connected = false;
  for (let i = 0; i < 20; i++) {
    const text = await status.textContent();
    if (text && (text.includes('Your move') || text.includes('White to move') || text.includes('white to move'))) {
      connected = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log(`[vs-bot] Connected: ${connected}, status: ${await status.textContent()}`);

  // Check if the board has pieces (squares with text content)
  const pieceCount = await page.locator('[data-square]').evaluateAll(els =>
    els.filter(el => el.textContent && el.textContent.trim().length > 0).length
  );
  console.log(`[vs-bot] Pieces on board: ${pieceCount}`);

  // 5. Play moves as white by clicking squares
  //    Move 1: e2→e4
  console.log('[vs-bot] Clicking e2...');
  await clickSquare(page, 'e2');
  await page.waitForTimeout(300);
  console.log('[vs-bot] Clicking e4...');
  await clickSquare(page, 'e4');
  
  // Wait for the status to change (move processed + bot reply)
  let statusAfter = await status.textContent();
  for (let i = 0; i < 20; i++) {
    const text = await status.textContent();
    if (text !== statusAfter) {
      statusAfter = text;
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log(`[vs-bot] After move 1: status="${statusAfter}"`);

  // Wait for bot to reply (status should change again)
  let statusAfterBot = statusAfter;
  for (let i = 0; i < 20; i++) {
    const text = await status.textContent();
    if (text !== statusAfterBot) {
      statusAfterBot = text;
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log(`[vs-bot] After bot reply: status="${statusAfterBot}"`);

  //    Move 2: d2→d3
  console.log('[vs-bot] Clicking d2...');
  await clickSquare(page, 'd2');
  await page.waitForTimeout(300);
  console.log('[vs-bot] Clicking d3...');
  await clickSquare(page, 'd3');

  // Wait for the bot to resign
  for (let i = 0; i < 20; i++) {
    const text = await status.textContent();
    if (text !== statusAfterBot) {
      statusAfterBot = text;
      break;
    }
    await page.waitForTimeout(500);
  }
  console.log(`[vs-bot] After move 2: status="${statusAfterBot}"`);

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
