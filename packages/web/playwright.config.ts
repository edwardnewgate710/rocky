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
        // Start both the e2e harness and the vite preview server.
        // The harness runs in the background; vite preview proxies to it.
        command:
          'node ../e2e-harness/dist/serve.js & sleep 2 && npm run build && npm run preview -- --port 4173',
        port: 4173,
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
