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
 *   5. Play moves as white via POST /e2e/games/:gameId/moves (HTTP bridge
 *      that calls authority.apply directly). The bot replies via the harness,
 *      then resigns after ply 3. The frontend's GameSync receives the
 *      broadcasts via WS and updates the UI in real time.
 *   6. Assert the UI shows a terminal state (resignation).
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

test('full game vs. bot — real moves via HTTP bridge, bot resigns, terminal state shown', async ({ page, request }) => {
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

  // 5. Play moves as white via the HTTP bridge
  //    The authority processes the move and broadcasts via pub/sub.
  //    The bot receives the broadcast and replies (or resigns).
  //    The frontend's GameSync receives the broadcasts and updates the UI.

  // Move 1: e2→e4 (via fetch from the browser page — goes through vite proxy)
  const move1Result = await page.evaluate(async ({ gameId, userId }) => {
    const resp = await fetch(`/e2e/games/${gameId}/moves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uci: 'e2e4', userId }),
    });
    return { ok: resp.ok, status: resp.status, body: await resp.text() };
  }, { gameId, userId });
  expect(move1Result.ok).toBeTruthy();
  await page.waitForTimeout(2000); // Wait for bot reply

  // Move 2: d2→d3
  const move2Result = await page.evaluate(async ({ gameId, userId }) => {
    const resp = await fetch(`/e2e/games/${gameId}/moves`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uci: 'd2d3', userId }),
    });
    return { ok: resp.ok, status: resp.status, body: await resp.text() };
  }, { gameId, userId });
  expect(move2Result.ok).toBeTruthy();
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
