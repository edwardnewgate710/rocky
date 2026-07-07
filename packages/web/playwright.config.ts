/**
 * Playwright configuration for Gambit M6 acceptance tests.
 *
 * Usage:
 *   npx playwright test
 *
 * This config is consumed by @playwright/test. The tests validate:
 * 1. The app loads and the board is visible
 * 2. A full game can be played vs. bot (via the engine bridge)
 * 3. A full game can be played vs. human (via the WS gateway)
 * 4. Lighthouse a11y score ≥ 95
 *
 * Prerequisites:
 *   - npm run build (all packages)
 *   - API server running (npm start in packages/api)
 *   - Gateway running (npm start in packages/realtime-gateway)
 *   - Web dev server running (npm run dev in packages/web)
 */
import type { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  testDir: './e2e',
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
};

export default config;
