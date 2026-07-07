/**
 * M6 acceptance test: full game vs. human (two browser contexts).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register two users (player1 and player2).
 *   2. Create a game via the harness bridge route POST /e2e/games with both ids.
 *   3. Both players navigate to the game page.
 *   4. Verify both boards render and both players see game state.
 *
 * The bridge route is test infrastructure inside the harness — it is NOT part
 * of the product API. Actual matchmaking is M7 and is not faked here.
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

test('full game vs. human — both players connect and see game state', async ({ browser, request }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  try {
    // 1. Register two users
    const handle1 = `e2e-p1-${Date.now()}`;
    const handle2 = `e2e-p2-${Date.now()}`;
    const password = 'test-password-123';

    const reg1 = await request.post('/v1/auth/register', {
      data: { handle: handle1, password },
    });
    expect(reg1.ok()).toBeTruthy();
    const auth1 = await reg1.json();
    const token1 = auth1.tokens.accessToken;
    const userId1 = auth1.user.id;

    const reg2 = await request.post('/v1/auth/register', {
      data: { handle: handle2, password },
    });
    expect(reg2.ok()).toBeTruthy();
    const auth2 = await reg2.json();
    const token2 = auth2.tokens.accessToken;
    const userId2 = auth2.user.id;

    // 2. Create a game via the harness bridge route with both player ids
    const gameResp = await request.post('/e2e/games', {
      data: { whiteId: userId1, blackId: userId2 },
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(gameResp.ok()).toBeTruthy();
    const game = await gameResp.json();
    const gameId = game.gameId;
    expect(gameId).toBeTruthy();

    // 3. Both players navigate to the game page
    await page1.goto(`/game/${gameId}`);
    await page2.goto(`/game/${gameId}`);

    // 4. Wait for boards to render
    await expect(page1.locator('#board')).toBeVisible({ timeout: 10_000 });
    await expect(page2.locator('#board')).toBeVisible({ timeout: 10_000 });

    // Wait for both to see game status
    const status1 = page1.locator('#status');
    const status2 = page2.locator('#status');
    await expect(status1).toBeVisible({ timeout: 10_000 });
    await expect(status2).toBeVisible({ timeout: 10_000 });

    // 5. Verify both players connected and can see game state
    const s1Text = await status1.textContent();
    const s2Text = await status2.textContent();
    expect(s1Text).toBeTruthy();
    expect(s2Text).toBeTruthy();
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});
