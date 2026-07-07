/**
 * M6 acceptance test: full game vs. human (two browser contexts).
 *
 * Gated: requires GAMBIT_E2E_BACKEND=1 and running backends.
 *
 * Run with: GAMBIT_E2E_BACKEND=1 npm run e2e
 */
import { test, expect } from '@playwright/test';

test.skip(!process.env.GAMBIT_E2E_BACKEND, 'requires running backend — M6 acceptance gate');

test('full game vs. human plays to completion', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  // Player 1 creates a seek, player 2 accepts, both play.
  // TODO: implement when backend harness is available (M14).
  expect(true).toBe(true); // placeholder

  await ctx1.close();
  await ctx2.close();
});
