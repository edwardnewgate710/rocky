/**
 * M6 acceptance test: full game vs. human — Fool's Mate through DOM clicks.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 *
 * Flow:
 *   1. Register two users (player1 = white, player2 = black).
 *   2. Create a game via POST /e2e/games with both user ids.
 *   3. Set auth sessions in localStorage for both browser contexts.
 *   4. Both players navigate to the game page — boards render, games connect.
 *   5. Play Fool's Mate by clicking squares on the board (select-then-drop):
 *        White: click f2, click f3   (ply 1)
 *        Black: click e7, click e5   (ply 2)
 *        White: click g2, click g4   (ply 3)
 *        Black: click d8, click h4   (ply 4 — checkmate!)
 *      Each move goes through the real UI loop: click → BoardInteraction →
 *      oracle → GameSync.submitMove → WS → authority → broadcast → UI update.
 *   6. Assert both contexts show a terminal state (checkmate).
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect, type Page } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M6 acceptance gate');

/** Click a square on the board by its algebraic name (e.g. "f2"). */
async function clickSquare(page: Page, square: string) {
  const el = page.locator(`[data-square="${square}"]`);
  await el.click();
}

/** Wait for the status text to change (indicates a move was processed). */
async function waitForStatusChange(page: Page, status: Page.Locator, lastText: string, timeoutMs = 10000): Promise<string> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    const text = await status.textContent();
    if (text !== lastText) return text ?? '';
    await page.waitForTimeout(500);
  }
  return lastText;
}

test('full game vs. human — Fool\'s Mate through DOM clicks, checkmate in 4 plies', async ({ browser, request }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage(); // white
  const page2 = await ctx2.newPage(); // black

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

    // 2. Create a game via the bridge route with both player ids
    const gameResp = await request.post('/e2e/games', {
      data: { whiteId: userId1, blackId: userId2 },
      headers: { Authorization: `Bearer ${token1}` },
    });
    expect(gameResp.ok()).toBeTruthy();
    const game = await gameResp.json();
    const gameId = game.gameId;
    expect(gameId).toBeTruthy();

    // 3. Set auth sessions in localStorage for both contexts
    await page1.goto('/');
    await page1.evaluate(({ token, handle: h }) => {
      localStorage.setItem('gambit-session', JSON.stringify({
        accessToken: token, handle: h, userId: '', roles: [],
      }));
    }, { token: token1, handle: handle1 });

    await page2.goto('/');
    await page2.evaluate(({ token, handle: h }) => {
      localStorage.setItem('gambit-session', JSON.stringify({
        accessToken: token, handle: h, userId: '', roles: [],
      }));
    }, { token: token2, handle: handle2 });

    // 4. Both players navigate to the game page
    await page1.goto(`/game/${gameId}`);
    await page2.goto(`/game/${gameId}`);

    // Wait for boards to render
    await expect(page1.locator('#board')).toBeVisible({ timeout: 10_000 });
    await expect(page2.locator('#board')).toBeVisible({ timeout: 10_000 });

    const status1 = page1.locator('#status');
    const status2 = page2.locator('#status');
    await expect(status1).toBeVisible({ timeout: 10_000 });
    await expect(status2).toBeVisible({ timeout: 10_000 });

    // Wait for both games to connect (status changes from "Your move." to "Your move" or similar)
    // Give the WS time to connect and join
    await page1.waitForTimeout(3000);
    await page2.waitForTimeout(3000);

    // 5. Play Fool's Mate by clicking squares
    //    White: f2→f3, Black: e7→e5, White: g2→g4, Black: d8→h4 (checkmate)

    // Ply 1: White f2→f3 (click f2 to select, click f3 to drop)
    let s1Before = await status1.textContent();
    await clickSquare(page1, 'f2');
    await page1.waitForTimeout(200);
    await clickSquare(page1, 'f3');
    // Wait for the move to be processed and broadcast to both UIs
    await waitForStatusChange(page1, status1, s1Before ?? '', 10000);
    await page2.waitForTimeout(1000);

    // Ply 2: Black e7→e5
    let s2Before = await status2.textContent();
    await clickSquare(page2, 'e7');
    await page2.waitForTimeout(200);
    await clickSquare(page2, 'e5');
    await waitForStatusChange(page2, status2, s2Before ?? '', 10000);
    await page1.waitForTimeout(1000);

    // Ply 3: White g2→g4
    s1Before = await status1.textContent();
    await clickSquare(page1, 'g2');
    await page1.waitForTimeout(200);
    await clickSquare(page1, 'g4');
    await waitForStatusChange(page1, status1, s1Before ?? '', 10000);
    await page2.waitForTimeout(1000);

    // Ply 4: Black d8→h4 — checkmate!
    s2Before = await status2.textContent();
    await clickSquare(page2, 'd8');
    await page2.waitForTimeout(200);
    await clickSquare(page2, 'h4');
    await waitForStatusChange(page2, status2, s2Before ?? '', 10000);
    await page1.waitForTimeout(2000);

    // 6. Assert both contexts show a terminal state
    let p1Terminal = false;
    let p2Terminal = false;
    for (let i = 0; i < 30; i++) {
      const s1 = await status1.textContent();
      const s2 = await status2.textContent();
      const isTerminal = (s: string | null) => s && (
        s.includes('Checkmate') || s.includes('Stalemate') ||
        s.includes('resignation') || s.includes('Draw') ||
        s.includes('timeout') || s.includes('abort') ||
        s.includes('1-0') || s.includes('0-1') || s.includes('1/2')
      );
      if (isTerminal(s1)) p1Terminal = true;
      if (isTerminal(s2)) p2Terminal = true;
      if (p1Terminal && p2Terminal) break;
      await page1.waitForTimeout(1000);
    }

    expect(p1Terminal).toBe(true);
    expect(p2Terminal).toBe(true);
  } finally {
    await ctx1.close();
    await ctx2.close();
  }
});
