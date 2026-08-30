/**
 * Static browser contract for the focused Create-a-Game Web V1 surface.
 *
 * The API calls needed to restore a signed-in lobby are stubbed, so this runs with Vite preview
 * only. Real seek creation and matching remain covered by seek-acceptance.spec.ts.
 */
import { expect, test, type Page } from '@playwright/test';

const SESSION = {
  user: {
    id: 'create-game-user',
    handle: 'creator',
    country: null,
    createdAt: '2026-01-01T00:00:00Z',
    roles: ['user'],
  },
  tokens: {
    accessToken: 'create-game-token',
    tokenType: 'Bearer',
    expiresIn: 900,
    refreshExpiresAt: '2030-01-01T00:00:00Z',
  },
} as const;

async function openCreateGame(page: Page): Promise<void> {
  await page.route('**/v1/auth/refresh', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSION) });
  });
  await page.route('**/v1/capabilities', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"capabilities":{}}' });
  });
  await page.route('**/v1/seeks', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      'gambit-session',
      JSON.stringify({ handle: 'creator', userId: 'create-game-user' }),
    );
  });
  await page.goto('/');
  await expect(page.locator('#create-seek')).toBeEnabled();
  await page.locator('#create-seek').click();
  await expect(page.locator('#create-game-form')).toBeVisible();
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'narrow', width: 420, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small mobile', width: 320, height: 640 },
] as const) {
  test(`create-game V1 stays focused and within ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCreateGame(page);
    const createForm = page.locator('#create-game-form');

    await expect(createForm.locator('input[name="cg-time"]')).toHaveCount(4);
    await expect(createForm.locator('input[name="cg-mode"]')).toHaveCount(2);
    await expect(createForm.locator('input[name="cg-color"]')).toHaveCount(0);
    await expect(createForm.locator('.cg-more-toggle')).toHaveCount(0);
    await expect(createForm.locator('select')).toHaveCount(0);
    await expect(createForm.locator('.cg-submit')).toHaveText('Create seek');

    expect(await createForm.locator('input[name="cg-time"]').evaluateAll((radios) =>
      radios.map((radio) => (radio as HTMLInputElement).value),
    )).toEqual(['3+0', '5+0', '10+0', '15+10']);
    expect(await createForm.locator('input[name="cg-mode"]').evaluateAll((radios) =>
      radios.map((radio) => (radio as HTMLInputElement).value),
    )).toEqual(['casual', 'rated']);

    expect(await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))).toEqual({ documentWidth: viewport.width, viewportWidth: viewport.width });

    const form = await page.locator('#create-game-form').boundingBox();
    if (form === null) throw new Error('create-game form has no rendered bounds');
    expect(form.x).toBeGreaterThanOrEqual(0);
    expect(form.x + form.width).toBeLessThanOrEqual(viewport.width);
  });
}

test('create-game radios keep native keyboard selection and a visible focus ring', async ({ page }) => {
  await openCreateGame(page);

  const selected = page.locator('input[name="cg-time"]:checked');
  await expect(selected).toHaveValue('10+0');
  await page.keyboard.press('ArrowRight');
  await expect(selected).toHaveValue('15+10');

  const outline = await page.locator('#create-game-form .cg-chip:has(input[value="15+10"])').evaluate((label) => {
    const style = getComputedStyle(label);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(3);
});

test('create-game V1 mirrors under RTL without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('dir', 'rtl'));
  });
  await openCreateGame(page);

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);

  const first = await page.locator('#create-game-form .cg-chip:has(input[value="3+0"])').boundingBox();
  const second = await page.locator('#create-game-form .cg-chip:has(input[value="5+0"])').boundingBox();
  if (first === null || second === null) throw new Error('time controls have no rendered bounds');
  expect(first.x).toBeGreaterThan(second.x);
});

test('coarse pointers get 44px create-game targets', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openCreateGame(page);
    const createForm = page.locator('#create-game-form');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    for (const selector of ['.cg-chip', '.cg-seg', '.cg-submit', '.cg-cancel']) {
      const heights = await createForm.locator(selector).evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().height),
      );
      expect(heights.length, selector).toBeGreaterThan(0);
      for (const height of heights) expect(height, selector).toBeGreaterThanOrEqual(44);
    }
  } finally {
    await context.close();
  }
});
