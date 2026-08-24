import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { Position } from '@chess-platform/core';
import { uuidv7 } from '../src/ids.js';
import { migrate } from '../src/pg/migrate.js';
import { createPool } from '../src/pg/pool.js';
import { PgStudyPartnerRepository } from '../src/pg/study-partner.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';
const migrationsDir = process.cwd().endsWith(`${join('packages', 'persistence')}`)
  ? join(process.cwd(), 'migrations')
  : join(process.cwd(), 'packages', 'persistence', 'migrations');

test('Study Partner migration declares durable authority and idempotency constraints', async () => {
  const sql = await import('node:fs/promises').then((fs) => fs.readFile(
    join(migrationsDir, '0024_study_partner.sql'),
    'utf8',
  ));
  assert.match(sql, /CREATE TABLE study_partner_sessions/);
  assert.match(sql, /owner_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /CREATE TABLE study_partner_turns/);
  assert.match(sql, /UNIQUE \(session_id, turn_number\)/);
  assert.match(sql, /coaching_version INTEGER NOT NULL CHECK \(coaching_version = 1\)/);
  assert.match(sql, /CREATE TABLE study_partner_turn_requests/);
  assert.match(sql, /PRIMARY KEY \(session_id, idempotency_key\)/);
  assert.match(sql, /ON study_partner_turn_requests \(session_id\)\s+WHERE status/);
  assert.match(sql, /WHERE status IN \('claimed', 'accepted'\)/);
});

test('Postgres Study Partner repository commits a turn and session advancement atomically', { skip }, async () => {
  const pool = createPool();
  await migrate(pool, migrationsDir);
  const repository = new PgStudyPartnerRepository(pool);
  const ownerId = uuidv7();
  const sessionId = uuidv7();
  const turnId = uuidv7();
  const now = new Date('2026-08-24T12:00:00.000Z');
  const hash = 'a'.repeat(64);
  const start = Position.initial().fen();
  const after = Position.initial().play('e2e4').fen();
  try {
    await pool.query(
      `INSERT INTO users (id, handle, email_hash, created_at) VALUES ($1, $2, $3, $4)`,
      [ownerId, `sp-${ownerId.slice(0, 8)}`, Buffer.from(ownerId), now],
    );
    await repository.createSession({ id: sessionId, ownerId, variant: 'standard', initialFen: start, now });
    const claim = await repository.claimTurn({
      sessionId, ownerId, idempotencyKey: 'first', requestHash: hash,
      expectedVersion: 0, maxTurns: 20, now,
    });
    assert.deepEqual(claim, { kind: 'claimed' });
    assert.equal(await repository.acceptTurn({
      sessionId, ownerId, idempotencyKey: 'first', requestHash: hash, now,
    }), true);
    const commit = await repository.commitTurn({
      sessionId,
      ownerId,
      idempotencyKey: 'first',
      requestHash: hash,
      turnId,
      expectedVersion: 0,
      move: 'e2e4',
      fenBefore: start,
      fenAfter: after,
      coaching: { version: 1 },
      coachingVersion: 1,
      now,
    });
    assert.equal(commit.kind, 'committed');
    const stored = await repository.findOwnedSession(sessionId, ownerId);
    assert.equal(stored?.session.version, 1);
    assert.equal(stored?.session.currentFen, after);
    assert.equal(stored?.turns.length, 1);
    const replay = await repository.claimTurn({
      sessionId, ownerId, idempotencyKey: 'first', requestHash: hash,
      expectedVersion: 0, maxTurns: 20, now,
    });
    assert.equal(replay.kind, 'replayed');

    const ended = await repository.endSession({ sessionId, ownerId, expectedVersion: 1, now });
    assert.equal(ended.kind, 'ended');
    const endedAgain = await repository.endSession({
      sessionId, ownerId, expectedVersion: 1, now: new Date(now.getTime() + 60_000),
    });
    assert.equal(endedAgain.kind, 'already_ended');
    if (ended.kind === 'ended' && endedAgain.kind === 'already_ended') {
      assert.deepEqual(endedAgain.session.completedAt, ended.session.completedAt);
    }
    assert.equal(await repository.deleteOwnedSession(sessionId, ownerId), true);
    const rows = await pool.query(
      `SELECT
         (SELECT count(*) FROM study_partner_sessions WHERE id = $1) AS sessions,
         (SELECT count(*) FROM study_partner_turns WHERE session_id = $1) AS turns,
         (SELECT count(*) FROM study_partner_turn_requests WHERE session_id = $1) AS requests`,
      [sessionId],
    );
    assert.deepEqual(rows.rows[0], { sessions: '0', turns: '0', requests: '0' });
  } finally {
    await pool.query('DELETE FROM users WHERE id = $1', [ownerId]);
    await pool.end();
  }
});
