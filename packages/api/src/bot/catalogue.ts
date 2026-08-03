/**
 * @packageDocumentation
 * The engine bot catalogue: single source of truth for bot accounts, levels, and playing strengths.
 */

import type { StrengthSpec } from '@chess-platform/engine';

export type BotLevel = 'novice' | 'club' | 'master';

export interface BotAccount {
  readonly level: BotLevel;
  readonly userId: string;
  readonly handle: string;
  readonly strength: StrengthSpec;
}

export const BOT_ACCOUNTS: readonly BotAccount[] = [
  {
    level: 'novice',
    userId: '00000000-0000-7000-8000-000000000001',
    handle: 'gambit-novice',
    strength: { elo: 1350 },
  },
  {
    level: 'club',
    userId: '00000000-0000-7000-8000-000000000002',
    handle: 'gambit-club',
    strength: { elo: 1750 },
  },
  {
    level: 'master',
    userId: '00000000-0000-7000-8000-000000000003',
    handle: 'gambit-master',
    strength: { elo: 2200 },
  },
];

export function botAccountByLevel(level: string): BotAccount | undefined {
  return BOT_ACCOUNTS.find((bot) => bot.level === level);
}

export function botAccountByUserId(userId: string): BotAccount | undefined {
  return BOT_ACCOUNTS.find((bot) => bot.userId === userId);
}
