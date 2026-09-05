import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { PlayerCorrelationReport, StoredPlayerReport } from '@chess-platform/anti-cheat';
import type { Pool } from 'pg';
import { migrate } from '../src/pg/migrate';
import { PgAntiCheatReportRepository } from '../src/pg/anti-cheat';
import { uuidv7 } from '../src/ids';
import { withSharedDatabase } from '../src/test-support/fixtures';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = DATABASE_URL ? false : 'DATABASE_URL not set';

/**
 * Remove the reports a test wrote.
 *
 * `anti_cheat_reports` references nothing, and these tests mint fresh `uuidv7()` ids, so leaving
 * the rows behind never collided with anything — which is exactly why it went unnoticed while the
 * table grew on every run against a database anyone reuses. Fresh ids are not a substitute for
 * cleaning up; they only hide the omission.
 */
const deleteReportsForGames =
  (gameIds: readonly string[]) =>
  async (pool: Pool): Promise<void> => {
    await pool.query('DELETE FROM anti_cheat_reports WHERE game_id = ANY($1::uuid[])', [[...gameIds]]);
  };

/**
 * A correlation report whose fields are internally consistent, varying only by suspicion band.
 *
 * The numbers matter less than that they round-trip: the report is stored as JSONB, so a field
 * dropped or renamed by the mapping shows up as a mismatch rather than a type error.
 */
function makeReport(suspicion: 'clean' | 'review' | 'high' = 'clean'): PlayerCorrelationReport {
  return {
    suspicion,
    acpl: 10,
    acplCapped: 10,
    t1Rate: 0.8,
    t3Rate: 0.9,
    onlyMoveExcluded: 2,
    sampleSize: 30,
    unscored: 0,
    lowConfidence: false,
    t1Matches: 24,
    t3Matches: 27,
    tRateSampleCount: 30,
    rawCentipawnLossTotal: 300,
    cappedCentipawnLossTotal: 300,
  };
}

test('anti-cheat reports pg repository: migrate, saveBatch, listByPlayer, and upsert', { skip }, async () => {
  const gameIds: string[] = [];
  await withSharedDatabase({ cleanup: deleteReportsForGames(gameIds) }, async (pool) => {
    await migrate(pool, join(process.cwd(), 'migrations'));
    const repo = new PgAntiCheatReportRepository(pool);

    const gameId = uuidv7();
    gameIds.push(gameId);
    const whitePlayerId = uuidv7();
    const blackPlayerId = uuidv7();

    const whiteReport: StoredPlayerReport = {
      gameId,
      playerId: whitePlayerId,
      color: 'white',
      report: makeReport('clean'),
    };
    const blackReport: StoredPlayerReport = {
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
    const updatedWhiteReport: StoredPlayerReport = {
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
