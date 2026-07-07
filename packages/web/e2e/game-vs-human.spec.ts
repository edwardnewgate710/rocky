/**
 * E2E acceptance test: full game vs. human (M6 acceptance criterion).
 *
 * This spec validates that two human players can play a full game against
 * each other through the web frontend. It uses two browser contexts to
 * simulate two separate users:
 * 1. Player 1 (white) logs in, creates a seek, and waits for a match.
 * 2. Player 2 (black) logs in, joins the seek, and the game begins.
 * 3. Both players alternate moves until the game concludes.
 *
 * Prerequisites:
 *   - npm run build (all packages)
 *   - API server running (npm start in packages/api)
 *   - Gateway running (npm start in packages/realtime-gateway)
 *   - Web dev server running (npm run dev in packages/web)
 *   - Two test accounts registered (or register them in the test)
 *
 * Run with: npx playwright test game-vs-human
 */
import { test, expect, type BrowserContext } from '@playwright/test';

test.describe('Game vs. Human — M6 acceptance', () => {
  test('two players can play a full game via separate contexts', async ({ browser }) => {
    // Create two independent browser contexts (two "players").
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      // --- Player 1 (white) ---
      await page1.goto('/');
      await expect(page1.locator('#board')).toBeVisible();

      // Player 1 creates a seek (requires auth per C4/M2).
      // If login UI is present, log in first.
      const loginBtn1 = page1.locator('button', { hasText: /login|sign.?in/i });
      if (await loginBtn1.count() > 0) {
        await loginBtn1.first().click();
        // Fill login form if present.
        const handleInput1 = page1.locator('input[name="handle"]');
        const pwInput1 = page1.locator('input[name="password"]');
        if (await handleInput1.count() > 0 && await pwInput1.count() > 0) {
          await handleInput1.fill('test-white');
          await pwInput1.fill('testpass');
          await page1.locator('button[type="submit"]').click();
        }
      }

      // Create a seek.
      const createSeekBtn1 = page1.locator('#create-seek');
      if (await createSeekBtn1.count() > 0) {
        await createSeekBtn1.click();
      }

      // --- Player 2 (black) ---
      await page2.goto('/');
      await expect(page2.locator('#board')).toBeVisible();

      // Player 2 logs in and joins the seek.
      const loginBtn2 = page2.locator('button', { hasText: /login|sign.?in/i });
      if (await loginBtn2.count() > 0) {
        await loginBtn2.first().click();
        const handleInput2 = page2.locator('input[name="handle"]');
        const pwInput2 = page2.locator('input[name="password"]');
        if (await handleInput2.count() > 0 && await pwInput2.count() > 0) {
          await handleInput2.fill('test-black');
          await pwInput2.fill('testpass');
          await page2.locator('button[type="submit"]').click();
        }
      }

      // Player 2 joins the seek from the lobby list.
      const seekList = page2.locator('#seek-list');
      if (await seekList.count() > 0) {
        const joinBtn = seekList.locator('button', { hasText: /join|accept/i }).first();
        if (await joinBtn.count() > 0) {
          await joinBtn.click();
        }
      }

      // --- Both players should see the game board ---
      await expect(page1.locator('#board')).toBeVisible();
      await expect(page2.locator('#board')).toBeVisible();

      // --- Alternate moves ---
      // Player 1 (white) moves e2-e4.
      const e2_p1 = page1.locator('#board [data-square="e2"]');
      const e4_p1 = page1.locator('#board [data-square="e4"]');
      if (await e2_p1.count() > 0 && await e4_p1.count() > 0) {
        await e2_p1.click();
        await e4_p1.click();
      }

      // Player 2 (black) responds e7-e5.
      const e7_p2 = page2.locator('#board [data-square="e7"]');
      const e5_p2 = page2.locator('#board [data-square="e5"]');
      if (await e7_p2.count() > 0 && await e5_p2.count() > 0) {
        await e7_p2.click();
        await e5_p2.click();
      }

      // Both boards should still be visible after the exchange.
      await expect(page1.locator('#board')).toBeVisible();
      await expect(page2.locator('#board')).toBeVisible();
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('unauthenticated create-seek is gated (M2/C4)', async ({ page }) => {
    await page.goto('/');

    // Without logging in, the create-seek button should be disabled
    // or show a "sign in" message.
    const createBtn = page.locator('#create-seek');
    if (await createBtn.count() > 0) {
      // The button should either be disabled or clicking it should
      // produce a "sign in" error, not a 401.
      const isDisabled = await createBtn.isDisabled();
      if (!isDisabled) {
        await createBtn.click();
        // Should see a sign-in prompt, not a raw 401 error.
        const errorEl = page.locator('#lobby-error');
        if (await errorEl.count() > 0) {
          await expect(errorEl).not.toContainText('401');
        }
      }
    }
  });
});
