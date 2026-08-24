import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { Position } from '@chess-platform/core';
import { InMemoryStudyPartnerRepository } from '../src/in-memory-study-partner.js';
import { uuidv7 } from '../src/ids.js';
import { migrate } from '../src/pg/migrate.js';
import { createPool } from '../src/pg/pool.js';
import { PgStudyPartnerRepository } from '../src/pg/study-partner.js';
import {
  STUDY_PARTNER_ACCEPTED_DELETE_PROTECTION_MS,
  STUDY_PARTNER_CLAIM_TIMEOUT_MS,
} from '../src/study-partner.js';

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

test('stale pre-charge claims expire while accepted claims remain terminal', async () => {
  const repository = new InMemoryStudyPartnerRepository();
  const now = new Date('2026-08-24T12:00:00.000Z');
  await repository.createSession({
    id: 'session', ownerId: 'owner', variant: 'standard', initialFen: Position.initial().fen(), now,
  });
  const first = await repository.claimTurn({
    sessionId: 'session', ownerId: 'owner', idempotencyKey: 'abandoned', requestHash: 'a'.repeat(64),
    expectedVersion: 0, maxTurns: 20, now,
  });
  assert.equal(first.kind, 'claimed');
  const beforeTimeout = await repository.claimTurn({
    sessionId: 'session', ownerId: 'owner', idempotencyKey: 'too-soon', requestHash: 'b'.repeat(64),
    expectedVersion: 0, maxTurns: 20, now: new Date(now.getTime() + STUDY_PARTNER_CLAIM_TIMEOUT_MS - 1),
  });
  assert.equal(beforeTimeout.kind, 'in_progress');
  const replacementNow = new Date(now.getTime() + STUDY_PARTNER_CLAIM_TIMEOUT_MS);
  const replacement = await repository.claimTurn({
    sessionId: 'session', ownerId: 'owner', idempotencyKey: 'replacement', requestHash: 'c'.repeat(64),
    expectedVersion: 0, maxTurns: 20, now: replacementNow,
  });
  assert.equal(replacement.kind, 'claimed');
  assert.equal(await repository.acceptTurn({
    sessionId: 'session', ownerId: 'owner', idempotencyKey: 'replacement',
    requestHash: 'c'.repeat(64), now: replacementNow,
  }), true);
  const afterAcceptedTimeout = await repository.claimTurn({
    sessionId: 'session', ownerId: 'owner', idempotencyKey: 'must-wait', requestHash: 'd'.repeat(64),
    expectedVersion: 0, maxTurns: 20,
    now: new Date(replacementNow.getTime() + STUDY_PARTNER_CLAIM_TIMEOUT_MS),
  });
  assert.equal(afterAcceptedTimeout.kind, 'in_progress');
  assert.deepEqual(
    await repository.deleteOwnedSession(
      'session',
      'owner',
      new Date(replacementNow.getTime() + STUDY_PARTNER_ACCEPTED_DELETE_PROTECTION_MS),
    ),
    { kind: 'deleted' },
  );
});

test('deletion protects a fresh claim but does not leave an abandoned pre-charge claim undeletable', async () => {
  const repository = new InMemoryStudyPartnerRepository();
  const now = new Date('2026-08-24T12:00:00.000Z');
  await repository.createSession({
    id: 'deletion', ownerId: 'owner', variant: 'standard', initialFen: Position.initial().fen(), now,
  });
  assert.equal((await repository.claimTurn({
    sessionId: 'deletion', ownerId: 'owner', idempotencyKey: 'claim', requestHash: 'e'.repeat(64),
    expectedVersion: 0, maxTurns: 20, now,
  })).kind, 'claimed');
  assert.deepEqual(
    await repository.deleteOwnedSession(
      'deletion',
      'owner',
      new Date(now.getTime() + STUDY_PARTNER_CLAIM_TIMEOUT_MS - 1),
    ),
    { kind: 'turn_in_progress' },
  );
  assert.deepEqual(
    await repository.deleteOwnedSession(
      'deletion',
      'owner',
      new Date(now.getTime() + STUDY_PARTNER_CLAIM_TIMEOUT_MS),
    ),
    { kind: 'deleted' },
  );
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
    assert.equal((await repository.claimTurn({
      sessionId, ownerId, idempotencyKey: 'abandoned', requestHash: 'b'.repeat(64),
      expectedVersion: 0, maxTurns: 20, now,
    })).kind, 'claimed');
    const recoveredAt = new Date(now.getTime() + STUDY_PARTNER_CLAIM_TIMEOUT_MS);
    const claim = await repository.claimTurn({
      sessionId, ownerId, idempotencyKey: 'first', requestHash: hash,
      expectedVersion: 0, maxTurns: 20, now: recoveredAt,
    });
    assert.deepEqual(claim, { kind: 'claimed' });
    assert.equal(await repository.acceptTurn({
      sessionId, ownerId, idempotencyKey: 'first', requestHash: hash, now: recoveredAt,
    }), true);
    assert.deepEqual(
      await repository.deleteOwnedSession(sessionId, ownerId, recoveredAt),
      { kind: 'turn_in_progress' },
    );
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
      now: recoveredAt,
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

    const ended = await repository.endSession({ sessionId, ownerId, expectedVersion: 1, now: recoveredAt });
    assert.equal(ended.kind, 'ended');
    const endedAgain = await repository.endSession({
      sessionId, ownerId, expectedVersion: 1, now: new Date(now.getTime() + 60_000),
    });
    assert.equal(endedAgain.kind, 'already_ended');
    if (ended.kind === 'ended' && endedAgain.kind === 'already_ended') {
      assert.deepEqual(endedAgain.session.completedAt, ended.session.completedAt);
    }
    assert.deepEqual(
      await repository.deleteOwnedSession(sessionId, ownerId, recoveredAt),
      { kind: 'deleted' },
    );
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
