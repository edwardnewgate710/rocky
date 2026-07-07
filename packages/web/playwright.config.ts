/**
 * Playwright configuration for Gambit M6 acceptance tests.
 *
 * Usage:
 *   npm run e2e                    # static/offline specs (vite preview)
 *   GAMBIT_E2E_BACKEND=1 npm run e2e  # all specs (requires running backends)
 *
 * Backend-dependent specs (game-vs-bot, game-vs-human) are gated with
 * `test.skip(!process.env.GAMBIT_E2E_BACKEND, ...)` so `npm run e2e`
 * without backends only runs the static/offline specs.
 *
 * Prerequisites for full acceptance:
 *   - npm run build (all packages)
 *   - API server running (npm start in packages/api)
 *   - Gateway running (npm start in packages/realtime-gateway)
 *   - GAMBIT_E2E_BACKEND=1 environment variable set
 */
import type { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  testDir: './e2e',
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:4173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  webServer: {
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
