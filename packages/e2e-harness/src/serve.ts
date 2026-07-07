/**
 * Start the e2e harness as a standalone server.
 *
 * Reads ports from the environment (API_PORT, WS_PORT) with sensible defaults.
 * Prints a startup line so the Playwright webServer config can detect readiness.
 */
import { createHarness, type Harness } from './harness.js';

export async function serveHarness(): Promise<Harness> {
  const apiPort = parseInt(process.env['API_PORT'] ?? '4174', 10);
  const wsPort = parseInt(process.env['WS_PORT'] ?? '4175', 10);

  const harness = await createHarness({ apiPort, wsPort });

  console.log(`[e2e-harness] API listening on http://127.0.0.1:${apiPort}`);
  console.log(`[e2e-harness] WS  listening on ws://127.0.0.1:${wsPort}`);

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    await harness.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return harness;
}
