/**
 * Offline navigation check — verifies SW provides offline shell.
 *
 * This spec runs without backends (only needs vite preview).
 *
 * Run with: npm run e2e
 */
import { test, expect } from '@playwright/test';

test('offline navigation falls back to cached shell', async ({ page, context }) => {
  // Load the app online so the SW caches the shell.
  await page.goto('/');
  await expect(page.locator('#lobby')).toBeVisible();

  // Go offline.
  await context.setOffline(true);

  // Navigate to a new page — should fall back to cached index.html.
  await page.goto('/game/test-offline');
  await expect(page.locator('h1')).toContainText('Gambit');

  // Restore online.
  await context.setOffline(false);
});
