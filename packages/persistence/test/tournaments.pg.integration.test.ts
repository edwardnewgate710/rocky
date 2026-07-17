import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgTournamentsRepository } from '../src/pg/repositories';
import { Tournament } from '@chess-platform/tournament';
import { createPairingStrategy } from '@chess-platform/tournament';
import type { TournamentConfig } from '@chess-platform/tournament';

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
    await repo.save(tournament.toSnapshot());

    // Load state
    const loaded = await repo.findById('t-rr-test');
    assert.ok(loaded);
    assert.deepEqual(loaded.participants, ['U1', 'U2']);
    assert.equal(loaded.state, 'running');
    assert.equal(loaded.rounds.length, 1);
    
    // Resume and finish
    const restored = Tournament.restore(loaded, createPairingStrategy(loaded.config));
    restored.recordResult(0, 0, 'white_win');
    assert.equal(restored.getState(), 'finished');

    // Update state
    await repo.save(restored.toSnapshot());

    const finished = await repo.findById('t-rr-test');
    assert.ok(finished);
    assert.equal(finished.state, 'finished');
    const resultEntry = finished.results.find(r => r[0] === '0-0');
    assert.ok(resultEntry);
    assert.equal(resultEntry[1], 'white_win');
    
    // Duplicate save (upsert behavior check)
    await repo.save(restored.toSnapshot());

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

    await repo.save(tournament.toSnapshot());

    const loaded = await repo.findById('t-swiss-test');
    assert.ok(loaded);
    assert.equal(loaded.state, 'running');
    assert.equal(loaded.rounds.length, 2);

    // Continue
    const restored = Tournament.restore(loaded, createPairingStrategy(loaded.config));
    restored.recordResult(1, 0, 'black_win');
    restored.recordResult(1, 1, 'black_win');
    
    assert.equal(restored.getState(), 'finished');
    await repo.save(restored.toSnapshot());

    const list = await repo.list(10);
    const summary = list.find(l => l.id === 't-swiss-test');
    assert.ok(summary);
    assert.equal(summary.format, 'swiss');
    assert.equal(summary.state, 'finished');
    assert.equal(summary.participantCount, 4);

    // Newest first sorting
    const config2: TournamentConfig = { ...config, id: 't-swiss-test-2' };
    const t2 = new Tournament(config2, createPairingStrategy(config2));
    await repo.save(t2.toSnapshot());

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
