/**
 * Static browser contract for the focused Create-a-Game Web surface.
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

/**
 * Assert the page does not scroll sideways.
 *
 * Comparing `scrollWidth` to the viewport width is a near-enough proxy only
 * while no classic scrollbar is present — one narrows the viewport, and the
 * equality then fails on a page that never overflowed. Measuring the root
 * against its own client width states the invariant the test is actually about.
 */
async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow, `horizontal overflow ${label}`).toBeLessThanOrEqual(1);
}

/**
 * Reveal the advanced controls. Idempotent, because restored advanced
 * preferences open the section on their own.
 */
async function openAdvanced(page: Page): Promise<void> {
  const toggle = page.locator('.cg-more-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(page.locator('#cg-more-options')).toBeVisible();
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

    await expect(createForm.locator('input[name="cg-time"]')).toHaveCount(12);
    await expect(createForm.locator('input[name="cg-mode"]')).toHaveCount(2);
    await expect(createForm.locator('input[name="cg-variant"]')).toHaveCount(8);
    await expect(createForm.locator('input[name="cg-color"]')).toHaveCount(3);
    await expect(createForm.locator('#cg-min-rating')).toHaveAttribute('inputmode', 'numeric');
    await expect(createForm.locator('#cg-max-rating')).toHaveAttribute('inputmode', 'numeric');
    await expect(createForm.locator('.cg-more-toggle')).toHaveCount(1);
    await expect(createForm.locator('#cg-more-options')).toBeHidden();
    await expect(createForm.locator('select')).toHaveCount(0);
    await openAdvanced(page);
    await expect(createForm.locator('.cg-submit')).toHaveText('Create seek');

    expect(await createForm.locator('input[name="cg-time"]').evaluateAll((radios) =>
      radios.map((radio) => (radio as HTMLInputElement).value),
    )).toEqual([
      '1+0', '2+1', '3+0', '3+2', '5+0', '5+3',
      '10+0', '10+5', '15+10', '30+20', 'unlimited', 'custom',
    ]);
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

  // Opening the section here rather than up front: clicking the toggle takes
  // focus, which would defeat the time-group assertions above.
  await openAdvanced(page);
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
  await openAdvanced(page);
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
  await openAdvanced(page);
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
  await openAdvanced(page);
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
  await openAdvanced(page);
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
  await openAdvanced(page);
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
  await openAdvanced(page);
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
  await openAdvanced(page);
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
  await openAdvanced(page);
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

// ── Unlimited ────────────────────────────────────────────────────────

/** The one wire shape `parseTimeControl` accepts for an untimed seek. */
const UNLIMITED_WIRE = { initialMs: 0, incrementMs: 0, delayMs: 0, kind: 'unlimited' } as const;

const UNLIMITED_SUMMARY = 'Correspondence — no clock, so neither side can run out of time.';

const unlimitedChip = '.cg-chip:has(input[name="cg-time"][value="unlimited"])';

/** Resolve once the panel has posted a seek, so the body can be asserted exactly. */
function seekRequest(page: Page): Promise<import('@playwright/test').Request> {
  return page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/v1/seeks'),
  );
}

test('Unlimited is offered among the time controls with a readable name', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');

  await expect(form.locator(unlimitedChip)).toHaveCount(1);
  await expect(form.locator(`${unlimitedChip} .cg-chip-label`)).toHaveText('Unlimited');
  await expect(form.locator(`${unlimitedChip} .cg-chip-speed`)).toHaveText('Correspondence');
  // No infinity glyph anywhere in the group: the word is the whole affordance.
  expect(await form.locator('.cg-presets').innerText()).not.toContain('∞');
});

test('selecting Unlimited exposes the selection and describes it in the live region', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const summary = form.locator('.cg-time-summary');
  await expect(summary).toHaveText('Rapid — 10 minutes per side, no increment.');

  await form.locator(unlimitedChip).click();

  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveText(UNLIMITED_SUMMARY);
  await expect(summary).toHaveAttribute('aria-live', 'polite');
  await expect(form.locator('.cg-custom')).toBeHidden();
});

test('Unlimited is reachable and selectable by keyboard alone, with a visible focus ring', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await form.locator('input[name="cg-time"]:checked').focus();
  // 10+0 → 10+5 → 15+10 → 30+20 → unlimited, in DOM order within the group.
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');

  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  await expect(form.locator('.cg-time-summary')).toHaveText(UNLIMITED_SUMMARY);

  const outline = await form.locator(unlimitedChip).evaluate((label) => {
    const style = getComputedStyle(label);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(3);
});

test('Unlimited with Random and Casual reaches the exact zero-duration payload', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await form.locator(unlimitedChip).click();

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await request).postDataJSON()).toEqual({
    variant: 'standard',
    color: 'random',
    timeControl: UNLIMITED_WIRE,
    rated: false,
    minRating: null,
    maxRating: null,
  });
});

for (const color of ['white', 'black'] as const) {
  test(`Unlimited with ${color} carries the color and no clock durations`, async ({ page }) => {
    await openCreateGame(page);
    const form = page.locator('#create-game-form');
    await form.locator(unlimitedChip).click();
    await form.locator(`.cg-seg:has(input[name="cg-color"][value="${color}"])`).click();

    const request = seekRequest(page);
    await form.locator('.cg-submit').click();
    expect((await request).postDataJSON()).toEqual({
      variant: 'standard',
      color,
      timeControl: UNLIMITED_WIRE,
      rated: false,
      minRating: null,
      maxRating: null,
    });
  });
}

/**
 * Rated and Unlimited are both permitted: nothing in `POST /v1/seeks` or in the
 * acceptance path couples `rated` to a speed bucket, and an untimed game simply
 * classifies as correspondence.
 */
test('Unlimited is offered as Rated as well as Casual, and both reach the request', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await form.locator(unlimitedChip).click();
  await expect(form.locator('.cg-seg:has(input[name="cg-mode"][value="rated"]) input')).toBeEnabled();
  await form.locator('.cg-seg:has(input[name="cg-mode"][value="rated"])').click();

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await request).postDataJSON()).toEqual({
    variant: 'standard',
    color: 'random',
    timeControl: UNLIMITED_WIRE,
    rated: true,
    minRating: null,
    maxRating: null,
  });
});

test('Unlimited with a non-standard variant keeps both choices in the request', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator('.cg-chip:has(input[name="cg-variant"][value="crazyhouse"])').click();
  await form.locator(unlimitedChip).click();

  await expect(form.locator('input[name="cg-variant"]:checked')).toHaveValue('crazyhouse');
  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await request).postDataJSON()).toEqual({
    variant: 'crazyhouse',
    color: 'random',
    timeControl: UNLIMITED_WIRE,
    rated: false,
    minRating: null,
    maxRating: null,
  });
});

test('every rating-bound combination survives an Unlimited seek unchanged', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator(unlimitedChip).click();

  for (const [minimum, maximum, expected] of [
    ['', '', { minRating: null, maxRating: null }],
    ['1200', '', { minRating: 1200, maxRating: null }],
    ['', '2200', { minRating: null, maxRating: 2200 }],
    ['1500', '1800', { minRating: 1500, maxRating: 1800 }],
    ['1600', '1600', { minRating: 1600, maxRating: 1600 }],
    ['0', '4000', { minRating: 0, maxRating: 4000 }],
  ] as const) {
    // Reopening derives the disclosure from the live values, so an unrestricted
    // round leaves it closed for the next one.
    await openAdvanced(page);
    await form.locator('#cg-min-rating').fill(minimum);
    await form.locator('#cg-max-rating').fill(maximum);
    const request = seekRequest(page);
    await form.locator('.cg-submit').click();
    expect((await request).postDataJSON(), `${minimum}-${maximum}`).toEqual({
      variant: 'standard',
      color: 'random',
      timeControl: UNLIMITED_WIRE,
      rated: false,
      ...expected,
    });
    // Success collapses the panel; reopen for the next combination.
    await page.locator('#create-seek').click();
    await expect(form).toBeVisible();
  }
});

test('a rating range error blocks an Unlimited seek without becoming a clock error', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator(unlimitedChip).click();
  await form.locator('#cg-min-rating').fill('1800');
  await form.locator('#cg-max-rating').fill('1500');

  await form.locator('.cg-submit').click();
  await expect(form.locator('#cg-rating-error')).toHaveText('Minimum rating must not exceed maximum rating.');
  await expect(form.locator('#cg-min-rating')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#cg-custom-error')).toBeHidden();
  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  await expect(form).toBeVisible();
});

test('a timed preset and Unlimited replace each other cleanly in both directions', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const summary = form.locator('.cg-time-summary');

  await form.locator('.cg-chip:has(input[name="cg-time"][value="5+3"])').click();
  await expect(summary).toHaveText('Blitz — 5 minutes per side, 3 second increment.');

  await form.locator(unlimitedChip).click();
  await expect(summary).toHaveText(UNLIMITED_SUMMARY);
  await expect(form.locator('input[name="cg-time"]:checked')).toHaveCount(1);

  await form.locator('.cg-chip:has(input[name="cg-time"][value="30+20"])').click();
  await expect(summary).toHaveText('Classical — 30 minutes per side, 20 second increment.');

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await request).postDataJSON().timeControl).toEqual({
    initialMs: 1_800_000, incrementMs: 20_000, delayMs: 0, kind: 'increment',
  });
});

test('Custom values survive a detour through Unlimited and still reach the request', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');

  await form.locator('.cg-chip:has(input[value="custom"])').click();
  await form.locator('#cg-minutes').fill('12');
  await form.locator('#cg-increment').fill('3');

  await form.locator(unlimitedChip).click();
  await expect(form.locator('.cg-custom')).toBeHidden();
  await expect(form.locator('#cg-minutes')).toHaveValue('12');
  await expect(form.locator('#cg-increment')).toHaveValue('3');

  await form.locator('.cg-chip:has(input[value="custom"])').click();
  await expect(form.locator('.cg-custom')).toBeVisible();
  await expect(form.locator('#cg-minutes')).toHaveValue('12');
  await expect(form.locator('#cg-increment')).toHaveValue('3');

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await request).postDataJSON().timeControl).toEqual({
    initialMs: 720_000, incrementMs: 3_000, delayMs: 0, kind: 'increment',
  });
});

test('invalid Custom values left behind neither block nor reach an Unlimited seek', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');

  await form.locator('.cg-chip:has(input[value="custom"])').click();
  await form.locator('#cg-minutes').fill('0');
  await form.locator('.cg-submit').click();
  await expect(form.locator('#cg-minutes')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#cg-custom-error')).toBeVisible();

  await form.locator(unlimitedChip).click();
  await expect(form.locator('#cg-custom-error')).toBeHidden();
  await expect(form.locator('#cg-minutes')).not.toHaveAttribute('aria-invalid', 'true');

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  // The stale "0" is nowhere in the body.
  expect((await request).postDataJSON()).toEqual({
    variant: 'standard',
    color: 'random',
    timeControl: UNLIMITED_WIRE,
    rated: false,
    minRating: null,
    maxRating: null,
  });
});

test('a pending Unlimited create disables every control and admits one request', async ({ page }) => {
  await openCreateGame(page);
  await page.unroute('**/v1/seeks');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posted: string[] = [];
  await page.route('**/v1/seeks', async (route) => {
    if (route.request().method() === 'POST') {
      posted.push(route.request().postData() ?? '');
      await gate;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'unlimited-seek' }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  const form = page.locator('#create-game-form');
  await form.locator(unlimitedChip).click();
  await form.locator('.cg-submit').click();

  await expect(form).toHaveAttribute('aria-busy', 'true');
  await expect(form.locator(`${unlimitedChip} input`)).toBeDisabled();
  await expect(form.locator('.cg-submit')).toBeDisabled();
  await expect(form.locator('.cg-cancel')).toBeDisabled();
  await expect(form.locator('#cg-min-rating')).toBeDisabled();
  await expect(form.locator('#cg-max-rating')).toBeDisabled();
  for (const group of ['cg-time', 'cg-variant', 'cg-mode', 'cg-color']) {
    const enabled = await form.locator(`input[name="${group}"]`).evaluateAll((inputs) =>
      inputs.filter((input) => !(input as HTMLInputElement).disabled).length,
    );
    expect(enabled, group).toBe(0);
  }

  // Submit the form directly, bypassing the disabled button, so the guard in the
  // handler itself is what has to stop the second request.
  await form.evaluate((element) => (element as HTMLFormElement).requestSubmit());
  release();
  await expect(form).toHaveAttribute('aria-busy', 'false');
  expect(posted).toHaveLength(1);
});

test('Cancel and Escape close an Unlimited form, restore focus, and send nothing', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/v1/seeks')) posts++;
  });

  await form.locator(unlimitedChip).click();
  await form.locator('.cg-cancel').click();
  await expect(form).toBeHidden();
  await expect(page.locator('#create-seek')).toBeFocused();
  await expect(page.locator('#create-seek')).toHaveAttribute('aria-expanded', 'false');

  await page.locator('#create-seek').click();
  await expect(form).toBeVisible();
  // Reopening keeps the choice, and puts focus on it.
  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  await expect(form.locator(`${unlimitedChip} input`)).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(page.locator('#create-seek')).toBeFocused();

  await page.locator('#create-seek').click();
  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  expect(posts).toBe(0);
});

/**
 * Unlimited gets no authentication path of its own: the panel is reached through
 * the same gated trigger as every other choice, and cannot be opened without a
 * session at all.
 */
test('without a session the create trigger is gated, Unlimited included', async ({ page }) => {
  await page.route('**/v1/auth/refresh', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
  });
  await page.route('**/v1/capabilities', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"capabilities":{}}' });
  });
  await page.route('**/v1/seeks', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/');

  const trigger = page.locator('#create-seek');
  await expect(trigger).toBeDisabled();
  await expect(trigger).toHaveAttribute('title', 'Sign in to create a seek');
  await expect(page.locator('#create-game-form')).toBeHidden();
  await expect(page.locator(unlimitedChip)).toBeHidden();
});

/**
 * The resumed-session path a player actually takes: sign in elsewhere, come back,
 * and the panel rebuilds from the last successful create. Every choice that rode
 * on the Unlimited seek has to come back with it.
 */
test('a session resumed on a fresh load restores the Unlimited seek in full', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator(unlimitedChip).click();
  await form.locator('.cg-chip:has(input[name="cg-variant"][value="horde"])').click();
  await form.locator('.cg-seg:has(input[name="cg-mode"][value="rated"])').click();
  await form.locator('.cg-seg:has(input[name="cg-color"][value="white"])').click();
  await form.locator('#cg-min-rating').fill('1400');

  const first = seekRequest(page);
  await form.locator('.cg-submit').click();
  const firstBody = {
    variant: 'horde',
    color: 'white',
    timeControl: UNLIMITED_WIRE,
    rated: true,
    minRating: 1400,
    maxRating: null,
  };
  expect((await first).postDataJSON()).toEqual(firstBody);
  await expect(form).toBeHidden();

  await page.reload();
  await expect(page.locator('#create-seek')).toBeEnabled();
  await page.locator('#create-seek').click();
  await expect(form).toBeVisible();

  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  await expect(form.locator('input[name="cg-variant"]:checked')).toHaveValue('horde');
  await expect(form.locator('input[name="cg-mode"]:checked')).toHaveValue('rated');
  await expect(form.locator('input[name="cg-color"]:checked')).toHaveValue('white');
  await expect(form.locator('#cg-min-rating')).toHaveValue('1400');
  await expect(form.locator('.cg-time-summary')).toHaveText(UNLIMITED_SUMMARY);

  const second = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await second).postDataJSON()).toEqual(firstBody);
});

test('a rejected Unlimited seek surfaces the error, stays retryable, and persists nothing', async ({ page }) => {
  await openCreateGame(page);
  await page.unroute('**/v1/seeks');
  let attempt = 0;
  await page.route('**/v1/seeks', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }
    attempt++;
    if (attempt === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'unlimited-retry' }),
    });
  });

  const form = page.locator('#create-game-form');
  await form.locator(unlimitedChip).click();
  await form.locator('.cg-submit').click();

  await expect(page.locator('#lobby-error')).not.toHaveText('');
  await expect(form).toBeVisible();
  // No silent fall back to a timed control, and nothing written yet.
  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  await expect(form.locator('.cg-submit')).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('gambit-create-game'))).toBeNull();

  await form.locator('.cg-submit').click();
  await expect(form).toBeHidden();
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('gambit-create-game') ?? 'null'))).toEqual({
    time: 'unlimited',
    mode: 'casual',
    variant: 'standard',
    color: 'random',
    minRating: null,
    maxRating: null,
  });
});

test('a stored Unlimited preference restores every choice it recorded', async ({ page }) => {
  await openCreateGame(page, {
    time: 'unlimited', mode: 'rated', variant: 'atomic', color: 'black',
    minRating: 1500, maxRating: 1800,
  });
  const form = page.locator('#create-game-form');

  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  await expect(form.locator('input[name="cg-mode"]:checked')).toHaveValue('rated');
  await expect(form.locator('input[name="cg-variant"]:checked')).toHaveValue('atomic');
  await expect(form.locator('input[name="cg-color"]:checked')).toHaveValue('black');
  await expect(form.locator('#cg-min-rating')).toHaveValue('1500');
  await expect(form.locator('#cg-max-rating')).toHaveValue('1800');
  await expect(form.locator('.cg-time-summary')).toHaveText(UNLIMITED_SUMMARY);
  await expect(form.locator('.cg-custom')).toBeHidden();
});

test('an older timed preference still restores as itself, unrestricted', async ({ page }) => {
  await openCreateGame(page, { time: '5+3', mode: 'rated', variant: 'atomic', color: 'black' });
  const form = page.locator('#create-game-form');

  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('5+3');
  await expect(form.locator('#cg-min-rating')).toHaveValue('');
  await expect(form.locator('#cg-max-rating')).toHaveValue('');
  await expect(form.locator('.cg-time-summary')).toHaveText('Blitz — 5 minutes per side, 3 second increment.');
});

test('a malformed preference falls back to the default preset, never to Unlimited', async ({ browser }) => {
  for (const stored of [
    { time: 'infinite', mode: 'casual' },
    { time: '0+0', mode: 'casual' },
    { time: 'Unlimited', mode: 'casual' },
    { time: 'unlimited', mode: 'ranked' },
    { time: 'unlimited', mode: 'casual', minRating: 1800, maxRating: 1500 },
  ]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openCreateGame(page, stored);
      const checked = page.locator('#create-game-form input[name="cg-time"]:checked');
      await expect(checked, JSON.stringify(stored)).toHaveValue('10+0');
    } finally {
      await context.close();
    }
  }
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mid', width: 480, height: 900 },
  { name: 'narrow', width: 420, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small mobile', width: 320, height: 640 },
] as const) {
  test(`the Unlimited chip fits its column at ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCreateGame(page);
    const form = page.locator('#create-game-form');
    await form.locator(unlimitedChip).click();

    const fits = await form.locator(`${unlimitedChip} .cg-chip-label`).evaluate((element) =>
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
    );
    expect(fits, `Unlimited label at ${viewport.width}px`).toBe(true);

    const chip = await form.locator(unlimitedChip).boundingBox();
    const presets = await form.locator('.cg-presets').boundingBox();
    if (chip === null || presets === null) throw new Error('time controls have no rendered bounds');
    expect(chip.x).toBeGreaterThanOrEqual(presets.x - 0.5);
    expect(chip.x + chip.width).toBeLessThanOrEqual(presets.x + presets.width + 0.5);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    await expect(form.locator('.cg-time-summary')).toHaveText(UNLIMITED_SUMMARY);
  });
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 320, height: 640 },
] as const) {
  test(`Unlimited mirrors under ${viewport.name} RTL without overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('dir', 'rtl'));
    });
    await openCreateGame(page);
    const form = page.locator('#create-game-form');
    await form.locator(unlimitedChip).click();

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);

    // Unlimited precedes Custom in DOM order and they are the last two chips, so
    // they share a row at every column count; mirrored, Unlimited sits to its right.
    const custom = await form.locator('.cg-chip:has(input[value="custom"])').boundingBox();
    const unlimited = await form.locator(unlimitedChip).boundingBox();
    if (custom === null || unlimited === null) throw new Error('time controls have no rendered bounds');
    expect(Math.abs(unlimited.y - custom.y)).toBeLessThanOrEqual(0.5);
    expect(unlimited.x).toBeGreaterThan(custom.x);
    expect(unlimited.x).toBeGreaterThanOrEqual(0);
    expect(unlimited.x + unlimited.width).toBeLessThanOrEqual(viewport.width);

    const fits = await form.locator(`${unlimitedChip} .cg-chip-label`).evaluate((element) =>
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
    );
    expect(fits).toBe(true);
    await expect(form.locator(`${unlimitedChip} .cg-chip-label`)).toHaveText('Unlimited');
  });
}

test('coarse pointers get a 44px Unlimited target', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openCreateGame(page);
    const form = page.locator('#create-game-form');
    await form.locator(unlimitedChip).click();
    const box = await form.locator(unlimitedChip).boundingBox();
    if (box === null) throw new Error('Unlimited chip has no rendered bounds');
    expect(box.height).toBeGreaterThanOrEqual(44);
  } finally {
    await context.close();
  }
});

// ── More options disclosure ──────────────────────────────────────────

const moreToggle = '.cg-more-toggle';
const advancedRegion = '#cg-more-options';
const moreSummary = '.cg-more-summary';

test('the advanced controls start behind a collapsed disclosure', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');

  await expect(form.locator(advancedRegion)).toBeHidden();
  await expect(form.locator('input[name="cg-variant"][value="atomic"]')).toBeHidden();
  await expect(form.locator('#cg-min-rating')).toBeHidden();
  await expect(form.locator('#cg-max-rating')).toBeHidden();
  // The choices that stay are the ones the brief keeps loud.
  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('10+0');
  await expect(form.locator('.cg-seg:has(input[name="cg-mode"][value="rated"])')).toBeVisible();
  await expect(form.locator('.cg-seg:has(input[name="cg-color"][value="white"])')).toBeVisible();
  await expect(form.locator('.cg-submit')).toBeVisible();
});

test('the disclosure button is a real button naming itself and its region', async ({ page }) => {
  await openCreateGame(page);
  const toggle = page.locator(moreToggle);

  await expect(toggle).toHaveRole('button');
  await expect(toggle).toHaveAttribute('type', 'button');
  await expect(toggle).toHaveAttribute('aria-controls', 'cg-more-options');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toContainText('More options');
  await expect(toggle).toBeEnabled();
  // Closed, the button announces the filter it is standing in for; open, the
  // controls speak for themselves and the name goes back to the plain label.
  await expect(toggle).toHaveAccessibleName('More options Standard · Any rating');
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('More options');
});

test('the disclosure opens, closes, and reports each state on the button', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const toggle = page.locator(moreToggle);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(form.locator(advancedRegion)).toBeVisible();
  await expect(form.locator('#cg-min-rating')).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(form.locator(advancedRegion)).toBeHidden();
});

/**
 * Tabbed for real, rather than asserting an attribute and trusting the browser:
 * a regression to `visibility`/`opacity`/zero height would still hide the
 * controls visually while leaving them in the tab order.
 */
test('the advanced controls leave and rejoin the tab order with the disclosure', async ({ page }) => {
  await openCreateGame(page);
  const insideRegion = () =>
    page.evaluate(() => {
      const region = document.querySelector('#cg-more-options');
      return region !== null && document.activeElement !== null && region.contains(document.activeElement);
    });

  // Closed: tabbing on from the toggle reaches the actions, never the region.
  await page.locator('.cg-more-toggle').focus();
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press('Tab');
    expect(await insideRegion(), `closed, tab ${step + 1}`).toBe(false);
  }

  await openAdvanced(page);
  await page.locator('.cg-more-toggle').focus();
  let reached = false;
  for (let step = 0; step < 6 && !reached; step++) {
    await page.keyboard.press('Tab');
    reached = await insideRegion();
  }
  expect(reached, 'open, the region is reachable by Tab').toBe(true);
});

test('the disclosure is fully operable from the keyboard', async ({ page }) => {
  await openCreateGame(page);
  const toggle = page.locator(moreToggle);

  // Tabbed to, not focused programmatically: :focus-visible only arms on a real
  // keyboard interaction, which is the state a keyboard user actually sees.
  for (let step = 0; step < 40 && !(await toggle.evaluate((b) => b === document.activeElement)); step++) {
    await page.keyboard.press('Tab');
  }
  await expect(toggle).toBeFocused();
  const outline = await toggle.evaluate((button) => {
    const style = getComputedStyle(button);
    return { style: style.outlineStyle, width: style.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(3);

  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('every advanced value survives repeated open and close', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const toggle = page.locator(moreToggle);
  await openAdvanced(page);

  await form.locator('.cg-chip:has(input[name="cg-variant"][value="atomic"])').click();
  await form.locator('#cg-min-rating').fill('1200');
  await form.locator('#cg-max-rating').fill('1800');

  for (let cycle = 0; cycle < 3; cycle++) {
    await toggle.click();
    await toggle.click();
  }

  await expect(form.locator('input[name="cg-variant"]:checked')).toHaveValue('atomic');
  await expect(form.locator('#cg-min-rating')).toHaveValue('1200');
  await expect(form.locator('#cg-max-rating')).toHaveValue('1800');

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await request).postDataJSON()).toEqual({
    variant: 'atomic',
    color: 'random',
    timeControl: { initialMs: 600_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    rated: false,
    minRating: 1200,
    maxRating: 1800,
  });
});

test('the collapsed summary reports whatever the advanced controls hold', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const toggle = page.locator(moreToggle);
  const summary = form.locator(moreSummary);

  await expect(summary).toHaveText('Standard · Any rating');

  for (const [variant, minimum, maximum, expected] of [
    ['atomic', '', '', 'Atomic · Any rating'],
    ['atomic', '1200', '', 'Atomic · Rating 1200 and up'],
    ['atomic', '', '1800', 'Atomic · Rating up to 1800'],
    ['atomic', '1600', '1600', 'Atomic · Rating 1600 exactly'],
    ['crazyhouse', '1200', '1800', 'Crazyhouse · Rating 1200 to 1800'],
    ['standard', '0', '4000', 'Standard · Rating 0 to 4000'],
  ] as const) {
    await openAdvanced(page);
    await form.locator(`.cg-chip:has(input[name="cg-variant"][value="${variant}"])`).click();
    await form.locator('#cg-min-rating').fill(minimum);
    await form.locator('#cg-max-rating').fill(maximum);
    await toggle.click();
    await expect(summary, `${variant} ${minimum}-${maximum}`).toHaveText(expected);
  }
});

test('a collapsed invalid range is announced, never summarised as a real choice', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator('#cg-min-rating').fill('2000');
  await form.locator('#cg-max-rating').fill('1500');
  await page.locator(moreToggle).click();

  await expect(form.locator(moreSummary)).toHaveText('Standard · Opponent rating needs attention');
  // What was typed is still there to correct.
  await expect(form.locator('#cg-min-rating')).toHaveValue('2000');
  await expect(form.locator('#cg-max-rating')).toHaveValue('1500');
});

/**
 * Focusing a field inside a closed section would strand the player in front of a
 * form that refuses to submit and explains nothing.
 */
test('submitting a hidden invalid range opens the section, then focuses the field', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator('#cg-min-rating').fill('2000');
  await form.locator('#cg-max-rating').fill('1500');
  await page.locator(moreToggle).click();
  await expect(form.locator(advancedRegion)).toBeHidden();

  await form.locator('.cg-submit').click();

  await expect(form.locator(advancedRegion)).toBeVisible();
  await expect(page.locator(moreToggle)).toHaveAttribute('aria-expanded', 'true');
  await expect(form.locator('#cg-rating-error')).toBeVisible();
  await expect(form.locator('#cg-rating-error')).toHaveText('Minimum rating must not exceed maximum rating.');
  await expect(form.locator('#cg-min-rating')).toHaveAttribute('aria-invalid', 'true');
  await expect(form.locator('#cg-min-rating')).toBeFocused();
});

test('a malformed hidden rating literal also opens the section before reporting', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator('#cg-min-rating').fill('4001');
  await page.locator(moreToggle).click();

  await form.locator('.cg-submit').click();

  await expect(form.locator(advancedRegion)).toBeVisible();
  await expect(form.locator('#cg-rating-error')).toHaveText('Enter a whole rating from 0 to 4000.');
  await expect(form.locator('#cg-min-rating')).toBeFocused();
});

test('a pending create locks the disclosure against a second click', async ({ page }) => {
  await openCreateGame(page);
  await page.unroute('**/v1/seeks');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/v1/seeks', async (route) => {
    if (route.request().method() === 'POST') {
      await gate;
      await route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":"pending-more"}' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  const form = page.locator('#create-game-form');
  const toggle = page.locator(moreToggle);
  await form.locator('.cg-submit').click();

  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // A forced click on a disabled control must not move the disclosure.
  await toggle.click({ force: true }).catch(() => undefined);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(form.locator(advancedRegion)).toBeHidden();

  release();
  await expect(form).toBeHidden();
});

test('restored advanced preferences open the section instead of hiding a filter', async ({ page }) => {
  await openCreateGame(page, {
    time: '5+3', mode: 'rated', variant: 'atomic', color: 'black',
    minRating: 1200, maxRating: 1800,
  });
  const form = page.locator('#create-game-form');

  await expect(page.locator(moreToggle)).toHaveAttribute('aria-expanded', 'true');
  await expect(form.locator(advancedRegion)).toBeVisible();
  await expect(form.locator('input[name="cg-variant"]:checked')).toHaveValue('atomic');
  await expect(form.locator('#cg-min-rating')).toHaveValue('1200');

  // Closing it by hand still leaves the filter described.
  await page.locator(moreToggle).click();
  await expect(form.locator(moreSummary)).toHaveText('Atomic · Rating 1200 to 1800');
});

test('a single restored rating bound is enough to open the section', async ({ browser }) => {
  for (const [stored, expected] of [
    [{ minRating: 1200 }, 'Standard · Rating 1200 and up'],
    [{ maxRating: 1800 }, 'Standard · Rating up to 1800'],
    [{ variant: 'horde' }, 'Horde · Any rating'],
  ] as const) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openCreateGame(page, { time: '10+0', mode: 'casual', ...stored });
      await expect(page.locator(moreToggle), JSON.stringify(stored))
        .toHaveAttribute('aria-expanded', 'true');
      await page.locator(moreToggle).click();
      await expect(page.locator(moreSummary), JSON.stringify(stored)).toHaveText(expected);
    } finally {
      await context.close();
    }
  }
});

test('default preferences leave the section closed and quiet', async ({ page }) => {
  await openCreateGame(page, {
    time: '5+3', mode: 'rated', variant: 'standard', color: 'white',
    minRating: null, maxRating: null,
  });

  await expect(page.locator(moreToggle)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#cg-more-options')).toBeHidden();
  await expect(page.locator(moreSummary)).toHaveText('Standard · Any rating');
});

test('a malformed preference produces no hidden advanced state', async ({ browser }) => {
  for (const stored of [
    { time: 'infinite', mode: 'casual', variant: 'atomic' },
    { time: '7+7', mode: 'rated', minRating: 1200 },
    { time: '10+0', mode: 'casual', variant: 'not-a-variant' },
  ]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await openCreateGame(page, stored);
      await expect(page.locator(moreToggle), JSON.stringify(stored))
        .toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator(moreSummary), JSON.stringify(stored)).toHaveText('Standard · Any rating');
      await expect(page.locator('input[name="cg-variant"]:checked')).toHaveValue('standard');
    } finally {
      await context.close();
    }
  }
});

test('reopening after an advanced create shows the settings it used', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator('.cg-chip:has(input[name="cg-variant"][value="atomic"])').click();
  await form.locator('#cg-min-rating').fill('1200');
  await page.locator(moreToggle).click();

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await request).postDataJSON().variant).toBe('atomic');
  await expect(form).toBeHidden();

  await page.locator('#create-seek').click();
  await expect(form).toBeVisible();
  await expect(page.locator(moreToggle)).toHaveAttribute('aria-expanded', 'true');
  await expect(form.locator('input[name="cg-variant"]:checked')).toHaveValue('atomic');
  await expect(form.locator('#cg-min-rating')).toHaveValue('1200');
});

test('the disclosure never disturbs the time control', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const toggle = page.locator(moreToggle);
  const timeSummary = form.locator('.cg-time-summary');

  await form.locator(unlimitedChip).click();
  await expect(timeSummary).toHaveText(UNLIMITED_SUMMARY);
  await toggle.click();
  await toggle.click();
  await expect(form.locator('input[name="cg-time"]:checked')).toHaveValue('unlimited');
  await expect(timeSummary).toHaveText(UNLIMITED_SUMMARY);

  await form.locator('.cg-chip:has(input[value="custom"])').click();
  await form.locator('#cg-minutes').fill('7.5');
  await form.locator('#cg-increment').fill('4');
  await toggle.click();
  await toggle.click();
  await expect(form.locator('#cg-minutes')).toHaveValue('7.5');
  await expect(form.locator('#cg-increment')).toHaveValue('4');

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  expect((await request).postDataJSON().timeControl).toEqual({
    initialMs: 450_000, incrementMs: 4_000, delayMs: 0, kind: 'increment',
  });
});

test('the disclosure never disturbs mode or color', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  const toggle = page.locator(moreToggle);

  for (const [mode, color] of [['casual', 'white'], ['rated', 'black'], ['rated', 'random']] as const) {
    await form.locator(`.cg-seg:has(input[name="cg-mode"][value="${mode}"])`).click();
    await form.locator(`.cg-seg:has(input[name="cg-color"][value="${color}"])`).click();
    await toggle.click();
    await toggle.click();
    await expect(form.locator('input[name="cg-mode"]:checked'), `${mode}/${color}`).toHaveValue(mode);
    await expect(form.locator('input[name="cg-color"]:checked'), `${mode}/${color}`).toHaveValue(color);
  }

  const request = seekRequest(page);
  await form.locator('.cg-submit').click();
  const body = (await request).postDataJSON();
  expect(body.rated).toBe(true);
  expect(body.color).toBe('random');
});

test('Cancel and Escape still close the whole panel, disclosure open or not', async ({ page }) => {
  await openCreateGame(page);
  const form = page.locator('#create-game-form');
  await openAdvanced(page);

  await form.locator('.cg-cancel').click();
  await expect(form).toBeHidden();
  await expect(page.locator('#create-seek')).toBeFocused();

  await page.locator('#create-seek').click();
  await expect(form).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(page.locator('#create-seek')).toBeFocused();
});

test('a failed advanced create stays retryable with its section open', async ({ page }) => {
  await openCreateGame(page);
  await page.unroute('**/v1/seeks');
  let attempt = 0;
  await page.route('**/v1/seeks', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }
    attempt++;
    await route.fulfill(
      attempt === 1
        ? { status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }
        : { status: 201, contentType: 'application/json', body: '{"id":"retried-more"}' },
    );
  });

  const form = page.locator('#create-game-form');
  await openAdvanced(page);
  await form.locator('.cg-chip:has(input[name="cg-variant"][value="horde"])').click();
  await form.locator('#cg-min-rating').fill('1200');
  await form.locator('.cg-submit').click();

  await expect(page.locator('#lobby-error')).not.toHaveText('');
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="cg-variant"]:checked')).toHaveValue('horde');
  await expect(form.locator('#cg-min-rating')).toHaveValue('1200');
  expect(await page.evaluate(() => localStorage.getItem('gambit-create-game'))).toBeNull();

  await form.locator('.cg-submit').click();
  await expect(form).toBeHidden();
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mid', width: 480, height: 900 },
  { name: 'narrow', width: 420, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'small mobile', width: 320, height: 640 },
] as const) {
  test(`the disclosure row fits and wraps at ${viewport.name} (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openCreateGame(page);
    const form = page.locator('#create-game-form');
    const toggle = page.locator(moreToggle);

    // A long summary is the widest this row ever gets.
    await openAdvanced(page);
    await form.locator('.cg-chip:has(input[name="cg-variant"][value="kingofthehill"])').click();
    await form.locator('#cg-min-rating').fill('1200');
    await form.locator('#cg-max-rating').fill('1800');
    await toggle.click();
    await expect(form.locator(moreSummary)).toHaveText('King of the Hill · Rating 1200 to 1800');

    const clipped = await toggle.evaluate((button) => button.scrollWidth > button.clientWidth + 1);
    expect(clipped, `summary clipped at ${viewport.width}px`).toBe(false);
    await expectNoHorizontalOverflow(page, `collapsed at ${viewport.width}px`);

    // And again with the section open, which is the taller, denser state.
    await toggle.click();
    await expectNoHorizontalOverflow(page, `open at ${viewport.width}px`);
    const box = await form.boundingBox();
    if (box === null) throw new Error('create-game form has no rendered bounds');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  });
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 320, height: 640 },
] as const) {
  test(`the disclosure mirrors under ${viewport.name} RTL without overflow`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => document.documentElement.setAttribute('dir', 'rtl'));
    });
    await openCreateGame(page);
    const form = page.locator('#create-game-form');
    const toggle = page.locator(moreToggle);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await openAdvanced(page);
    await form.locator('#cg-min-rating').fill('1200');
    await form.locator('#cg-max-rating').fill('1800');
    await toggle.click();

    // The bounds keep their order: the summary is an isolated LTR run.
    await expect(form.locator(moreSummary)).toHaveText('Standard · Rating 1200 to 1800');
    await expect(form.locator(moreSummary)).toHaveAttribute('dir', 'ltr');
    await expect(form.locator('#cg-min-rating')).toHaveAttribute('dir', 'ltr');

    await expectNoHorizontalOverflow(page, `RTL collapsed at ${viewport.width}px`);
    const box = await toggle.boundingBox();
    if (box === null) throw new Error('disclosure row has no rendered bounds');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

    await toggle.click();
    await expectNoHorizontalOverflow(page, `RTL open at ${viewport.width}px`);
  });
}

test('coarse pointers get a 44px disclosure target', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openCreateGame(page);
    const box = await page.locator(moreToggle).boundingBox();
    if (box === null) throw new Error('disclosure row has no rendered bounds');
    expect(box.height).toBeGreaterThanOrEqual(44);
  } finally {
    await context.close();
  }
});

test('coarse pointers get 44px create-game targets', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openCreateGame(page);
    const createForm = page.locator('#create-game-form');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    await createForm.locator('.cg-chip:has(input[value="custom"])').click();
    await openAdvanced(page);
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
