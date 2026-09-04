import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { BotBehaviorReport, StoredBotReport } from '@chess-platform/anti-cheat';
import type { Pool } from 'pg';
import { migrate } from '../src/pg/migrate';
import { PgBotBehaviorReportRepository } from '../src/pg/bot-reports';
import { uuidv7 } from '../src/ids';
import { withSharedDatabase } from '../src/test-support/fixtures';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

function makeReport(suspicion: 'clean' | 'review' | 'high' = 'clean'): BotBehaviorReport {
  return {
    suspicion,
    sampleSize: 15,
    meanMs: 2000,
    stdevMs: 1000,
    coefficientOfVariation: 0.5,
    instantMoves: 0,
    instantFraction: 0,
    sumMs: 30000,
    sumSqMs: 75000000,
    lowConfidence: false,
  };
}

/**
 * Remove the reports a test wrote. `bot_reports` references nothing and the ids are freshly
 * minted, so the leak was silent: the table simply grew on every run against a reused database.
 */
const deleteReportsForGames =
  (gameIds: readonly string[]) =>
  async (pool: Pool): Promise<void> => {
    await pool.query('DELETE FROM bot_reports WHERE game_id = ANY($1::uuid[])', [[...gameIds]]);
  };

test('bot reports pg repository: migrate, saveBatch, listByPlayer, and upsert', { skip }, async () => {
  const gameIds: string[] = [];
  await withSharedDatabase({ cleanup: deleteReportsForGames(gameIds) }, async (pool) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const repo = new PgBotBehaviorReportRepository(pool);

    const gameId = uuidv7();
    gameIds.push(gameId);
    const whitePlayerId = uuidv7();
    const blackPlayerId = uuidv7();

    const whiteReport: StoredBotReport = {
      gameId,
      playerId: whitePlayerId,
      color: 'white',
      report: makeReport('clean'),
    };
    const blackReport: StoredBotReport = {
      gameId,
      playerId: blackPlayerId,
      color: 'black',
      report: makeReport('review'),
    };

    // Save batch for both players
    await repo.saveBatch([whiteReport, blackReport]);

    // List by player
    const whiteStored = await repo.listByPlayer(whitePlayerId);
    assert.equal(whiteStored.length, 1);
    assert.equal(whiteStored[0]?.gameId, gameId);
    assert.equal(whiteStored[0]?.playerId, whitePlayerId);
    assert.equal(whiteStored[0]?.color, 'white');
    assert.equal(whiteStored[0]?.report.suspicion, 'clean');

    const blackStored = await repo.listByPlayer(blackPlayerId);
    assert.equal(blackStored.length, 1);
    assert.equal(blackStored[0]?.gameId, gameId);
    assert.equal(blackStored[0]?.playerId, blackPlayerId);
    assert.equal(blackStored[0]?.color, 'black');
    assert.equal(blackStored[0]?.report.suspicion, 'review');

    // Re-save white player with updated report (upsert test)
    const updatedWhiteReport: StoredBotReport = {
      gameId,
      playerId: whitePlayerId,
      color: 'white',
      report: makeReport('high'),
    };
    await repo.saveBatch([updatedWhiteReport]);

    const whiteStoredUpdated = await repo.listByPlayer(whitePlayerId);
    assert.equal(whiteStoredUpdated.length, 1, 'upsert replaces prior record, does not duplicate');
    assert.equal(whiteStoredUpdated[0]?.report.suspicion, 'high');
  });
});
