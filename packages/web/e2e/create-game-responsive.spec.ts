/**
 * Static browser contract for the focused Create-a-Game Web V4 surface.
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
async function openCreateGame(page: Page, prefs: Record<string, unknown> | null = null): Promise<void> {
  await page.route('**/v1/auth/refresh', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSION) });
  });
  await page.route('**/v1/capabilities', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"capabilities":{}}' });
  });
  await page.route('**/v1/seeks', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript((storedPrefs) => {
    localStorage.setItem(
      'gambit-session',
      JSON.stringify({ handle: 'creator', userId: 'create-game-user' }),
    );
    if (storedPrefs !== null) {
      localStorage.setItem('gambit-create-game', JSON.stringify(storedPrefs));
    }
  }, prefs);
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
  test(`create-game V4 stays focused and within ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCreateGame(page);
    const createForm = page.locator('#create-game-form');

    await expect(createForm.locator('input[name="cg-time"]')).toHaveCount(11);
    await expect(createForm.locator('input[name="cg-mode"]')).toHaveCount(2);
    await expect(createForm.locator('input[name="cg-variant"]')).toHaveCount(8);
    await expect(createForm.locator('input[name="cg-color"]')).toHaveCount(3);
    await expect(createForm.locator('#cg-min-rating')).toHaveAttribute('inputmode', 'numeric');
    await expect(createForm.locator('#cg-max-rating')).toHaveAttribute('inputmode', 'numeric');
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
  test(`create-game V4 mirrors under ${viewport.name} RTL without overflow while numbers stay LTR`, async ({ page }) => {
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
    await expect(page.locator('#cg-min-rating')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('#cg-max-rating')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('label:has(#cg-min-rating)')).toContainText('Minimum');
    await expect(page.locator('label:has(#cg-max-rating)')).toContainText('Maximum');
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
    minRating: null,
    maxRating: null,
  });
});

test('Atomic and Black reach the exact existing seek payload', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await form.locator('.cg-chip:has(input[name="cg-time"][value="5+3"])').click();
  await form.locator('.cg-chip:has(input[name="cg-variant"][value="atomic"])').click();
  await form.locator('.cg-seg:has(input[name="cg-color"][value="black"])').click();
  await form.locator('.cg-seg:has(input[name="cg-mode"][value="rated"])').click();
  await form.locator('#cg-min-rating').fill('1500');
  await form.locator('#cg-max-rating').fill('1800');

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
    minRating: 1500,
    maxRating: 1800,
  });
});

test('optional rating combinations and exact endpoints preserve the complete seek payload', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const cases = [
    { min: '1500', max: '', expectedMin: 1500, expectedMax: null },
    { min: '', max: '1800', expectedMin: null, expectedMax: 1800 },
    { min: '0', max: '4000', expectedMin: 0, expectedMax: 4000 },
  ] as const;

  for (const ratingCase of cases) {
    await form.locator('.cg-chip:has(input[name="cg-time"][value="2+1"])').click();
    await form.locator('.cg-chip:has(input[name="cg-variant"][value="horde"])').click();
    await form.locator('.cg-seg:has(input[name="cg-color"][value="white"])').click();
    await form.locator('.cg-seg:has(input[name="cg-mode"][value="rated"])').click();
    await form.locator('#cg-min-rating').fill(ratingCase.min);
    await form.locator('#cg-max-rating').fill(ratingCase.max);
    const requestPromise = page.waitForRequest(
      (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/v1/seeks'),
    );
    await form.locator('.cg-submit').click();
    const request = await requestPromise;
    expect(request.postDataJSON()).toEqual({
      variant: 'horde',
      color: 'white',
      timeControl: { initialMs: 120_000, incrementMs: 1_000, delayMs: 0, kind: 'increment' },
      rated: true,
      minRating: ratingCase.expectedMin,
      maxRating: ratingCase.expectedMax,
    });
    await expect(page.locator('#create-seek')).toBeVisible();
    if (ratingCase !== cases.at(-1)) await page.locator('#create-seek').click();
  }
});

test('rating validation blocks malformed ranges and survives unrelated choice changes', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  let postCount = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/v1/seeks')) postCount++;
  });

  await form.locator('#cg-min-rating').fill('1800');
  await form.locator('#cg-max-rating').fill('1500');
  await form.locator('.cg-submit').click();
  await expect(form.locator('#cg-min-rating')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#cg-rating-error')).toHaveText('Minimum rating must not exceed maximum rating.');
  expect(postCount).toBe(0);

  await form.locator('.cg-chip:has(input[name="cg-variant"][value="atomic"])').click();
  await form.locator('.cg-seg:has(input[name="cg-color"][value="black"])').click();
  await form.locator('.cg-seg:has(input[name="cg-mode"][value="rated"])').click();
  await form.locator('.cg-chip:has(input[name="cg-time"][value="5+3"])').click();
  await expect(form.locator('#cg-min-rating')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#cg-rating-error')).toBeVisible();

  await form.locator('#cg-min-rating').fill('1500');
  await expect(form.locator('#cg-rating-error')).toBeHidden();
  for (const value of ['-1', '4001', '1.5', '1e3', 'rating']) {
    await form.locator('#cg-max-rating').fill(value);
    await form.locator('.cg-submit').click();
    await expect(form.locator('#cg-max-rating')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.locator('#cg-rating-error')).toHaveText('Enter a whole rating from 0 to 4000.');
    expect(postCount, value).toBe(0);
  }
});

test('rating and custom-time validation coexist without clearing each other', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await form.locator('.cg-chip:has(input[value="custom"])').click();
  await form.locator('#cg-increment').fill('');
  await form.locator('#cg-min-rating').fill('-1');
  await page.evaluate(() => {
    const validationFocusOrder: string[] = [];
    for (const id of ['cg-increment', 'cg-min-rating']) {
      document.querySelector(`#${id}`)?.addEventListener('focus', () => validationFocusOrder.push(id));
    }
    (window as Window & { validationFocusOrder?: string[] }).validationFocusOrder = validationFocusOrder;
  });
  await form.locator('.cg-submit').click();
  await expect(form.locator('#cg-custom-error')).toBeVisible();
  await expect(form.locator('#cg-rating-error')).toBeVisible();
  await expect(form.locator('#cg-increment')).toBeFocused();
  expect(
    await page.evaluate(
      () => (window as Window & { validationFocusOrder?: string[] }).validationFocusOrder,
    ),
  ).toEqual(['cg-increment']);

  await form.locator('#cg-min-rating').fill('1500');
  await expect(form.locator('#cg-rating-error')).toBeHidden();
  await expect(form.locator('#cg-custom-error')).toBeVisible();
  await form.locator('#cg-increment').fill('4');
  await expect(form.locator('#cg-custom-error')).toBeHidden();
});

test('V3 restores unrestricted while V4 restores an exact rating range', async ({ browser }) => {
  const v3Context = await browser.newContext();
  const v4Context = await browser.newContext();
  try {
    const v3Page = await v3Context.newPage();
    await openCreateGame(v3Page, {
      time: '5+3', mode: 'rated', variant: 'atomic', color: 'black',
    });
    await expect(v3Page.locator('#cg-min-rating')).toHaveValue('');
    await expect(v3Page.locator('#cg-max-rating')).toHaveValue('');

    const v4Page = await v4Context.newPage();
    await openCreateGame(v4Page, {
      time: '5+3', mode: 'rated', variant: 'atomic', color: 'black',
      minRating: 1500, maxRating: 1800,
    });
    await expect(v4Page.locator('#cg-min-rating')).toHaveValue('1500');
    await expect(v4Page.locator('#cg-max-rating')).toHaveValue('1800');
  } finally {
    await v3Context.close();
    await v4Context.close();
  }
});

test('failed seek preserves the range but does not persist attempted V4 preferences', async ({ page }) => {
  await openCreateGame(page);
  await page.unroute('**/v1/seeks');
  await page.route('**/v1/seeks', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
  });
  const form = page.locator('#create-game-form');
  await form.locator('#cg-min-rating').fill('1500');
  await form.locator('#cg-max-rating').fill('1800');
  await form.locator('.cg-submit').click();
  await expect(page.locator('#lobby-error')).not.toHaveText('');
  await expect(form.locator('#cg-min-rating')).toHaveValue('1500');
  await expect(form.locator('#cg-max-rating')).toHaveValue('1800');
  expect(await page.evaluate(() => localStorage.getItem('gambit-create-game'))).toBeNull();
});

test('pending creation disables both rating controls', async ({ page }) => {
  await openCreateGame(page);
  await page.unroute('**/v1/seeks');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/v1/seeks', async (route) => {
    if (route.request().method() === 'POST') await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  const form = page.locator('#create-game-form');
  await form.locator('#cg-min-rating').fill('1500');
  await form.locator('#cg-max-rating').fill('1800');
  await form.locator('.cg-submit').click();
  await expect(form).toHaveAttribute('aria-busy', 'true');
  await expect(form.locator('#cg-min-rating')).toBeDisabled();
  await expect(form.locator('#cg-max-rating')).toBeDisabled();
  await expect(form.locator('.cg-submit')).toBeDisabled();
  release();
  await expect(page.locator('#create-seek')).toBeVisible();
});

test('rating bounds support keyboard-only entry and submission', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  for (let index = 0; index < 40 && !(await form.locator('#cg-min-rating').evaluate((input) => input === document.activeElement)); index++) {
    await page.keyboard.press('Tab');
  }
  await expect(form.locator('#cg-min-rating')).toBeFocused();
  await page.keyboard.type('1500');
  await page.keyboard.press('Tab');
  await expect(form.locator('#cg-max-rating')).toBeFocused();
  await page.keyboard.type('1800');
  for (let index = 0; index < 10 && !(await form.locator('.cg-submit').evaluate((button) => button === document.activeElement)); index++) {
    await page.keyboard.press('Tab');
  }
  await expect(form.locator('.cg-submit')).toBeFocused();
  const requestPromise = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/v1/seeks'),
  );
  await page.keyboard.press('Enter');
  expect((await requestPromise).postDataJSON()).toMatchObject({ minRating: 1500, maxRating: 1800 });
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
  await expect(form.locator('#cg-custom-error')).toHaveText(
    'Minutes must be between 0.5 and 180 in 0.5-minute steps.',
  );

  await form.locator('#cg-minutes').fill('5');
  await form.locator('#cg-increment').fill('');
  await form.locator('.cg-submit').click();
  await expect(form.locator('#cg-increment')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#cg-custom-error')).toHaveText(
    'Increment must be a whole number between 0 and 60 seconds.',
  );

  await form.locator('#cg-minutes').fill('7.5');
  await expect(form.locator('#cg-increment')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#cg-custom-error')).toHaveText(
    'Increment must be a whole number between 0 and 60 seconds.',
  );
  await form.locator('.cg-chip:has(input[name="cg-variant"][value="atomic"])').click();
  await expect(form.locator('#cg-increment')).toHaveAttribute('aria-invalid', 'true');
  await form.locator('.cg-seg:has(input[name="cg-color"][value="black"])').click();
  await expect(form.locator('#cg-increment')).toHaveAttribute('aria-invalid', 'true');
  await form.locator('#cg-increment').fill('4');
  await expect(form.locator('#cg-increment')).not.toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#cg-custom-error')).toBeHidden();
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
    minRating: null,
    maxRating: null,
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
