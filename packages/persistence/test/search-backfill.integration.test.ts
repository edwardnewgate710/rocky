import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPool } from '../src/pg/pool';
import { migrate } from '../src/pg/migrate';
import { PgSearchBackfillSource } from '../src/pg/search-backfill';
import { uuidv7 } from '../src/ids';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

test('pg search backfill source: keyset pagination, user handle JOIN, and entity mapping', { skip }, async () => {
  const pool = createPool();

  const userId1 = uuidv7();
  const userId2 = uuidv7();
  const gameId1 = uuidv7();
  const tournamentId1 = `t-backfill-test-${uuidv7()}`;

  try {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const backfill = new PgSearchBackfillSource(pool);

    // 1. Insert test users
    await pool.query(
      `INSERT INTO users (id, handle, country) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [userId1, 'backfill_white', 'US', userId2, 'backfill_black', 'NO']
    );

    // 2. Insert test game
    await pool.query(
      `INSERT INTO games (id, variant, rated, speed, white_id, black_id, opening_eco, result, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [gameId1, 'standard', true, 'blitz', userId1, userId2, 'B90', '1-0']
    );

    // 3. Insert test tournament
    await pool.query(
      `INSERT INTO tournaments (id, name, format, state, snapshot)
       VALUES ($1, $2, $3, $4, '{}'::jsonb)`,
      [tournamentId1, 'Backfill Test Arena', 'arena', 'running']
    );

    // Helper to fetch all pages until specific IDs are found (cursor-safe across existing DB rows)
    const findSeededPlayer = async (id: string) => {
      let cursor: string | null = null;
      while (true) {
        const page = await backfill.listPlayers(cursor, 50);
        if (page.length === 0) return null;
        const match = page.find((p) => p.id === id);
        if (match) return match;
        cursor = page[page.length - 1].id;
      }
    };

    const foundPlayer1 = await findSeededPlayer(userId1);
    const foundPlayer2 = await findSeededPlayer(userId2);
    assert.ok(foundPlayer1);
    assert.strictEqual(foundPlayer1.handle, 'backfill_white');
    assert.strictEqual(foundPlayer1.country, 'US');
    assert.ok(foundPlayer2);
    assert.strictEqual(foundPlayer2.handle, 'backfill_black');
    assert.strictEqual(foundPlayer2.country, 'NO');

    // Verify listGames with JOINed handles
    const findSeededGame = async (id: string) => {
      let cursor: string | null = null;
      while (true) {
        const page = await backfill.listGames(cursor, 50);
        if (page.length === 0) return null;
        const match = page.find((g) => g.id === id);
        if (match) return match;
        cursor = page[page.length - 1].id;
      }
    };

    const foundGame = await findSeededGame(gameId1);
    assert.ok(foundGame);
    assert.strictEqual(foundGame.whiteHandle, 'backfill_white');
    assert.strictEqual(foundGame.blackHandle, 'backfill_black');
    assert.strictEqual(foundGame.variant, 'standard');
    assert.strictEqual(foundGame.speed, 'blitz');
    assert.strictEqual(foundGame.result, '1-0');
    assert.strictEqual(foundGame.rated, true);
    assert.strictEqual(foundGame.eco, 'B90');

    // Verify listTournaments
    const findSeededTournament = async (id: string) => {
      let cursor: string | null = null;
      while (true) {
        const page = await backfill.listTournaments(cursor, 50);
        if (page.length === 0) return null;
        const match = page.find((t) => t.id === id);
        if (match) return match;
        cursor = page[page.length - 1].id;
      }
    };

    const foundTourn = await findSeededTournament(tournamentId1);
    assert.ok(foundTourn);
    assert.strictEqual(foundTourn.name, 'Backfill Test Arena');
    assert.strictEqual(foundTourn.format, 'arena');
    assert.strictEqual(foundTourn.state, 'running');

    // Verify keyset pagination with limit 1
    const pPage1 = await backfill.listPlayers(null, 1);
    assert.strictEqual(pPage1.length, 1);
    const pPage2 = await backfill.listPlayers(pPage1[0].id, 1);
    assert.strictEqual(pPage2.length, 1);
    assert.notStrictEqual(pPage2[0].id, pPage1[0].id);

  } finally {
    // Scoped cleanup
    await pool.query('DELETE FROM games WHERE id = $1', [gameId1]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [userId1, userId2]);
    await pool.query('DELETE FROM tournaments WHERE id = $1', [tournamentId1]);
    await pool.end();
  }
});
