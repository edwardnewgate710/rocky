/**
 * E2E smoke test: the Gambit app loads and the board is visible.
 *
 * This is the minimal Playwright e2e test for M6 acceptance. Full
 * game-vs-bot and game-vs-human tests require running backend services
 * (API + gateway) and are documented in the M6 acceptance criteria.
 *
 * Run with: npx playwright test
 */
import { test, expect } from '@playwright/test';

test('app loads and board is visible', async ({ page }) => {
  await page.goto('/');
  // The board section should be present.
  const board = page.locator('#board');
  await expect(board).toBeVisible();
});

test('lobby is accessible via nav', async ({ page }) => {
  await page.goto('/');
  const lobbyLink = page.locator('a[href="/"]').first();
  await expect(lobbyLink).toBeVisible();
});

test('theme toggle button is present', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('#theme-toggle');
  await expect(toggle).toBeVisible();
});

test('skip link is present for keyboard users', async ({ page }) => {
  await page.goto('/');
  const skipLink = page.locator('.skip-link');
  await expect(skipLink).toBeAttached();
});
