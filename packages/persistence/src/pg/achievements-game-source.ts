/**
 * @packageDocumentation
 * PostgreSQL reader for finished games used by AchievementsAwardWorker.
 */
import type { Pool } from 'pg';
import type { FinishedGameSummary } from '@chess-platform/achievements';

export interface AchievementsGameSource {
  findGame(gameId: string): Promise<FinishedGameSummary | null>;
}

export class PgAchievementsGameSource implements AchievementsGameSource {
  constructor(private readonly pool: Pool) {}

  /**
   * Returns `null` only when the game genuinely cannot be awarded — no such row, or a game with a
   * seat unfilled. Everything else is raised.
   *
   * The distinction matters because the worker reads `null` as "nothing to do here" and moves on
   * without reporting anything. A `catch { return null }` around the whole query therefore turns a
   * database outage into silence: awarding stops for every finished game and no log says so. The
   * worker's own error containment is what keeps a failure here from touching the game pipeline —
   * this method's job is to tell it there was one.
   */
  async findGame(gameId: string): Promise<FinishedGameSummary | null> {
    {
      const res = await this.pool.query<{
        id: string;
        white_id: string | null;
        black_id: string | null;
        result: string | null;
        speed: string;
        ply_count: number;
      }>(
        `SELECT id::text AS id, white_id::text AS white_id, black_id::text AS black_id, result, speed, ply_count
         FROM games
         WHERE id = $1::uuid`,
        [gameId]
      );

      if (res.rows.length === 0) {
        return null;
      }

      const row = res.rows[0];
      if (!row.white_id || !row.black_id) {
        return null;
      }

      const whitePlayerId = row.white_id;
      const blackPlayerId = row.black_id;
      const result = row.result ?? '*';

      let winnerPlayerId: string | undefined = undefined;
      if (result === '1-0') winnerPlayerId = whitePlayerId;
      else if (result === '0-1') winnerPlayerId = blackPlayerId;

      return {
        gameId: row.id,
        whitePlayerId,
        blackPlayerId,
        winnerPlayerId,
        result,
        speed: row.speed,
        plyCount: row.ply_count,
      };
    }
  }
}
