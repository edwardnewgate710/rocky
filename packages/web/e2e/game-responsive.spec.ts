import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend');

test('the game board is usable without horizontal overflow at 390 by 844', async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();

  try {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const handle = `e2e-mobile-${suffix}`;
    const registration = await request.post('/v1/auth/register', {
      data: { handle, password: 'test-password-123' },
    });
    expect(registration.ok()).toBeTruthy();
    const auth = await registration.json();

    const gameResponse = await request.post('/e2e/games', {
      data: { whiteId: auth.user.id, botResignsAfterPlies: 10 },
      headers: { Authorization: `Bearer ${auth.tokens.accessToken}` },
    });
    expect(gameResponse.ok()).toBeTruthy();
    const game = await gameResponse.json();

    await context.addCookies([{
      name: 'gambit_refresh',
      value: auth.tokens.refreshToken,
      domain: 'localhost',
      path: '/v1/auth',
      httpOnly: true,
      secure: false,
      sameSite: 'Strict',
    }]);
    await page.addInitScript(({ userHandle, userId }) => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: userHandle, userId }));
    }, { userHandle: handle, userId: auth.user.id });

    await page.goto(`/game/${game.gameId}`);
    const board = page.locator('.cb-board');
    await expect(board).toBeVisible();

    const box = await board.boundingBox();
    if (box === null) throw new Error('board has no rendered bounds');
    expect(box.width).toBeGreaterThanOrEqual(350);
    expect(Math.abs(box.width - box.height)).toBeLessThan(1);
    expect(await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))).toEqual({ documentWidth: 390, viewportWidth: 390 });
  } finally {
    await context.close();
  }
});
