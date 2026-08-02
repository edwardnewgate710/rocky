import { getAchievementDefinition } from './catalogue';

/** A game long enough to count as a marathon: 100 plies is 50 moves each side. */
const MARATHON_MIN_PLIES = 100;

/** A win inside 15 moves each side. */
const QUICK_WIN_MAX_PLIES = 30;

export interface FinishedGameSummary {
  readonly gameId: string;
  readonly whitePlayerId: string;
  readonly blackPlayerId: string;
  readonly winnerPlayerId?: string | null;
  readonly result: string;
  readonly speed?: string;
  readonly plyCount?: number;
}

export interface PlayerStateForEvaluation {
  readonly playerId: string;
  readonly existingAchievements: ReadonlyMap<string, { readonly progress: number; readonly unlockedAt?: Date }>;
}

export interface AwardIntent {
  readonly playerId: string;
  readonly achievementKey: string;
  readonly increment: number;
}

/**
 * Pure evaluation function that determines which achievement awards to apply
 * when a game ends. Free of I/O, randomness, or wall-clock Date reads.
 */
export function evaluateGameAchievements(
  game: FinishedGameSummary,
  playerState: PlayerStateForEvaluation
): readonly AwardIntent[] {
  // Aborted games yield no awards.
  if (game.result === '*') {
    return [];
  }

  const { playerId, existingAchievements } = playerState;
  const isParticipant = playerId === game.whitePlayerId || playerId === game.blackPlayerId;
  if (!isParticipant) {
    return [];
  }

  const intents: AwardIntent[] = [];
  const isWinner = game.winnerPlayerId === playerId;

  /**
   * Records one step towards `key`, unless the player already has it.
   *
   * The target is read from the catalogue rather than passed in. Written as an argument it was a
   * second copy of a number that already exists in `catalogue.ts` — so raising `games-10` to 15
   * there would silently leave this file counting to 10, and nothing would fail.
   */
  const checkAward = (key: string): void => {
    const definition = getAchievementDefinition(key);
    if (!definition) {
      // A key the catalogue does not define cannot be awarded, and the repository would reject it
      // anyway. Failing here would take down a game-ended handler over a typo in a decoration.
      return;
    }
    const state = existingAchievements.get(key);
    if (state?.unlockedAt) {
      return;
    }
    if ((state?.progress ?? 0) < (definition.target ?? 1)) {
      intents.push({ playerId, achievementKey: key, increment: 1 });
    }
  };

  // --- Games played ---
  checkAward('first-game');
  checkAward('games-10');
  checkAward('games-50');
  checkAward('games-100');

  if (game.plyCount !== undefined && game.plyCount >= MARATHON_MIN_PLIES) {
    checkAward('marathon');
  }

  // --- Wins ---
  if (isWinner) {
    checkAward('first-win');
    checkAward('wins-10');
    checkAward('wins-50');

    if (game.speed === 'bullet' || game.speed === 'blitz') {
      checkAward('speed-demon');
    }

    if (game.plyCount !== undefined && game.plyCount <= QUICK_WIN_MAX_PLIES) {
      checkAward('quick-win');
    }
  }

  // Win streaks are deliberately absent. They cannot be expressed with the award primitive this
  // package offers: `award` adds to progress, and a streak is a value that must be *set* — it
  // resets to zero on a loss, which no accumulator can express. Awarding one step per game while
  // the streak happened to be long enough would mean "win 3 in a row" unlocked after five separate
  // qualifying games, which is not the achievement it claims to be. See ADR-0070.

  return intents;
}
