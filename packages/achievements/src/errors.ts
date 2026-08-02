export type AchievementErrorCode =
  | 'unknown_achievement'
  | 'invalid_progress'
  | 'not_found';

export class AchievementRuleError extends Error {
  constructor(
    public readonly code: AchievementErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AchievementRuleError';
  }
}
