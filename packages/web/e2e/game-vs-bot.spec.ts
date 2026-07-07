/**
 * M6 acceptance test: full game vs. bot (deterministic termination).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register a user via the API.
 *   2. Create a game via POST /e2e/games where the bot plays BOTH sides
 *      (whiteId and blackId both set to 'bot') with botResignsAfterPlies: 3.
 *      The bot plays moves for both sides and resigns after ply 3.
 *   3. Navigate to the game page as a spectator.
 *   4. Verify the board renders and the game connects.
 *   5. Wait for the bot to play moves and resign (the UI updates in real time
 *      as the GameSync receives move and ended broadcasts).
 *   6. Assert the UI shows a terminal state (resignation).
 *
 * The bot plays real moves through the authority (real game state, real
 * broadcasts). The frontend's GameSync receives the broadcasts and updates
 * the board and status text. This is a full game lifecycle — create →
 * join → play → terminate → terminal UI — through the real harness.
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

test('full game vs. bot — bot plays both sides and resigns, terminal state shown in UI', async ({ page, request }) => {
  // 1. Register a user (for auth to view the game)
  const handle = `e2e-bot-${Date.now()}`;
  const regResp = await request.post('/v1/auth/register', {
    data: { handle, password: 'test-password-123' },
  });
  expect(regResp.ok()).toBeTruthy();
  const auth = await regResp.json();
  const accessToken = auth.tokens.accessToken;

  // 2. Create a game where the bot plays both sides
  //    The bot will play moves for both white and black, then resign after ply 3.
  const gameResp = await request.post('/e2e/games', {
    data: { whiteId: 'bot', blackId: 'bot', botResignsAfterPlies: 3 },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(gameResp.ok()).toBeTruthy();
  const game = await gameResp.json();
  const gameId = game.gameId;
  expect(gameId).toBeTruthy();

  // 3. Navigate to the game page (as a spectator — no localStorage)
  await page.goto(`/game/${gameId}`);

  // 4. Verify the board renders and the game connects
  const board = page.locator('#board');
  await expect(board).toBeVisible({ timeout: 10_000 });

  const status = page.locator('#status');
  await expect(status).toBeVisible({ timeout: 10_000 });

  // 5. Wait for the bot to play moves and resign
  //    The bot plays both sides: white move (ply 1), black move (ply 2),
  //    white move (ply 3), then bot resigns on black's turn (ply 3 >= 3).
  //    The UI should update as broadcasts are received by the GameSync.
  await page.waitForTimeout(5000); // Give the bot time to play and resign

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
