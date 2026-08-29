import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Game } from '@chess-platform/game';
import { createPool } from '../src/pg/pool';
import { migrate, migrationChecksum, readMigrationSql } from '../src/pg/migrate';
import { PostgresEventStore } from '../src/pg/event-store';
import { PgGamesRepository, PgSeeksRepository, PgSeekAcceptor, PgGameStarter, PgUsersRepository } from '../src/pg/repositories';
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

    const index = await pool.query<{
      indisvalid: boolean;
      columns: string;
      definition: string;
      predicate: string;
    }>(
      `SELECT i.indisvalid,
              array_to_string(ARRAY(
                SELECT a.attname
                  FROM unnest(i.indkey) WITH ORDINALITY AS indexed_column(attnum, position)
                  JOIN pg_attribute a
                    ON a.attrelid = i.indrelid AND a.attnum = indexed_column.attnum
                 ORDER BY indexed_column.position
              ), ',') AS columns,
              pg_get_indexdef(i.indexrelid) AS definition,
              pg_get_expr(i.indpred, i.indrelid) AS predicate
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'community_join_requests_pending_by_player_idx'`,
    );
    assert.equal(index.rows[0]?.indisvalid, true);
    assert.equal(index.rows[0]?.columns, 'player_id,created_at,id');
    assert.match(index.rows[0]?.definition ?? '', /\(player_id, created_at DESC, id\)/);
    assert.match(index.rows[0]?.predicate ?? '', /status/);
    assert.match(index.rows[0]?.predicate ?? '', /'pending'/);

    assert.equal(await migrate(pool, dir), 0, 're-running applies nothing');

    await pool.query("UPDATE schema_migrations SET state = 'pending' WHERE version = 23");
    assert.equal(await migrate(pool, dir), 1, 're-running completes an interrupted online index');
    const migration = await pool.query<{ state: string }>(
      'SELECT state FROM schema_migrations WHERE version = 23',
    );
    assert.equal(migration.rows[0]?.state, 'applied');
  } finally {
    await pool.end();
  }
});

test('the ledger is portable across checkouts but still rejects edits', { skip }, async () => {
  const pool = createPool();
  const dir = join(process.cwd(), 'migrations');
  const file = '0023_community_pending_join_requests_index.sql';
  const version = 23;
  const canonical = migrationChecksum(readMigrationSql(dir, file));
  const readChecksum = async (): Promise<string | undefined> =>
    (
      await pool.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE version = $1',
        [version],
      )
    ).rows[0]?.checksum;
  let ledgerMutated = false;
  const setChecksum = async (checksum: string): Promise<void> => {
    ledgerMutated = true;
    await pool.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [
      version,
      checksum,
    ]);
  };

  try {
    await migrate(pool, dir);
    assert.equal(await readChecksum(), canonical, 'a fresh run records the canonical checksum');

    // A ledger written by the pre-canonicalization runner on a Windows checkout
    // holds the CRLF rendering of this very file. That is the same migration, so
    // the run must succeed — and converge the row onto the canonical checksum.
    const legacyCrlf = createHash('sha256')
      .update(readMigrationSql(dir, file).replace(/\n/g, '\r\n'), 'utf8')
      .digest('hex');
    assert.notEqual(legacyCrlf, canonical, 'the CRLF rendering must differ, or this proves nothing');

    await setChecksum(legacyCrlf);
    assert.equal(await migrate(pool, dir), 0, 'a CRLF-era ledger applies nothing');
    assert.equal(await readChecksum(), canonical, 'the legacy checksum is healed in place');

    // An actual edit to an applied migration matches neither rendering.
    await setChecksum(createHash('sha256').update('edited migration', 'utf8').digest('hex'));
    await assert.rejects(migrate(pool, dir), /changed after being applied; history is immutable/);
  } finally {
    // Restore only what this test actually changed: if the first migrate() threw
    // before schema_migrations existed, an UPDATE here would throw too and bury
    // the real failure. Never let the restore leak the pool either — every later
    // integration file migrates against this same database.
    try {
      if (ledgerMutated) await setChecksum(canonical);
    } finally {
      await pool.end();
    }
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

test('postgres games repository treats a malformed public id as not found', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const games = new PgGamesRepository(pool);
    assert.equal(await games.findById('not-a-uuid'), null);
  } finally {
    await pool.end();
  }
});

test('postgres seek acceptance: optimistic concurrency', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const seeks = new PgSeeksRepository(pool);
    const acceptor = new PgSeekAcceptor(pool);
    const users = new PgUsersRepository(pool);

    const creatorId = uuidv7();
    const p2Id = uuidv7();
    const p3Id = uuidv7();
    await users.createWithPasswordAndRole({ id: creatorId, handle: `creator-${creatorId.slice(0, 8)}` }, 'hash', 'user');
    await users.createWithPasswordAndRole({ id: p2Id, handle: `p2-${p2Id.slice(0, 8)}` }, 'hash', 'user');
    await users.createWithPasswordAndRole({ id: p3Id, handle: `p3-${p3Id.slice(0, 8)}` }, 'hash', 'user');

    const seekId = uuidv7();
    await seeks.create({
      id: seekId,
      creatorId,
      variant: 'standard',
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      rated: false,
      color: 'random',
      minRating: null,
      maxRating: null,
    });

    const gameId1 = uuidv7();
    const gameId2 = uuidv7();
    const startedAt1 = Date.now();
    const startedAt2 = startedAt1 + 1;
    const { events: events1 } = Game.create({
      gameId: gameId1,
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      players: { white: creatorId, black: p2Id },
      rated: false,
      at: startedAt1,
    });
    const { events: events2 } = Game.create({
      gameId: gameId2,
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      players: { white: creatorId, black: p3Id },
      rated: false,
      at: startedAt2,
    });

    const accept1 = acceptor.accept(seekId, gameId1, events1, {
      id: gameId1,
      variant: 'standard',
      rated: false,
      speed: 'blitz',
      whiteId: creatorId,
      blackId: p2Id,
      startedAt: new Date(startedAt1),
    });

    const accept2 = acceptor.accept(seekId, gameId2, events2, {
      id: gameId2,
      variant: 'standard',
      rated: false,
      speed: 'blitz',
      whiteId: creatorId,
      blackId: p3Id,
      startedAt: new Date(startedAt2),
    });

    const [res1, res2] = await Promise.all([accept1, accept2]);

    const successes = [res1, res2].filter(r => r !== null);
    assert.equal(successes.length, 1, 'exactly one accept must succeed');
    
    const successRes = successes[0]!;
    const winningGameId = successRes.gameId;

    const gameRes = await pool.query('SELECT * FROM games WHERE id = $1', [winningGameId]);
    assert.equal(gameRes.rowCount, 1, 'exactly one game should exist');

    const eventsRes = await pool.query('SELECT * FROM game_events WHERE game_id = $1', [winningGameId]);
    assert.ok(eventsRes.rowCount! > 0, 'game events should exist');

    const losingGameId = res1 === null ? gameId1 : gameId2;
    const orphanGame = await pool.query('SELECT * FROM games WHERE id = $1', [losingGameId]);
    assert.equal(orphanGame.rowCount, 0, 'no orphan game should exist');
    const orphanEvents = await pool.query('SELECT * FROM game_events WHERE game_id = $1', [losingGameId]);
    assert.equal(orphanEvents.rowCount, 0, 'no orphan events should exist');

    // Cancellation uses the same open-row predicate as acceptance. Whichever
    // operation obtains the row first wins, and an accepted receipt is never deleted.
    const cancelSeekId = uuidv7();
    const cancelGameId = uuidv7();
    const cancelStartedAt = Date.now();
    await seeks.create({
      id: cancelSeekId,
      creatorId,
      variant: 'standard',
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      rated: false,
      color: 'white',
      minRating: null,
      maxRating: null,
    });
    const { events: cancelEvents } = Game.create({
      gameId: cancelGameId,
      timeControl: { initialMs: 180000, incrementMs: 2000, delayMs: 0, kind: 'increment' },
      players: { white: creatorId, black: p2Id },
      rated: false,
      at: cancelStartedAt,
    });

    const [removed, accepted] = await Promise.all([
      seeks.remove(cancelSeekId),
      acceptor.accept(cancelSeekId, cancelGameId, cancelEvents, {
        id: cancelGameId,
        variant: 'standard',
        rated: false,
        speed: 'blitz',
        whiteId: creatorId,
        blackId: p2Id,
        startedAt: new Date(cancelStartedAt),
      }),
    ]);
    assert.equal(Number(removed) + Number(accepted !== null), 1, 'cancel or accept must win, never both');

    const finalSeek = await seeks.findById(cancelSeekId);
    const finalGame = await pool.query('SELECT id FROM games WHERE id = $1', [cancelGameId]);
    const finalEvents = await pool.query('SELECT game_id FROM game_events WHERE game_id = $1', [cancelGameId]);
    if (accepted) {
      assert.equal(removed, false);
      assert.equal(finalSeek?.gameId, cancelGameId);
      assert.equal(finalGame.rowCount, 1);
      assert.ok(finalEvents.rowCount! > 0);
    } else {
      assert.equal(removed, true);
      assert.equal(finalSeek, null);
      assert.equal(finalGame.rowCount, 0);
      assert.equal(finalEvents.rowCount, 0);
    }
  } finally {
    await pool.end();
  }
});

test('PgGameStarter: creates game and handles duplicate id cleanly', { skip }, async () => {
  const pool = createPool();
  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const starter = new PgGameStarter(pool);
    const users = new PgUsersRepository(pool);

    const u1 = uuidv7();
    const u2 = uuidv7();
    // Distinct prefixes, like every other test here: uuidv7 leads with a millisecond timestamp,
    // so two ids minted in the same millisecond share their first 8 hex characters and a shared
    // prefix would collide on the UNIQUE handle.
    await users.create({ id: u1, handle: `white-${u1.slice(0, 8)}` });
    await users.create({ id: u2, handle: `black-${u2.slice(0, 8)}` });

    const gameId = uuidv7();
    const timeControl = { initialMs: 60_000, incrementMs: 1_000, delayMs: 0, kind: 'increment' as const };
    const { events } = Game.create({
      gameId,
      timeControl,
      players: { white: u1, black: u2 },
      rated: false,
      at: 1000,
    });

    const gameStart = {
      id: gameId,
      variant: 'standard' as const,
      rated: false,
      speed: 'blitz' as const,
      whiteId: u1,
      blackId: u2,
      startedAt: new Date(1000),
    };

    const first = await starter.start(gameId, events, gameStart);
    assert.equal(first, true);

    const second = await starter.start(gameId, events, gameStart);
    assert.equal(second, false, 'duplicate gameId must return false without throwing');
  } finally {
    await pool.end();
  }
});

