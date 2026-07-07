/**
 * Playwright configuration for Gambit M6 acceptance tests.
 *
 * Usage:
 *   npm run e2e                        # static/offline specs (vite preview only)
 *   GAMBIT_E2E_BACKEND=1 npm run e2e   # all specs (starts e2e harness + vite preview)
 *
 * Backend-dependent specs (game-vs-bot, game-vs-human) are gated with
 * `test.skip(!process.env.GAMBIT_E2E_BACKEND, ...)` so `npm run e2e`
 * without backends only runs the static/offline specs.
 *
 * When GAMBIT_E2E_BACKEND=1, the config starts:
 *   1. The e2e harness (API + WS gateway + bot) on ports 4174/4175
 *   2. The vite preview server on port 4173 (with proxy to the harness)
 *
 * The build runs first so dist/serve.js exists before the harness starts.
 * Playwright polls the `url` until it returns 200 — no fixed sleep.
 *
 * Prerequisites for full acceptance:
 *   - npm run build (all packages, including e2e-harness)
 *   - GAMBIT_E2E_BACKEND=1 environment variable set
 */
import type { PlaywrightTestConfig } from '@playwright/test';

const isBackend = !!process.env['GAMBIT_E2E_BACKEND'];

const config: PlaywrightTestConfig = {
  testDir: './e2e',
  timeout: 90_000,
  retries: 1,
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:4173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: isBackend
    ? {
        // Build first (so dist/serve.js exists), then start the harness in the
        // background, then start vite preview. Playwright polls `url` until 200.
        command:
          'npm run build && (node ../e2e-harness/dist/serve.js &) && npm run preview -- --port 4173',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: true,
        timeout: 120_000,
      }
    : {
        command: 'npm run build && npm run preview',
        port: 4173,
        reuseExistingServer: true,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
};

export default config;
