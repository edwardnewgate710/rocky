/**
 * Engine bot difficulty levels metadata and resolution.
 *
 * Pure and DOM-free: exports the available bot difficulties for display in the
 * lobby dialog and provides string parsing with safe fallbacks.
 */
import type { BotLevel } from '../api/models.js';

export interface BotLevelOption {
  readonly id: BotLevel;
  readonly label: string;
  /** One short line explaining who this opponent suits. */
  readonly blurb: string;
}

export const BOT_LEVELS: readonly BotLevelOption[] = [
  {
    id: 'novice',
    label: 'Novice',
    blurb: 'Makes frequent tactical errors. Best for beginners learning basic patterns.',
  },
  {
    id: 'club',
    label: 'Club',
    blurb: 'Plays solid tactical moves with occasional inaccuracies. Suitable for casual players.',
  },
  {
    id: 'master',
    label: 'Master',
    blurb: 'Strong tactical calculation and positional play. A challenging test.',
  },
];

export const DEFAULT_BOT_LEVEL: BotLevel = 'club';

export function parseBotLevel(raw: string | null): BotLevel {
  if (!raw) return DEFAULT_BOT_LEVEL;
  const match = BOT_LEVELS.find((opt) => opt.id === raw);
  return match ? match.id : DEFAULT_BOT_LEVEL;
}
