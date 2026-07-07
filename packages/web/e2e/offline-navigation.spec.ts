/**
 * E2E acceptance test: offline navigation (M3 acceptance criterion).
 *
 * This spec validates that the PWA service worker correctly caches the
 * app shell so that navigation works when the network is offline:
 * 1. Load the app online (SW installs and precaches the app shell).
 * 2. Go offline.
 * 3. Navigate to a cached route — the page should load from cache.
 * 4. The board should still be visible.
 *
 * Prerequisites:
 *   - npm run build (all packages)
 *   - Web dev server or preview server running (npm run dev / npm run preview)
 *
 * Run with: npx playwright test offline-navigation
 */
import { test, expect } from '@playwright/test';

test.describe('Offline navigation — M3 acceptance', () => {
  test('app loads from cache when offline', async ({ page, context }) => {
    // 1. Load the app online — this triggers SW installation and precaching.
    await page.goto('/');
    await expect(page.locator('#board')).toBeVisible();

    // Wait for the service worker to register and activate.
    await page.waitForTimeout(2000);

    // 2. Go offline.
    await context.setOffline(true);

    // 3. Reload the page — should be served from the SW cache.
    await page.reload();

    // 4. The board should still be visible (app shell loaded from cache).
    await expect(page.locator('#board')).toBeVisible();

    // 5. Navigate to another route while offline.
    await page.goto('/profile');
    // The app should still render (SPA navigation from cache).
    // Either the profile section or the board should be present.
    const mainContent = page.locator('main, #board, #profile');
    await expect(mainContent.first()).toBeAttached();

    // 6. Restore online state.
    await context.setOffline(false);
  });

  test('service worker is registered', async ({ page }) => {
    await page.goto('/');

    // Check that a service worker is registered.
    const swRegistered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.getRegistration();
      return reg !== undefined;
    });
    expect(swRegistered).toBe(true);
  });

  test('skip link is present for keyboard navigation offline', async ({ page, context }) => {
    // Load online first to populate cache.
    await page.goto('/');
    await page.waitForTimeout(2000);

    // Go offline.
    await context.setOffline(true);
    await page.reload();

    // The skip link should still be present (part of the cached app shell).
    const skipLink = page.locator('.skip-link');
    await expect(skipLink).toBeAttached();

    await context.setOffline(false);
  });
});
