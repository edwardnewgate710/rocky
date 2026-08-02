import type { AchievementDefinition } from './model';
import { getAchievementDefinition } from './catalogue';
import { AchievementRuleError } from './errors';

/**
 * Resolves an award to the definition it names and the target it counts towards, rejecting anything
 * that cannot be stored as progress.
 *
 * This lives in the domain because both adapters need the identical answer and neither can be
 * trusted to keep its own copy in step. When the check was written out twice, they had already
 * diverged on fractions: the in-memory adapter stored `progress + 0.5`, while Postgres cast the same
 * value into an `INTEGER` column and rounded it. Two adapters, two answers, from a rule that was
 * meant to be one.
 *
 * Fractions are rejected rather than rounded. Progress counts events — games, wins, days — and half
 * a game is not a smaller amount of anything, it is a caller mistake worth hearing about.
 */
export function resolveAward(
  key: string,
  increment: number
): { readonly definition: AchievementDefinition; readonly target: number } {
  const definition = getAchievementDefinition(key);
  if (!definition) {
    throw new AchievementRuleError('unknown_achievement', `Unknown achievement key '${key}'`);
  }
  // `Number.isInteger` already excludes NaN and both infinities, so it is the whole check.
  if (!Number.isInteger(increment) || increment < 0) {
    throw new AchievementRuleError(
      'invalid_progress',
      `Progress increment must be a non-negative integer, got '${increment}'`
    );
  }
  return { definition, target: definition.target ?? 1 };
}
