import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { DuplicateUserError, uuidv7 } from '@chess-platform/persistence';
import {
  createPool,
  migrate,
  PgSessionsRepository,
  PgUsersRepository,
} from '@chess-platform/persistence/pg';
import { PgRateLimiter } from '../src/ports/pg-rate-limiter';

const skip = process.env['DATABASE_URL'] ? false : 'DATABASE_URL not set';

test('Postgres registration transaction allows one concurrent case-insensitive handle', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const users = new PgUsersRepository(pool);
    const suffix = uuidv7().replaceAll('-', '').slice(0, 12);
    const attempts = await Promise.allSettled([
      users.createWithPasswordAndRole({ id: uuidv7(), handle: `Race${suffix}` }, 'hash-a', 'user'),
      users.createWithPasswordAndRole({ id: uuidv7(), handle: `race${suffix}` }, 'hash-b', 'user'),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = attempts.find((result) => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof DuplicateUserError);
    const winner = await users.findByHandle(`RACE${suffix}`);
    assert.ok(winner);
    assert.ok(await users.getPasswordHash(winner.id));
    assert.deepEqual(await users.rolesOf(winner.id), ['user']);
  } finally {
    await pool.end();
  }
});

test('Postgres refresh rotation has exactly one winner under concurrency', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const user = await users.createWithPasswordAndRole(
      { id: uuidv7(), handle: `rotate${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const oldId = uuidv7();
    await sessions.create({
      id: oldId,
      userId: user.id,
      refreshHash: `old-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const oldHash = (await pool.query<{ refresh_hash: string }>(
      'SELECT refresh_hash FROM sessions WHERE id = $1', [oldId],
    )).rows[0]!.refresh_hash;
    const now = new Date();
    const rotations = await Promise.all([
      sessions.rotate(oldHash, {
        id: uuidv7(), userId: user.id, refreshHash: `new-a-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000), rotatedFrom: oldId,
      }, now),
      sessions.rotate(oldHash, {
        id: uuidv7(), userId: user.id, refreshHash: `new-b-${uuidv7()}`,
        expiresAt: new Date(Date.now() + 60_000), rotatedFrom: oldId,
      }, now),
    ]);
    assert.deepEqual(rotations.map((result) => result.status).sort(), ['revoked', 'rotated']);
    const children = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM sessions WHERE rotated_from = $1', [oldId],
    );
    assert.equal(children.rows[0]!.count, '1');
  } finally {
    await pool.end();
  }
});

test('Postgres rate limiting is shared and atomic across limiter instances', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const a = new PgRateLimiter(pool);
    const b = new PgRateLimiter(pool);
    const key = `integration:${uuidv7()}`;
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      (index % 2 === 0 ? a : b).check(key, { maxRequests: 5, windowMs: 60_000 })));
    assert.equal(results.filter((result) => result.allowed).length, 5);
  } finally {
    await pool.end();
  }
});
