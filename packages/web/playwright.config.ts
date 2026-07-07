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
 * When GAMBIT_E2E_BACKEND=1, the config uses a two-entry webServer array:
 *   1. The e2e harness (node ../e2e-harness/dist/main.js) — Playwright polls
 *      http://127.0.0.1:4174/v1/health until 200.
 *   2. The vite preview server on port 4173 — Playwright polls
 *      http://127.0.0.1:4173 until 200.
 * Playwright owns both lifecycles (no orphaned processes, no fixed sleeps).
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
    ? [
        {
          // 1. Start the e2e harness (API + WS gateway + bot).
          //    main.js calls serveHarness() which boots and listens.
          //    Playwright polls /v1/health until 200 — no fixed sleep.
          command: 'node ../e2e-harness/dist/main.js',
          url: 'http://127.0.0.1:4174/v1/health',
          reuseExistingServer: true,
          timeout: 30_000,
        },
        {
          // 2. Start vite preview (proxies /v1, /e2e, /ws to the harness).
          //    Build first so dist/ exists, then preview on port 4173.
          command: 'npm run build && npm run preview -- --port 4173',
          url: 'http://127.0.0.1:4173',
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ]
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
