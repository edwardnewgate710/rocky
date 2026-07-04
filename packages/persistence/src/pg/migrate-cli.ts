/**
 * @packageDocumentation
 * CLI entry point: `npm run migrate`. Applies migrations from the package's
 * `migrations/` directory using `DATABASE_URL`.
 */

import { join } from 'node:path';
import { createPool } from './pool';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const dir = join(process.cwd(), 'migrations');
    const n = await migrate(pool, dir);
    // eslint-disable-next-line no-console
    console.log(`applied ${n} migration(s) from ${dir}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
