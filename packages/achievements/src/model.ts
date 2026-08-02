/** Tier level of an achievement. */
export type AchievementTier = 'bronze' | 'silver' | 'gold';

/** Static definition of an achievement in the catalogue. */
export interface AchievementDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: AchievementTier;
  readonly points: number;
  readonly hidden: boolean;
  readonly target?: number;
}

/** Raw achievement progress for a player. */
export interface PlayerAchievement {
  readonly playerId: string;
  readonly key: string;
  readonly progress: number;
  readonly unlockedAt?: Date;
}

/** Joined view of catalogue metadata with player progress. */
export interface PlayerAchievementView {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tier: AchievementTier;
  readonly points: number;
  readonly hidden: boolean;
  readonly target?: number;
  readonly progress: number;
  readonly unlockedAt?: Date;
}

/** Summary of a player's achievement statistics. */
export interface AchievementSummary {
  readonly unlockedCount: number;
  readonly pointsTotal: number;
}
