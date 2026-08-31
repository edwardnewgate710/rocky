/**
 * Static browser contract for the focused Create-a-Game Web V3 surface.
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

/** Open the form in an authenticated, API-isolated Vite-preview page. */
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
  test(`create-game V3 stays focused and within ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCreateGame(page);
    const createForm = page.locator('#create-game-form');

    await expect(createForm.locator('input[name="cg-time"]')).toHaveCount(11);
    await expect(createForm.locator('input[name="cg-mode"]')).toHaveCount(2);
    await expect(createForm.locator('input[name="cg-variant"]')).toHaveCount(8);
    await expect(createForm.locator('input[name="cg-color"]')).toHaveCount(3);
    await expect(createForm.locator('.cg-more-toggle')).toHaveCount(0);
    await expect(createForm.locator('select')).toHaveCount(0);
    await expect(createForm.locator('.cg-submit')).toHaveText('Create seek');

    expect(await createForm.locator('input[name="cg-time"]').evaluateAll((radios) =>
      radios.map((radio) => (radio as HTMLInputElement).value),
    )).toEqual(['1+0', '2+1', '3+0', '3+2', '5+0', '5+3', '10+0', '10+5', '15+10', '30+20', 'custom']);
    expect(await createForm.locator('input[name="cg-mode"]').evaluateAll((radios) =>
      radios.map((radio) => (radio as HTMLInputElement).value),
    )).toEqual(['casual', 'rated']);
    expect(await createForm.locator('input[name="cg-variant"]').evaluateAll((radios) =>
      radios.map((radio) => (radio as HTMLInputElement).value),
    )).toEqual([
      'standard', 'chess960', 'kingofthehill', 'atomic',
      'crazyhouse', 'threecheck', 'horde', 'racingkings',
    ]);
    expect(await createForm.locator('input[name="cg-color"]').evaluateAll((radios) =>
      radios.map((radio) => (radio as HTMLInputElement).value),
    )).toEqual(['random', 'white', 'black']);

    for (const label of ['King of the Hill', 'Racing Kings']) {
      const fits = await createForm.getByText(label, { exact: true }).evaluate((element) =>
        element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
      );
      expect(fits, `${label} at ${viewport.width}px`).toBe(true);
    }

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
  await expect(selected).toHaveValue('10+5');

  const outline = await page.locator('#create-game-form .cg-chip:has(input[value="10+5"])').evaluate((label) => {
    const style = getComputedStyle(label);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(3);

  const variant = page.locator('input[name="cg-variant"]:checked');
  await variant.focus();
  await page.keyboard.press('ArrowRight');
  await expect(variant).toHaveValue('chess960');

  const color = page.locator('input[name="cg-color"]:checked');
  await color.focus();
  await page.keyboard.press('ArrowRight');
  await expect(color).toHaveValue('white');
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 320, height: 640 },
] as const) {
  test(`create-game V3 mirrors under ${viewport.name} RTL without overflow while notation stays LTR`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('dir', 'rtl'));
    });
    await openCreateGame(page);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);

    const first = await page.locator('#create-game-form .cg-chip:has(input[value="1+0"])').boundingBox();
    const second = await page.locator('#create-game-form .cg-chip:has(input[value="2+1"])').boundingBox();
    if (first === null || second === null) throw new Error('time controls have no rendered bounds');
    expect(first.x).toBeGreaterThan(second.x);
    await expect(page.locator('#create-game-form .cg-chip:has(input[value="1+0"]) .cg-chip-label')).toHaveAttribute('dir', 'ltr');

    const random = await page.locator('#create-game-form .cg-seg:has(input[value="random"])').boundingBox();
    const white = await page.locator('#create-game-form .cg-seg:has(input[value="white"])').boundingBox();
    if (random === null || white === null) throw new Error('color controls have no rendered bounds');
    expect(random.x).toBeGreaterThan(white.x);
  });
}

test('default Standard and Random reach the exact seek payload', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await expect(form.locator('input[name="cg-variant"]:checked')).toHaveValue('standard');
  await expect(form.locator('input[name="cg-color"]:checked')).toHaveValue('random');

  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/v1/seeks'),
  );
  await form.locator('.cg-submit').click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toEqual({
    variant: 'standard',
    color: 'random',
    timeControl: { initialMs: 600_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
  });
});

test('Atomic and Black reach the exact existing seek payload', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await form.locator('.cg-chip:has(input[name="cg-time"][value="5+3"])').click();
  await form.locator('.cg-chip:has(input[name="cg-variant"][value="atomic"])').click();
  await form.locator('.cg-seg:has(input[name="cg-color"][value="black"])').click();
  await form.locator('.cg-seg:has(input[name="cg-mode"][value="rated"])').click();

  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/v1/seeks'),
  );
  await form.locator('.cg-submit').click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toEqual({
    variant: 'atomic',
    color: 'black',
    timeControl: { initialMs: 300_000, incrementMs: 3_000, delayMs: 0, kind: 'increment' },
    rated: true,
  });
});

test('Custom validates before request and preserves exact integer-millisecond payload', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const presetHeight = await form.evaluate((element) => element.getBoundingClientRect().height);
  await form.locator('.cg-chip:has(input[value="custom"])').click();
  await expect(form.locator('#cg-minutes')).toBeFocused();
  const customHeight = await form.evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.abs(customHeight - presetHeight)).toBeLessThanOrEqual(2);

  await form.locator('#cg-minutes').fill('0');
  await form.locator('.cg-submit').click();
  await expect(form.locator('#cg-minutes')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('.cg-field-error')).toHaveText(
    'Minutes must be between 0.5 and 180 in 0.5-minute steps.',
  );

  await form.locator('#cg-minutes').fill('5');
  await form.locator('#cg-increment').fill('');
  await form.locator('.cg-submit').click();
  await expect(form.locator('#cg-increment')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('.cg-field-error')).toHaveText(
    'Increment must be a whole number between 0 and 60 seconds.',
  );

  await form.locator('#cg-minutes').fill('7.5');
  await expect(form.locator('#cg-increment')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('.cg-field-error')).toHaveText(
    'Increment must be a whole number between 0 and 60 seconds.',
  );
  await form.locator('.cg-chip:has(input[name="cg-variant"][value="atomic"])').click();
  await expect(form.locator('#cg-increment')).toHaveAttribute('aria-invalid', 'true');
  await form.locator('.cg-seg:has(input[name="cg-color"][value="black"])').click();
  await expect(form.locator('#cg-increment')).toHaveAttribute('aria-invalid', 'true');
  await form.locator('#cg-increment').fill('4');
  await expect(form.locator('#cg-increment')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('.cg-field-error')).toBeHidden();
  await form.locator('.cg-seg:has(input[value="rated"])').click();
  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/v1/seeks'),
  );
  await form.locator('.cg-submit').click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toEqual({
    variant: 'atomic',
    color: 'black',
    timeControl: { initialMs: 450_000, incrementMs: 4_000, delayMs: 0, kind: 'increment' },
    rated: true,
  });
});

test('coarse pointers get 44px create-game targets', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openCreateGame(page);
    const createForm = page.locator('#create-game-form');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    await createForm.locator('.cg-chip:has(input[value="custom"])').click();
    for (const selector of ['.cg-chip', '.cg-seg', '.cg-num input', '.cg-submit', '.cg-cancel']) {
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
