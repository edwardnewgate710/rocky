import type { TiebreakKey } from './config';

/**
 * The possible results of a game pairing.
 */
export type GameResult = 'white_win' | 'black_win' | 'draw' | 'double_forfeit';

/**
 * A single player's performance in the tournament.
 */
export interface PlayerStanding {
  readonly playerId: string;
  readonly points: number;
  readonly tiebreak: number; // Sonneborn-Berger
  readonly buchholz: number;
  readonly medianBuchholz: number;
  readonly gamesPlayed: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly byes: number;
  readonly withdrawn: boolean;
}

const DEFAULT_TIEBREAK_ORDER: readonly TiebreakKey[] = ['sonneborn_berger', 'buchholz', 'median_buchholz'];

/**
 * Computes the standings for a set of players given the round results.
 * 
 * Scoring: Win = 1, Draw = 0.5, Loss = 0, Bye = 1.
 * Double Forfeit = 0 for both. Void = 0 for both (e.g. voided bye).
 */
export function computeStandings(
  participants: readonly string[],
  results: ReadonlyMap<string, GameResult | 'bye' | 'void'>,
  pairingsByMatchId: ReadonlyMap<string, { p1: string; p2: string | null }>,
  tiebreakOrder: readonly TiebreakKey[] = DEFAULT_TIEBREAK_ORDER,
  withdrawn: ReadonlySet<string> = new Set()
): PlayerStanding[] {
  // 1. Initialize stats
  const stats = new Map<string, {
    points: number;
    gamesPlayed: number;
    wins: number;
    draws: number;
    losses: number;
    byes: number;
    opponents: string[];
    defeatedOpponents: string[];
    drawnOpponents: string[];
  }>();

  for (const p of participants) {
    stats.set(p, {
      points: 0,
      gamesPlayed: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      byes: 0,
      opponents: [],
      defeatedOpponents: [],
      drawnOpponents: []
    });
  }

  // 2. Tally base points and record opponent histories
  for (const [matchId, result] of results.entries()) {
    const pairing = pairingsByMatchId.get(matchId);
    if (!pairing) continue;

    const p1 = pairing.p1;
    const p2 = pairing.p2;
    const s1 = stats.get(p1);

    if (result === 'bye' || result === 'void') {
      if (s1 && result === 'bye') {
        s1.points += 1;
        s1.byes += 1;
      }
      continue;
    }

    if (!p2) continue;
    const s2 = stats.get(p2);
    if (!s1 || !s2) continue;

    s1.gamesPlayed += 1;
    s2.gamesPlayed += 1;
    s1.opponents.push(p2);
    s2.opponents.push(p1);

    if (result === 'white_win') {
      s1.points += 1;
      s1.wins += 1;
      s2.losses += 1;
      s1.defeatedOpponents.push(p2);
    } else if (result === 'black_win') {
      s2.points += 1;
      s2.wins += 1;
      s1.losses += 1;
      s2.defeatedOpponents.push(p1);
    } else if (result === 'draw') {
      s1.points += 0.5;
      s2.points += 0.5;
      s1.draws += 1;
      s2.draws += 1;
      s1.drawnOpponents.push(p2);
      s2.drawnOpponents.push(p1);
    } else if (result === 'double_forfeit') {
      s1.losses += 1;
      s2.losses += 1;
    }
  }

  // 3. Compute tiebreaks
  const standings: PlayerStanding[] = [];
  for (const p of participants) {
    const s = stats.get(p)!;
    
    // Sonneborn-Berger
    let sb = 0;
    for (const opp of s.defeatedOpponents) {
      sb += stats.get(opp)!.points;
    }
    for (const opp of s.drawnOpponents) {
      sb += stats.get(opp)!.points * 0.5;
    }

    // Buchholz and Median-Buchholz
    const oppPoints = s.opponents.map(opp => stats.get(opp)!.points);
    let buchholz = 0;
    let medianBuchholz = 0;

    for (const pt of oppPoints) {
      buchholz += pt;
    }

    if (oppPoints.length >= 3) {
      const sorted = [...oppPoints].sort((a, b) => a - b);
      sorted.pop(); // remove max
      sorted.shift(); // remove min
      for (const pt of sorted) {
        medianBuchholz += pt;
      }
    } else {
      medianBuchholz = buchholz;
    }

    standings.push({
      playerId: p,
      points: s.points,
      tiebreak: sb,
      buchholz,
      medianBuchholz,
      gamesPlayed: s.gamesPlayed,
      wins: s.wins,
      draws: s.draws,
      losses: s.losses,
      byes: s.byes,
      withdrawn: withdrawn.has(p)
    });
  }

  // 4. Sort standings
  standings.sort((a, b) => {
    // 1. Points descending
    if (a.points !== b.points) {
      return b.points - a.points;
    }
    
    // 2. Dynamic tiebreaks
    for (const key of tiebreakOrder) {
      if (key === 'sonneborn_berger' && a.tiebreak !== b.tiebreak) return b.tiebreak - a.tiebreak;
      if (key === 'buchholz' && a.buchholz !== b.buchholz) return b.buchholz - a.buchholz;
      if (key === 'median_buchholz' && a.medianBuchholz !== b.medianBuchholz) return b.medianBuchholz - a.medianBuchholz;
    }

    // 3. Deterministic fallback (alphabetical by ID)
    return a.playerId.localeCompare(b.playerId);
  });

  return standings;
}
