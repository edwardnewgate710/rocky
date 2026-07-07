/**
 * Entry point: start the e2e harness as a standalone process.
 *
 * Usage:
 *   node dist/main.js
 *   API_PORT=4180 WS_PORT=4181 node dist/main.js
 */
import { serveHarness } from './serve.js';

serveHarness().catch((err) => {
  console.error('[e2e-harness] Fatal error:', err);
  process.exit(1);
});