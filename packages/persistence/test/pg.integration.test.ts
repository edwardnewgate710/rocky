import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Game } from '@chess-platform/game';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { uuidv7 } from '../src/ids';
import { ConcurrencyError } from '../src/errors';

// Integration tests need a real Postgres. They SKIP (not fail) when DATABASE_URL
// is unset, so dependency-free suites still run everywhere (incl. CI before a DB).
const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('migrations apply and are idempotent', { skip }, async () => {
  const pool = createPool();
  try {
    const dir = join(process.cwd(), 'migrations');
    await migrate(pool, dir);
    assert.equal(await migrate(pool, dir), 0, 're-running applies nothing');
  } finally {
    await pool.end();
  }
});

test('postgres event store: round-trip and optimistic concurrency', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const store = new PostgresEventStore(pool);
    const gameId = uuidv7();
    const timeControl = { initialMs: 60_000, incrementMs: 1_000, delayMs: 0, kind: 'increment' as const };

    let { game, events } = Game.create({
      gameId,
      timeControl,
      players: { white: 'a', black: 'b' },
      rated: false,
      at: 1000,
    });
    let head = await store.append(gameId, -1, events);
    let t = 2000;
    for (const uci of ['e2e4', 'c7c5', 'g1f3']) {
      ({ game, events } = game.playMove(uci, t));
      head = await store.append(gameId, head, events);
      t += 1000;
    }

    const stored = await store.load(gameId);
    const rebuilt = Game.fromEvents(stored.map((s) => s.event));
    assert.equal(rebuilt.snapshot().position.fen(), game.snapshot().position.fen());
    assert.equal(head, stored.length - 1);

    // A second append at a stale head is rejected.
    await assert.rejects(store.append(gameId, -1, events), ConcurrencyError);
  } finally {
    await pool.end();
  }
});
