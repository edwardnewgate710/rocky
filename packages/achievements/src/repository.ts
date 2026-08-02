/**
 * @packageDocumentation
 * Port definition for achievements repository implementations.
 *
 * Invariants:
 * 1. Awarding is idempotent and monotonic. Awarding a one-shot or completed achievement
 *    leaves `unlockedAt` at its original value. Progress never decreases and is clamped to `target`.
 * 2. `unlockedAt` is set exactly once, at the moment `progress` first reaches `target` — a later award
 *    must not move it.
 * 3. Unknown achievement key is rejected with `unknown_achievement`.
 * 4. A progress increment that is not a non-negative integer is rejected with `invalid_progress`.
 *    The check lives in `resolveAward` so both adapters cannot answer differently — they already had
 *    diverged on fractions, the in-memory one storing 0.5 where Postgres rounded it into an INTEGER column.
 * 5. Hidden achievements are omitted from unearned listings but always appear once earned.
 * 6. Listing a player's achievements returns catalogue metadata joined with progress,
 *    ordered by `unlockedAt` DESC (unlocked first), then by definition `key` ASC in code-point order.
 * 7. `getSummary` returns points total and count counting only unlocked achievements.
 */

import type {
  AchievementDefinition,
  AchievementSummary,
  PlayerAchievement,
  PlayerAchievementView,
} from './model';
import { ACHIEVEMENT_CATALOGUE } from './catalogue';
import { resolveAward } from './award';
import { comparePlayerAchievements } from './ordering';
import { paginate, type Page, type PageOptions } from './pagination';

export interface AchievementsRepository {
  /**
   * Increment player progress towards an achievement, unlocking it if progress reaches target.
   * Idempotent and monotonic.
   */
  award(
    playerId: string,
    key: string,
    increment?: number,
    at?: Date
  ): Promise<PlayerAchievement>;

  /**
   * List a player's achievements joined with catalogue definitions.
   * Omits unearned hidden achievements. Ordered by unlockedAt DESC, key ASC code-point.
   */
  listPlayerAchievements(
    playerId: string,
    options?: PageOptions
  ): Promise<Page<PlayerAchievementView>>;

  /**
   * Retrieve summary statistics (unlocked count and total unlocked points) for a player.
   */
  getSummary(playerId: string): Promise<AchievementSummary>;

  /**
   * Retrieve the full static catalogue of definitions.
   */
  getCatalogue(): readonly AchievementDefinition[];
}

export class InMemoryAchievementsRepository implements AchievementsRepository {
  // Store player achievements in map: `${playerId}:${key}` => PlayerAchievement
  private readonly achievements = new Map<string, PlayerAchievement>();

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

    const storageKey = `${playerId}:${key}`;
    const existing = this.achievements.get(storageKey);

    let newProgress = (existing?.progress ?? 0) + increment;
    newProgress = Math.min(target, newProgress);

    let unlockedAt = existing?.unlockedAt;
    if (!unlockedAt && newProgress >= target) {
      unlockedAt = at;
    }

    const record: PlayerAchievement = {
      playerId,
      key,
      progress: newProgress,
      ...(unlockedAt ? { unlockedAt } : {}),
    };

    this.achievements.set(storageKey, record);
    return record;
  }

  async listPlayerAchievements(
    playerId: string,
    options?: PageOptions
  ): Promise<Page<PlayerAchievementView>> {
    const items: PlayerAchievementView[] = [];

    for (const def of ACHIEVEMENT_CATALOGUE) {
      const storageKey = `${playerId}:${def.key}`;
      const record = this.achievements.get(storageKey);
      const progress = record?.progress ?? 0;
      const unlockedAt = record?.unlockedAt;

      // Rule 5: Hidden achievements omitted if unearned
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
    let unlockedCount = 0;
    let pointsTotal = 0;

    for (const def of ACHIEVEMENT_CATALOGUE) {
      const storageKey = `${playerId}:${def.key}`;
      const record = this.achievements.get(storageKey);

      if (record?.unlockedAt) {
        unlockedCount++;
        pointsTotal += def.points;
      }
    }

    return { unlockedCount, pointsTotal };
  }
}
