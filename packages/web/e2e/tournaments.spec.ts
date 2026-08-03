/**
 * E2E tests for the Tournaments UI (read-only).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and the e2e harness running.
 */
import { test, expect } from '@playwright/test';

test.skip(!process.env['GAMBIT_E2E_BACKEND'], 'requires running backend — M14 acceptance gate');

test('tournaments page renders list or empty state', async ({ page }) => {
  await page.goto('/tournaments');

  const section = page.locator('#tournaments');
  await expect(section).toBeVisible({ timeout: 15_000 });

  const list = page.locator('#tournament-list');
  await expect(list).toBeVisible({ timeout: 15_000 });

  // Auto-waiting locator assertion that retries until either a row or empty state appears
  await expect(list.locator('.panel-row, .empty').first()).toBeVisible({ timeout: 15_000 });
});

test('nav link reaches /tournaments', async ({ page }) => {
  await page.goto('/');

  const navLink = page.locator('nav a[data-route="tournaments"]');
  await expect(navLink).toBeVisible({ timeout: 15_000 });

  await navLink.click();

  await expect(page).toHaveURL(/\/tournaments$/, { timeout: 15_000 });
  const section = page.locator('#tournaments');
  await expect(section).toBeVisible({ timeout: 15_000 });
});

test('detail page for a load failure shows the error region', async ({ page }) => {
  // The claim under test is a client one — a failed detail load surfaces a message instead of a
  // blank page — so the failure is served here rather than waited for. Routing the 404 through the
  // real harness made this depend on backend latency, which under parallel workers exceeded even a
  // 30s wait while taking ~5s in isolation. Fulfilling it keeps the assertion and drops the race.
  await page.route('**/v1/tournaments/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'not_found', message: 'tournament not found' } }),
    });
  });

  await page.goto('/tournaments/non-existent-id-0000-0000-0000');

  const section = page.locator('#tournament');
  await expect(section).toBeVisible({ timeout: 15_000 });

  const errorEl = page.locator('#tournament-error');
  await expect(errorEl).not.toBeEmpty({ timeout: 15_000 });
});
