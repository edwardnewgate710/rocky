/**
 * @packageDocumentation
 * A minimal production entrypoint that serves the API over Postgres. Requires
 * `ACCESS_TOKEN_SECRET` and `DATABASE_URL` in the environment. Run with
 * `npm run serve` after building. Graceful shutdown drains the HTTP server, stops
 * any engine subprocesses, and closes the connection pool.
 */

import { createPgApiServer } from '../bootstrap';

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 8080);
  const { server, pool, shutdownAnalysis } = createPgApiServer({ config: { trustProxy: true } });
  const http = await server.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Gambit API listening on :${port}`);

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received — shutting down`);
    http.close(() => {
      // The analysis pool owns engine subprocesses (ADR-0113), so drain it before the process
      // exits — otherwise they are killed rather than asked to quit. A failure here must not
      // block closing the pool, or a stuck engine would keep the container alive until SIGKILL.
      void shutdownAnalysis()
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('analysis engine shutdown failed', err);
        })
        .then(() => pool.end())
        .then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
