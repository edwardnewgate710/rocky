/**
 * @packageDocumentation
 * Postgres connection pool factory. The pool is the single shared handle a
 * service holds; repositories and the event store are constructed around it.
 */

import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

/**
 * Create a `pg` connection pool. If no `connectionString` is supplied, falls back
 * to `DATABASE_URL`. Throws if neither is available.
 */
export function createPool(config: PoolConfig = {}): Pool {
  const connectionString = config.connectionString ?? process.env['DATABASE_URL'];
  if (!connectionString && !config.host) {
    throw new Error('createPool: no connectionString and DATABASE_URL is not set');
  }
  return new Pool({ ...config, connectionString });
}
