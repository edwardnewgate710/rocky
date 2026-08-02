import type { AchievementDefinition } from './model';

export const ACHIEVEMENT_CATALOGUE: readonly AchievementDefinition[] = [
  // --- Category: games ---
  {
    key: 'first-game',
    name: 'First Moves',
    description: 'Play your first chess game.',
    category: 'games',
    tier: 'bronze',
    points: 10,
    hidden: false,
    target: 1,
  },
  {
    key: 'games-10',
    name: 'Getting Started',
    description: 'Play 10 chess games.',
    category: 'games',
    tier: 'bronze',
    points: 25,
    hidden: false,
    target: 10,
  },
  {
    key: 'games-50',
    name: 'Club Player',
    description: 'Play 50 chess games.',
    category: 'games',
    tier: 'silver',
    points: 50,
    hidden: false,
    target: 50,
  },
  {
    key: 'games-100',
    name: 'Century',
    description: 'Play 100 chess games.',
    category: 'games',
    tier: 'gold',
    points: 100,
    hidden: false,
    target: 100,
  },

  // --- Category: wins ---
  {
    key: 'first-win',
    name: 'Victory',
    description: 'Win your first game.',
    category: 'wins',
    tier: 'bronze',
    points: 10,
    hidden: false,
    target: 1,
  },
  {
    key: 'wins-10',
    name: 'Winner',
    description: 'Win 10 games.',
    category: 'wins',
    tier: 'silver',
    points: 50,
    hidden: false,
    target: 10,
  },
  {
    key: 'wins-50',
    name: 'Master of the Board',
    description: 'Win 50 games.',
    category: 'wins',
    tier: 'gold',
    points: 100,
    hidden: false,
    target: 50,
  },

  // Win streaks are deliberately NOT in this catalogue. See ADR-0070: a streak is a value that must
  // be SET, because it resets to zero on a loss, and `award` only adds. Listing achievements nobody
  // can ever earn is worse than not listing them.

  // --- Category: speed & length ---
  {
    key: 'speed-demon',
    name: 'Speed Demon',
    description: 'Win a bullet or blitz game.',
    category: 'speed',
    tier: 'bronze',
    points: 15,
    hidden: false,
    target: 1,
  },
  {
    key: 'marathon',
    name: 'Marathoner',
    description: 'Play a game lasting 100 or more plies.',
    category: 'games',
    tier: 'silver',
    points: 25,
    hidden: false,
    target: 1,
  },
  {
    key: 'quick-win',
    name: 'Quick Victory',
    description: 'Win a game in 30 plies or fewer.',
    category: 'wins',
    tier: 'gold',
    points: 50,
    hidden: false,
    target: 1,
  },

  // --- Category: catalogue-only (future / external triggers) ---
  {
    key: 'tournament-champion',
    name: 'Tournament Champion',
    description: 'Win a tournament.',
    category: 'tournaments',
    tier: 'gold',
    points: 100,
    hidden: false,
    target: 1,
  },
  {
    key: 'socialite',
    name: 'Social Butterfly',
    description: 'Join a team.',
    category: 'social',
    tier: 'bronze',
    points: 15,
    hidden: false,
    target: 1,
  },
  {
    key: 'secret-master',
    name: 'Secret Master',
    description: 'Achieve secret mastery on the platform.',
    category: 'special',
    tier: 'gold',
    points: 150,
    hidden: true,
    target: 1,
  },
];

const catalogueByKey = new Map<string, AchievementDefinition>(
  ACHIEVEMENT_CATALOGUE.map((def) => [def.key, def])
);

/** Look up an achievement definition by key. */
export function getAchievementDefinition(key: string): AchievementDefinition | undefined {
  return catalogueByKey.get(key);
}

/** Get public achievement definitions (excluding unearned hidden ones). */
export function getPublicCatalogue(): readonly AchievementDefinition[] {
  return ACHIEVEMENT_CATALOGUE.filter((def) => !def.hidden);
}
