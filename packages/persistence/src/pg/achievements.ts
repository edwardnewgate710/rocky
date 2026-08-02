/**
 * @packageDocumentation
 * PostgreSQL implementation of AchievementsRepository from @chess-platform/achievements.
 */
import type { Pool } from 'pg';
import type {
  AchievementDefinition,
  AchievementsRepository,
  AchievementSummary,
  PlayerAchievement,
  PlayerAchievementView,
  Page,
  PageOptions,
} from '@chess-platform/achievements';
import {
  ACHIEVEMENT_CATALOGUE,
  AchievementRuleError,
  comparePlayerAchievements,
  getAchievementDefinition,
  paginate,
  resolveAward,
} from '@chess-platform/achievements';
import { isForeignKeyViolation, isInvalidTextRepresentation } from './sqlstate';

interface AchievementRow {
  player_id: string;
  achievement_key: string;
  progress: number;
  unlocked_at: Date | null;
}

export class PgAchievementsRepository implements AchievementsRepository {
  constructor(private readonly pool: Pool) {}

  getCatalogue(): readonly AchievementDefinition[] {
    return ACHIEVEMENT_CATALOGUE;
  }

  async award(
    playerId: string,
    key: string,
    increment = 1,
    at = new Date()
  ): Promise<PlayerAchievement> {
    const { target } = resolveAward(key, increment);

    try {
      const res = await this.pool.query<AchievementRow>(
        `INSERT INTO achievement_progress (player_id, achievement_key, progress, unlocked_at)
         VALUES ($1, $2, LEAST($3::integer, $4::integer), CASE WHEN $4::integer >= $3::integer THEN $5::timestamptz ELSE NULL END)
         ON CONFLICT (player_id, achievement_key) DO UPDATE SET
           progress = LEAST($3::integer, achievement_progress.progress + EXCLUDED.progress),
           unlocked_at = COALESCE(
             achievement_progress.unlocked_at,
             CASE WHEN (achievement_progress.progress + EXCLUDED.progress) >= $3::integer THEN $5::timestamptz ELSE NULL END
           )
         RETURNING player_id, achievement_key, progress, unlocked_at`,
        [playerId, key, target, increment, at]
      );

      const row = res.rows[0];
      return {
        playerId: row.player_id,
        key: row.achievement_key,
        progress: row.progress,
        ...(row.unlocked_at ? { unlockedAt: new Date(row.unlocked_at) } : {}),
      };
    } catch (err) {
      if (isForeignKeyViolation(err) || isInvalidTextRepresentation(err)) {
        throw new AchievementRuleError('not_found', `Player '${playerId}' not found`);
      }
      throw err;
    }
  }

  async listPlayerAchievements(
    playerId: string,
    options?: PageOptions
  ): Promise<Page<PlayerAchievementView>> {
    let rows: AchievementRow[];
    try {
      const res = await this.pool.query<AchievementRow>(
        `SELECT player_id, achievement_key, progress, unlocked_at
         FROM achievement_progress
         WHERE player_id = $1`,
        [playerId]
      );
      rows = res.rows;
    } catch (err) {
      if (isInvalidTextRepresentation(err)) {
        throw new AchievementRuleError('not_found', `Player '${playerId}' not found`);
      }
      throw err;
    }

    const rowMap = new Map<string, AchievementRow>(
      rows.map((r) => [r.achievement_key, r])
    );

    const items: PlayerAchievementView[] = [];
    for (const def of ACHIEVEMENT_CATALOGUE) {
      const row = rowMap.get(def.key);
      const progress = row?.progress ?? 0;
      const unlockedAt = row?.unlocked_at ? new Date(row.unlocked_at) : undefined;

      if (def.hidden && !unlockedAt) {
        continue;
      }

      items.push({
        key: def.key,
        name: def.name,
        description: def.description,
        category: def.category,
        tier: def.tier,
        points: def.points,
        hidden: def.hidden,
        ...(def.target !== undefined ? { target: def.target } : {}),
        progress,
        ...(unlockedAt ? { unlockedAt } : {}),
      });
    }

    items.sort(comparePlayerAchievements);
    return paginate(items, options);
  }

  async getSummary(playerId: string): Promise<AchievementSummary> {
    let rows: AchievementRow[];
    try {
      const res = await this.pool.query<AchievementRow>(
        `SELECT player_id, achievement_key, progress, unlocked_at
         FROM achievement_progress
         WHERE player_id = $1`,
        [playerId]
      );
      rows = res.rows;
    } catch (err) {
      if (isInvalidTextRepresentation(err)) {
        throw new AchievementRuleError('not_found', `Player '${playerId}' not found`);
      }
      throw err;
    }

    let unlockedCount = 0;
    let pointsTotal = 0;

    for (const row of rows) {
      if (row.unlocked_at) {
        const def = getAchievementDefinition(row.achievement_key);
        if (def) {
          unlockedCount++;
          pointsTotal += def.points;
        }
      }
    }

    return { unlockedCount, pointsTotal };
  }
}
