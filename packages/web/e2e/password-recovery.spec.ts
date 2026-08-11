import { test, expect } from '@playwright/test';

test.describe('Password recovery web UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/v1/capabilities', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: {} }),
      });
    });

    await page.route('**/v1/seeks', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
  });

  test('discoverable Forgot password? link navigates to /password-reset and hides #auth', async ({ page }) => {
    await page.goto('/');
    const forgotLink = page.locator('#auth-forgot-password');
    await expect(forgotLink).toBeVisible();

    await forgotLink.click();
    await expect(page).toHaveURL(/\/password-reset$/);

    const passwordResetSection = page.locator('#password-reset');
    await expect(passwordResetSection).toBeVisible();
    await expect(page.locator('#auth')).toBeHidden();

    // Check request form controls are present
    await expect(page.locator('#password-reset-request-input')).toBeVisible();
    await expect(page.locator('#password-reset-request-submit')).toBeVisible();
  });

  test('request reset flow: active button copy, loading state, and generic success copy', async ({ page }) => {
    let requestMade = false;
    let requestBody: unknown = null;

    await page.route('**/v1/auth/password-reset/request', async (route) => {
      requestMade = true;
      requestBody = JSON.parse(route.request().postData() || '{}');
      await page.waitForTimeout(100);
      await route.fulfill({ status: 202, contentType: 'application/json', body: '' });
    });

    await page.goto('/password-reset');

    const input = page.locator('#password-reset-request-input');
    const submitBtn = page.locator('#password-reset-request-submit');
    const form = page.locator('#password-reset-request-form');

    await input.fill('alice@example.com');
    await submitBtn.click();

    // Verify loading button text, disabled state, and aria-busy
    await expect(submitBtn).toHaveText('Sending…');
    await expect(form).toHaveAttribute('aria-busy', 'true');
    await expect(submitBtn).toBeDisabled();

    // Wait for completion
    const statusMsg = page.locator('#password-reset-status');
    await expect(statusMsg).toHaveText(/If an account matching/);
    await expect(form).toHaveAttribute('aria-busy', 'false');
    await expect(submitBtn).toBeEnabled();
    await expect(submitBtn).toHaveText('Send reset link');

    expect(requestMade).toBe(true);
    expect(requestBody).toEqual({ handleOrEmail: 'alice@example.com' });
  });

  test('leaving during a pending request restores an idle form on SPA route re-entry', async ({ page }) => {
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    let releaseRequest!: () => void;
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });

    await page.route('**/v1/auth/password-reset/request', async (route) => {
      markRequestStarted();
      await requestReleased;
      await route.fulfill({ status: 202, contentType: 'application/json', body: '' });
    });

    await page.goto('/password-reset');
    await page.locator('#password-reset-request-input').fill('alice@example.com');
    await page.locator('#password-reset-request-submit').click();
    await requestStarted;

    await expect(page.locator('#password-reset-request-form')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#password-reset-request-submit')).toBeDisabled();

    await page.locator('#password-reset-back-link').click();
    await expect(page).toHaveURL(/\/$/);
    await page.locator('#auth-forgot-password').click();
    await expect(page).toHaveURL(/\/password-reset$/);

    await expect(page.locator('#password-reset-request-form')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#password-reset-confirm-form')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#password-reset-request-input')).toBeEnabled();
    await expect(page.locator('#password-reset-request-submit')).toBeEnabled();
    await expect(page.locator('#password-reset-request-submit')).toHaveText('Send reset link');

    releaseRequest();
  });

  test('confirm reset flow: validation errors preserve inputs, success clears inputs, releases token, and hides confirm view', async ({ page }) => {
    let confirmCalls = 0;
    let confirmBody: unknown = null;

    await page.route('**/v1/auth/password-reset/confirm', async (route) => {
      confirmCalls++;
      confirmBody = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 204,
        headers: { 'Set-Cookie': 'gambit_refresh=; Max-Age=0' },
      });
    });

    await page.goto('/password-reset?token=secret-token-123');

    // Confirm view visible, request view hidden
    await expect(page.locator('#password-reset-confirm-view')).toBeVisible();
    await expect(page.locator('#password-reset-request-view')).toBeHidden();

    const passInput = page.locator('#password-reset-confirm-password');
    const passConfirmInput = page.locator('#password-reset-confirm-password-confirm');
    const submitBtn = page.locator('#password-reset-confirm-submit');
    const errorMsg = page.locator('#password-reset-error');
    const statusMsg = page.locator('#password-reset-status');

    // 1. Password too short (<8) validation
    await passInput.fill('short');
    await passConfirmInput.fill('short');
    await submitBtn.click();
    await expect(errorMsg).toHaveText(/between 8 and 1024/);
    expect(confirmCalls).toBe(0);
    // Verify inputs are preserved
    await expect(passInput).toHaveValue('short');
    await expect(passConfirmInput).toHaveValue('short');

    // 2. Password mismatch validation
    await passInput.fill('newpassword123');
    await passConfirmInput.fill('mismatch123');
    await submitBtn.click();
    await expect(errorMsg).toHaveText(/do not match/);
    expect(confirmCalls).toBe(0);
    // Verify inputs are preserved
    await expect(passInput).toHaveValue('newpassword123');
    await expect(passConfirmInput).toHaveValue('mismatch123');

    // 3. Valid submission
    await passConfirmInput.fill('newpassword123');
    await submitBtn.click();

    // Wait for success status
    await expect(statusMsg).toHaveText(/reset successfully/);
    expect(confirmCalls).toBe(1);
    expect(confirmBody).toEqual({ token: 'secret-token-123', newPassword: 'newpassword123' });

    // Confirm view hidden on success
    await expect(page.locator('#password-reset-confirm-view')).toBeHidden();
    await expect(passInput).toHaveValue('');
    await expect(passConfirmInput).toHaveValue('');

    // The secret is released after success, so even a programmatic resubmit cannot replay it.
    await page.locator('#password-reset-confirm-form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    expect(confirmCalls).toBe(1);

    // Back to sign in link navigates to /
    const backLink = page.locator('#password-reset-back-link');
    await backLink.click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('confirm reset flow: 401 invalid/expired token response preserves inputs', async ({ page }) => {
    await page.route('**/v1/auth/password-reset/confirm', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'Invalid or expired token', code: 'UNAUTHORIZED' } }),
      });
    });

    await page.goto('/password-reset?token=invalid-token');

    const passInput = page.locator('#password-reset-confirm-password');
    const passConfirmInput = page.locator('#password-reset-confirm-password-confirm');
    const submitBtn = page.locator('#password-reset-confirm-submit');

    await passInput.fill('newpassword123');
    await passConfirmInput.fill('newpassword123');
    await submitBtn.click();

    const errorMsg = page.locator('#password-reset-error');
    await expect(errorMsg).toHaveText(/invalid or has expired/);

    // Verify inputs preserved on 401 error
    await expect(passInput).toHaveValue('newpassword123');
    await expect(passConfirmInput).toHaveValue('newpassword123');
  });

  test('session clearing: authenticated session is invalidated locally without server logout call', async ({ page }) => {
    let logoutCalls = 0;
    await page.route('**/v1/auth/logout', async (route) => {
      logoutCalls++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.route('**/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
          tokens: { accessToken: 'tok-123', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
        }),
      });
    });

    await page.route('**/v1/auth/password-reset/confirm', async (route) => {
      await route.fulfill({ status: 204, body: '' });
    });

    // Seed session in localStorage before navigation
    await page.addInitScript(() => {
      localStorage.setItem('gambit-session', JSON.stringify({ handle: 'alice', userId: 'u1' }));
    });

    await page.goto('/password-reset?token=secret-token-777');

    // Verify initial state is signed in as alice
    const authStatus = page.locator('#auth-status');
    await expect(authStatus).toHaveText('Signed in as alice');
    await expect(page.locator('#auth-logout')).toBeVisible();

    // Confirm password reset
    await page.locator('#password-reset-confirm-password').fill('newpassword123');
    await page.locator('#password-reset-confirm-password-confirm').fill('newpassword123');
    await page.locator('#password-reset-confirm-submit').click();

    // Verify session invalidated locally: topbar updated, logout hidden, localStorage cleared
    await expect(authStatus).toHaveText('Not signed in');
    await expect(page.locator('#auth-logout')).toBeHidden();

    const storedSession = await page.evaluate(() => localStorage.getItem('gambit-session'));
    expect(storedSession).toBeNull();

    // Verify server logout was NOT called
    expect(logoutCalls).toBe(0);
  });

  test('token secret hygiene: token stripped from URL before any network call and never leaked in Referer of API requests', async ({ page }) => {
    const apiReferrers: string[] = [];

    // Intercept API / background requests made by the application
    await page.route('**/v1/**', async (route) => {
      const ref = route.request().headers()['referer'];
      if (ref) apiReferrers.push(ref);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ capabilities: {} }),
      });
    });

    await page.goto('/password-reset?token=super-secret-token-999');

    // Token must be stripped from location bar immediately
    await expect(page).toHaveURL(/\/password-reset$/);
    expect(page.url()).not.toContain('super-secret-token-999');

    // Confirm form is still populated with token in memory and operable
    await expect(page.locator('#password-reset-confirm-view')).toBeVisible();

    // Verify NO API request's Referer header contained the token
    expect(apiReferrers.length).toBeGreaterThan(0);
    for (const ref of apiReferrers) {
      expect(ref).not.toContain('super-secret-token-999');
    }
  });

  test('responsive mobile layout at 390x844 viewport: scoped input font-size is 16px and no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/password-reset');

    const section = page.locator('#password-reset');
    await expect(section).toBeVisible();

    const box = await section.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    // Verify scoped password recovery inputs have computed font-size of 16px (1rem)
    const inputFontSize = await page.locator('#password-reset-request-input').evaluate((el) => {
      return window.getComputedStyle(el).fontSize;
    });
    expect(inputFontSize).toBe('16px');
  });
});
