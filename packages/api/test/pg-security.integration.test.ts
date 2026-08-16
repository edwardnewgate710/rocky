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

/**
 * `AuthService.revokeSession` audits only when its own call performed the revocation, which is only
 * true if the repository resolves the race rather than the service. The in-memory fake mirrors the
 * contract but cannot prove it — a single JavaScript turn has no interleaving to lose.
 */
test('Postgres session revocation has exactly one winner under concurrency', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const user = await users.createWithPasswordAndRole(
      { id: uuidv7(), handle: `revoke${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const id = uuidv7();
    await sessions.create({
      id,
      userId: user.id,
      refreshHash: `rev-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const at = new Date();
    const outcomes = await Promise.all([
      sessions.revoke(id, at),
      sessions.revoke(id, at),
      sessions.revoke(id, at),
    ]);
    assert.equal(outcomes.filter(Boolean).length, 1, 'one caller performed the transition');

    const later = await sessions.revoke(id, new Date(Date.now() + 1_000));
    assert.equal(later, false, 'a revoked session cannot be revoked again');

    const row = (await pool.query<{ revoked_at: Date }>(
      'SELECT revoked_at FROM sessions WHERE id = $1', [id],
    )).rows[0]!;
    assert.equal(row.revoked_at.getTime(), at.getTime(), 'the first revocation time stands');
  } finally {
    await pool.end();
  }
});

/**
 * The account-security screen identifies sessions by their created metadata, so it has to survive
 * the round trip: the columns are written by `create` but were absent from the read projection.
 */
test('Postgres session rows carry the request metadata they were created with', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), '../persistence/migrations'));
    const users = new PgUsersRepository(pool);
    const sessions = new PgSessionsRepository(pool);
    const user = await users.createWithPasswordAndRole(
      { id: uuidv7(), handle: `meta${uuidv7().replaceAll('-', '').slice(0, 12)}` },
      'hash',
      'user',
    );
    const id = uuidv7();
    await sessions.create({
      id,
      userId: user.id,
      refreshHash: `meta-${uuidv7()}`,
      expiresAt: new Date(Date.now() + 60_000),
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121',
    });

    const listed = (await sessions.listForUser(user.id)).find((s) => s.id === id);
    assert.equal(listed?.createdIp, '203.0.113.7');
    assert.equal(listed?.createdUserAgent, 'Mozilla/5.0 (X11; Linux x86_64) Firefox/121');
    assert.equal(listed?.lastIp, null, 'nothing writes the last-seen fields');
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
