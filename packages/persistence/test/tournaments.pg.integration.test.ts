import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgTournamentsRepository } from '../src/pg/repositories';
import { isArenaSnapshot } from '../src/repositories';
import { Tournament } from '@chess-platform/tournament';
import { createPairingStrategy } from '@chess-platform/tournament';
import type { TournamentConfig } from '@chess-platform/tournament';
import { VersionConflictError } from '../src/errors';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('tournaments repository: migrations apply and are idempotent', { skip }, async () => {
  const pool = createPool();
  try {
    const dir = join(process.cwd(), 'migrations');
    await migrate(pool, dir);
    assert.equal(await migrate(pool, dir), 0, 're-running applies nothing');
  } finally {
    await pool.end();
  }
});

test('tournaments repository: round-trip a round-robin mid-flight snapshot', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const repo = new PgTournamentsRepository(pool);

    const config: TournamentConfig = {
      id: 't-rr-test',
      name: 'Test Round Robin',
      format: 'round_robin',
      variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    };

    const tournament = new Tournament(config, createPairingStrategy(config));
    tournament.register('U1');
    tournament.register('U2');
    tournament.start();
    
    // Save state
    await repo.save(tournament.toSnapshot(), 0);

    // Load state
    const stored1 = await repo.findById('t-rr-test');
    assert.ok(stored1);
    const loaded = stored1.snapshot;
    assert.ok(!isArenaSnapshot(loaded), 'round-robin snapshot must not be an arena snapshot');
    assert.deepEqual(loaded.participants, ['U1', 'U2']);
    assert.equal(loaded.state, 'running');
    assert.equal(loaded.rounds.length, 1);
    
    // Resume and finish
    const restored = Tournament.restore(loaded, createPairingStrategy(loaded.config));
    restored.recordResult(0, 0, 'white_win');
    assert.equal(restored.getState(), 'finished');

    // Update state
    await repo.save(restored.toSnapshot(), stored1.version);

    const stored2 = await repo.findById('t-rr-test');
    assert.ok(stored2);
    const finished = stored2.snapshot;
    assert.ok(!isArenaSnapshot(finished), 'round-robin snapshot must not be an arena snapshot');
    assert.equal(finished.state, 'finished');
    const resultEntry = finished.results.find(r => r[0] === '0-0');
    assert.ok(resultEntry);
    assert.equal(resultEntry[1], 'white_win');
    
    // Duplicate save (upsert behavior check) -> with CAS it should throw VersionConflictError if using old version
    await assert.rejects(repo.save(restored.toSnapshot(), stored1.version), VersionConflictError);
    // But it works with the correct version
    await repo.save(restored.toSnapshot(), stored2.version);

    // list test
    const list = await repo.list(10);
    const summary = list.find(l => l.id === 't-rr-test');
    assert.ok(summary);
    assert.equal(summary.name, 'Test Round Robin');
    assert.equal(summary.format, 'round_robin');
    assert.equal(summary.state, 'finished');
    assert.equal(summary.participantCount, 2);
  } finally {
    await pool.end();
  }
});

test('tournaments repository: round-trip a swiss mid-flight snapshot', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const repo = new PgTournamentsRepository(pool);

    const config: TournamentConfig = {
      id: 't-swiss-test',
      name: 'Test Swiss',
      format: 'swiss',
      variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
      rounds: 2,
    };

    const tournament = new Tournament(config, createPairingStrategy(config));
    for (const p of ['U1', 'U2', 'U3', 'U4']) tournament.register(p);
    tournament.start();

    // Round 1
    const r1 = tournament.getRounds()[0];
    tournament.recordResult(0, 0, 'white_win');
    tournament.recordResult(0, 1, 'draw');

    await repo.save(tournament.toSnapshot(), 0);

    const stored1 = await repo.findById('t-swiss-test');
    assert.ok(stored1);
    const loaded = stored1.snapshot;
    assert.ok(!isArenaSnapshot(loaded), 'swiss snapshot must not be an arena snapshot');
    assert.equal(loaded.state, 'running');
    assert.equal(loaded.rounds.length, 2);

    // Continue
    const restored = Tournament.restore(loaded, createPairingStrategy(loaded.config));
    restored.recordResult(1, 0, 'black_win');
    restored.recordResult(1, 1, 'black_win');
    
    assert.equal(restored.getState(), 'finished');
    await repo.save(restored.toSnapshot(), stored1.version);

    const list = await repo.list(10);
    const summary = list.find(l => l.id === 't-swiss-test');
    assert.ok(summary);
    assert.equal(summary.format, 'swiss');
    assert.equal(summary.state, 'finished');
    assert.equal(summary.participantCount, 4);

    // Newest first sorting
    const config2: TournamentConfig = { ...config, id: 't-swiss-test-2' };
    const t2 = new Tournament(config2, createPairingStrategy(config2));
    await repo.save(t2.toSnapshot(), 0);

    const list2 = await repo.list(10);
    // Since t2 was just saved, it must be before t-swiss-test due to created_at DESC
    // Note: created_at is server-generated, so we rely on time passing or sequence.
    // In practice they could be fast enough to be same MS, so we check inclusion.
    const i1 = list2.findIndex(l => l.id === 't-swiss-test');
    const i2 = list2.findIndex(l => l.id === 't-swiss-test-2');
    assert.ok(i1 !== -1 && i2 !== -1);
    // created_at is only set on INSERT, so t2 is newer
    assert.ok(i2 < i1, 't2 should be newer than t1');

  } finally {
    await pool.end();
  }
});

test('tournaments repository: pre-migration rows (no explicit version) stay updatable', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const repo = new PgTournamentsRepository(pool);

    const config: TournamentConfig = {
      id: 't-pre-migration',
      name: 'Pre-migration Tournament',
      format: 'round_robin',
      variant: 'standard',
      timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
    };
    const tournament = new Tournament(config, createPairingStrategy(config));
    tournament.register('U1');
    tournament.register('U2');

    // Simulate a row created before migration 0006: insert WITHOUT the version
    // column so the column DEFAULT applies. The default must be 1 — with a
    // default of 0 the repository would treat the row as "not created yet" and
    // every save would collide with the existing id forever.
    await pool.query('DELETE FROM tournaments WHERE id = $1', [config.id]);
    const snap = tournament.toSnapshot();
    await pool.query(
      `INSERT INTO tournaments (id, name, format, state, participant_count, snapshot)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [config.id, config.name, config.format, snap.state, snap.participants.length, JSON.stringify(snap)]
    );

    const stored = await repo.findById(config.id);
    assert.ok(stored);
    assert.equal(stored.version, 1, 'pre-migration rows must default to version 1');

    tournament.start();
    await repo.save(tournament.toSnapshot(), stored.version);
    const after = await repo.findById(config.id);
    assert.equal(after!.snapshot.state, 'running');
    assert.equal(after!.version, 2);
  } finally {
    await pool.end();
  }
});
