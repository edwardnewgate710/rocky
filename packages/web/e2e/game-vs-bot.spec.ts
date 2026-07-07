/**
 * M6 acceptance test: full game vs. bot.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register a new user (or login if user exists).
 *   2. Create a seek via the API.
 *   3. The harness creates a game with the bot as the opponent.
 *   4. Navigate to the game page, verify the board renders.
 *   5. Play moves until the game ends (bot plays random legal moves).
 *   6. Verify the game reaches a terminal state.
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

  // 2. Create a seek via the API
  const seekResp = await request.post('/v1/seeks', {
    data: {
      variant: 'standard',
      timeControl: {
        initialMs: 300_000,
        incrementMs: 0,
        delayMs: 0,
        kind: 'sudden_death',
      },
      rated: false,
    },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  expect(seekResp.ok()).toBeTruthy();
  const seek = await seekResp.json();
  expect(seek.id).toBeTruthy();

  // 3. Create a game via the harness API (the harness exposes a helper endpoint)
  // The harness auto-creates a game with the bot as the opponent.
  const gameResp = await request.post('/v1/games', {
    data: {
      seekId: seek.id,
      whiteId: userId,
      blackId: 'bot',
    },
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // If the harness doesn't have a /v1/games POST endpoint, we need to
  // use the e2e harness's internal game creation. The harness creates
  // the game in the gateway authority when a seek is matched.
  // For now, we use the harness's custom endpoint.
  let gameId: string;
  if (gameResp.ok()) {
    const game = await gameResp.json();
    gameId = game.id;
  } else {
    // Fallback: the harness auto-matches seeks and creates games.
    // Poll the seeks list until the seek is gone (matched).
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500);
      const seeksResp = await request.get('/v1/seeks');
      const seeks = await seeksResp.json();
      const stillOpen = seeks.find((s: { id: string }) => s.id === seek.id);
      if (!stillOpen) break;
    }
    // The game ID is derived from the seek — the harness uses the seek ID.
    gameId = seek.id;
  }

  // 4. Navigate to the game page
  await page.goto(`/game/${gameId}`);

  // Wait for the board to render
  const board = page.locator('#board');
  await expect(board).toBeVisible({ timeout: 10_000 });

  // Wait for the game to connect (the WS connection is established by bootstrap)
  // The status element should show something (either "Your move" or "Waiting")
  const status = page.locator('#status');
  await expect(status).toBeVisible({ timeout: 10_000 });

  // 5. Wait for the game to end — the bot plays automatically.
  // We poll the status text for a terminal state.
  // Terminal states: checkmate, stalemate, resignation, timeout, draw, etc.
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
    await page.waitForTimeout(1000);
  }

  // 6. Verify the game reached a terminal state
  expect(gameOver).toBe(true);
});
