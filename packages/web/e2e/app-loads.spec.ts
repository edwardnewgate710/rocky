/**
 * Static e2e smoke test: the Gambit app loads and the lobby is visible.
 *
 * `/` routes to the lobby view (see `bootstrap.ts`); the board only mounts
 * for `/game/{id}` routes, which is covered by the vs-bot/vs-human specs.
 *
 * This spec runs without backends (only needs vite preview).
 *
 * Run with: npm run e2e
 */
import { test, expect } from '@playwright/test';

test('app loads and lobby is visible', async ({ page }) => {
  await page.goto('/');
  const lobby = page.locator('#lobby');
  await expect(lobby).toBeVisible();
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
