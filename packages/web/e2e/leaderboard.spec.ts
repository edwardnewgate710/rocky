import { test, expect } from '@playwright/test';

test.describe('Leaderboard view', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 600 });

    await page.route('**/v1/capabilities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          capabilities: {
            learning: true,
            studies: true,
            achievements: true,
            search: true,
            social: true,
            messaging: true,
            community: true,
          },
        }),
      });
    });

    await page.route('**/v1/seeks', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.route('**/v1/leaderboard/standard?limit=100', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          { userId: 'u1', variant: 'standard', rating: 1600, rd: 45 },
          { userId: 'u2', variant: 'standard', rating: 1550, rd: 50 },
        ]),
      });
    });

    await page.route('**/v1/leaderboard/atomic?limit=100', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.route('**/v1/leaderboard/crazyhouse?limit=100', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Internal Server Error' }),
      });
    });

    await page.route('**/graphql', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            p0: { id: 'u1', handle: 'alice' },
            p1: null,
          },
        }),
      });
    });
  });

  test('navigation loads standard standings within a narrow viewport', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav a[data-route="leaderboard"]').click();
    await expect(page).toHaveURL(/\/leaderboard$/);

    // Selector defaults to standard
    const select = page.locator('#leaderboard-variant-select');
    await expect(select).toHaveValue('standard');

    // Every offered variant is listed, Chess960 among them since ADR-0137 made it creatable and so
    // gave it ratings to rank. The selector renders `OFFERED_VARIANTS` rather than a list of its own,
    // which is what this asserts — it used to pin Chess960's absence (ADR-0099), a decision that was
    // never this page's to make.
    const options = await select.locator('option').allInnerTexts();
    expect(options).toContain('Standard');
    expect(options).toContain('Chess960');
    expect(options).toContain('Atomic');

    // Wait for results to render
    const results = page.locator('#leaderboard-results');
    await expect(results).toHaveAttribute('role', 'list');

    // Loading status should be outside the list and hidden when done
    const loading = page.locator('#leaderboard-loading');
    await expect(loading).toBeHidden();

    // Check rows
    const rows = results.locator('.panel-row');
    await expect(rows).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      await expect(rows.nth(i)).toHaveAttribute('role', 'listitem');
      // Must have exactly two children: row-main and count
      await expect(rows.nth(i).locator('xpath=./*')).toHaveCount(2);
    }

    // Check first row content
    const row1 = rows.nth(0);
    await expect(row1.locator('.leaderboard-rank')).toHaveText('#1');
    const link = row1.locator('a.row-link');
    await expect(link).toHaveText('alice');
    await expect(link).toHaveAttribute('href', '/profile/alice');
    await expect(row1.locator('.count')).toContainText('1600 (±45)');

    // Check second row fallback
    const row2 = rows.nth(1);
    await expect(row2.locator('.leaderboard-rank')).toHaveText('#2');
    await expect(row2.locator('.leaderboard-player-unresolved')).toHaveText('u2');
    await expect(row2.locator('.count')).toContainText('1550 (±50)');

    const sectionBox = await page.locator('#leaderboard').boundingBox();
    expect(sectionBox).not.toBeNull();
    expect(sectionBox!.x).toBeGreaterThanOrEqual(0);
    expect(sectionBox!.x + sectionBox!.width).toBeLessThanOrEqual(320);
  });

  test('loading is announced outside the standings list', async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/v1/leaderboard/standard?limit=100', async (route) => {
      await gate;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/leaderboard');
    const loading = page.locator('#leaderboard-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveText('Loading…');
    await expect(page.locator('#leaderboard-results .panel-row')).toHaveCount(0);

    release();
    await expect(loading).toBeHidden();
    await expect(page.locator('#leaderboard-results')).toHaveAttribute('role', 'status');
  });

  test('in-place variant switch to empty state', async ({ page }) => {
    await page.goto('/leaderboard');
    await expect(page.locator('#leaderboard-results .panel-row')).toHaveCount(2);

    const select = page.locator('#leaderboard-variant-select');
    await select.selectOption('atomic');

    // URL should NOT change to /leaderboard/atomic
    await expect(page).toHaveURL(/\/leaderboard$/);

    const results = page.locator('#leaderboard-results');
    await expect(results).toHaveAttribute('role', 'status');
    await expect(results).toContainText('No leaderboard entries');
  });

  test('error state handling', async ({ page }) => {
    await page.goto('/leaderboard');
    const select = page.locator('#leaderboard-variant-select');
    await select.selectOption('crazyhouse');

    const error = page.locator('#leaderboard-error');
    await expect(error).toBeVisible();
  });
});
