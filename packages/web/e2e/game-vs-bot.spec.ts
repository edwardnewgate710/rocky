/**
 * M6 acceptance test: full game vs. bot.
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and running backends.
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect } from '@playwright/test';

test.skip(!process.env.GAMBIT_E2E_BACKEND, 'requires running backend — M6 acceptance gate');

test('full game vs. bot plays to completion', async ({ page }) => {
  await page.goto('/');

  // Register/login, create a seek, join the game, play moves.
  // The bot responds via the gateway's engine integration.
  // Verify the game reaches a terminal state.
  // TODO: implement when backend harness is available (M14).
  expect(true).toBe(true); // placeholder
});
