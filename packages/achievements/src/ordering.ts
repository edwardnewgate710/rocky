import type { PlayerAchievementView } from './model';

/**
 * Code-point string comparison rather than `localeCompare`.
 */
export function compareIds(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Player achievements ordering: `unlockedAt` DESC (unlocked first),
 * tie-broken by definition `key` ASC in code-point order.
 */
export function comparePlayerAchievements(
  a: PlayerAchievementView,
  b: PlayerAchievementView
): number {
  const aUnlocked = a.unlockedAt !== undefined;
  const bUnlocked = b.unlockedAt !== undefined;

  if (aUnlocked && !bUnlocked) return -1;
  if (!aUnlocked && bUnlocked) return 1;

  if (aUnlocked && bUnlocked) {
    const timeDiff = b.unlockedAt!.getTime() - a.unlockedAt!.getTime();
    if (timeDiff !== 0) return timeDiff;
  }

  return compareIds(a.key, b.key);
}
