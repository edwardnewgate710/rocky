import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { PgSeekAcceptor } from '../src/pg/repositories';

test('PgSeekAcceptor preserves the transaction failure when rollback also fails', async () => {
  const transactionFailure = new Error('connection lost during seek claim');
  const rollbackFailure = new Error('connection unavailable during rollback');
  const client = {
    query: async (sql: string): Promise<never | object> => {
      if (sql === 'BEGIN') return {};
      if (sql === 'ROLLBACK') throw rollbackFailure;
      throw transactionFailure;
    },
    release: (): void => {},
  } as unknown as PoolClient;
  const pool = {
    connect: async (): Promise<PoolClient> => client,
  } as unknown as Pool;
  const acceptor = new PgSeekAcceptor(pool);

  await assert.rejects(
    acceptor.accept('seek-id', 'game-id', [], {
      id: 'game-id',
      variant: 'standard',
      rated: false,
      speed: 'blitz',
      whiteId: 'creator-id',
      blackId: 'acceptor-id',
      startedAt: new Date(0),
    }),
    (error: unknown) => error === transactionFailure,
  );
});
