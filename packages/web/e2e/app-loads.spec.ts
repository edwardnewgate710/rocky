/**
 * Static e2e smoke test: the Gambit app loads and the board is visible.
 *
 * This spec runs without backends (only needs vite preview).
 *
 * Run with: npm run e2e
 */
import { test, expect } from '@playwright/test';

test('app loads and board is visible', async ({ page }) => {
  await page.goto('/');
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

test('auth form is present for sign-in', async ({ page }) => {
  await page.goto('/');
  const authForm = page.locator('#auth-form');
  await expect(authForm).toBeVisible();
});

test('auth status shows not signed in initially', async ({ page }) => {
  await page.goto('/');
  const status = page.locator('#auth-status');
  await expect(status).toContainText('Not signed in');
});
