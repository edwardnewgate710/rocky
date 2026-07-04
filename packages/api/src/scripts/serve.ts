/**
 * @packageDocumentation
 * A minimal production entrypoint that serves the API over Postgres. Requires
 * `ACCESS_TOKEN_SECRET` and `DATABASE_URL` in the environment. Run with
 * `npm run serve` after building. Graceful shutdown drains the HTTP server and
 * closes the connection pool.
 */

import { createPgApiServer } from '../bootstrap';

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 8080);
  const { server, pool } = createPgApiServer({ config: { trustProxy: true } });
  const http = await server.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Gambit API listening on :${port}`);

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`${signal} received — shutting down`);
    http.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
