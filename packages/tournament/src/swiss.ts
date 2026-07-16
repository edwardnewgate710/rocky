import type {
  GamePairing,
  Pairing,
  PairingContext,
  PairingStrategy,
  PlayerHistory,
  Round
} from './pairing';

/**
 * Deterministic Monrad/Dutch-lite Swiss pairing strategy.
 *
 * - Round 1: pair by seed (top half vs bottom half); lowest seed gets the bye
 *   when the field is odd.
 * - Later rounds: sort into score groups (points desc, seed asc), then find a
 *   COMPLETE pairing that never repeats an opponent. The pairing is a
 *   backtracking search that tries the nearest-in-score partner first, so score
 *   groups are respected while still guaranteeing every player is paired (no
 *   player is ever silently dropped from a round).
 * - Byes: if the field is odd, exactly one bye is given to the lowest-scored
 *   eligible player who has not had a bye (bye = 1 point). Bye candidates are
 *   tried in preference order until one leaves a fully pairable remainder.
 * - Colors: best-effort balancing — each player is given the colour they are
 *   "due" (has played fewer of); ties break to the higher seed getting white.
 *   NOTE: `|white − black| ≤ 1` cannot be guaranteed together with score-group
 *   integrity (two "due-black" players in the same score group must meet), so
 *   colour balance is best-effort rather than a hard invariant. See ADR-0015.
 * - Termination: returns `null` once the configured round count is reached, or
 *   earlier if the field is exhausted (no rematch-free pairing exists / no bye
 *   can be assigned), which finishes the tournament rather than emitting a
 *   malformed round.
 * - Deterministic given seeds + results (stable tie-breaking by seed index).
 */
export class SwissPairing implements PairingStrategy {
  constructor(private readonly totalRounds: number) {}

  pairNextRound(context: PairingContext): Round | null {
    const { participants, roundNumber, playerHistory } = context;

    if (participants.length < 2) {
      return null;
    }

    if (roundNumber >= this.totalRounds) {
      return null;
    }

    const pairings =
      roundNumber === 0
        ? this.buildFirstRound(participants)
        : this.buildLaterRound(participants, playerHistory);

    // A `null` result means the field is exhausted: finish the tournament
    // rather than emit a partial round that drops players.
    if (pairings === null) {
      return null;
    }

    return { roundIndex: roundNumber, pairings };
  }

  /**
   * Round 1: pair by seed — top half vs bottom half (seed i vs seed ⌈N/2⌉+i).
   * The higher seed (lower index) gets white. When the field is odd the lowest
   * seed receives the bye.
   */
  private buildFirstRound(participants: readonly string[]): Pairing[] {
    const pairings: Pairing[] = [];
    let pool: readonly string[] = participants;

    if (pool.length % 2 !== 0) {
      // Lowest seed (last in seed order) takes the bye.
      pairings.push({ kind: 'bye', player: pool[pool.length - 1] });
      pool = pool.slice(0, -1);
    }

    const half = pool.length / 2;
    for (let i = 0; i < half; i++) {
      pairings.push({ kind: 'game', white: pool[i], black: pool[half + i] });
    }

    return pairings;
  }

  /**
   * Later rounds: sort players into score order, optionally assign one bye, then
   * find a complete rematch-free matching of the remaining players. Returns
   * `null` if no valid round can be formed (the tournament should finish).
   */
  private buildLaterRound(
    participants: readonly string[],
    playerHistory: ReadonlyMap<string, PlayerHistory>
  ): Pairing[] | null {
    const seedIndex = new Map<string, number>();
    participants.forEach((p, i) => seedIndex.set(p, i));

    const pointsOf = (p: string): number => playerHistory.get(p)?.points ?? 0;

    // Score order: points descending, then seed ascending (stable).
    const ordered = [...participants].sort((a, b) => {
      const pd = pointsOf(b) - pointsOf(a);
      if (pd !== 0) return pd;
      return seedIndex.get(a)! - seedIndex.get(b)!;
    });

    const opponentSets = new Map<string, Set<string>>();
    for (const p of participants) {
      opponentSets.set(p, new Set(playerHistory.get(p)?.opponents ?? []));
    }

    // Byes: `null` sentinel for the even case (no bye), otherwise the ordered
    // list of eligible players to try — lowest points first, then lowest seed
    // (highest seed index) first.
    let byeCandidates: (string | null)[];
    if (ordered.length % 2 === 0) {
      byeCandidates = [null];
    } else {
      const eligible = ordered.filter(
        p => (playerHistory.get(p)?.byeCount ?? 0) === 0
      );
      if (eligible.length === 0) {
        // Odd field but everyone has already had a bye: cannot form a fair
        // round — finish the tournament.
        return null;
      }
      byeCandidates = [...eligible].sort((a, b) => {
        const pd = pointsOf(a) - pointsOf(b); // lowest points first
        if (pd !== 0) return pd;
        return seedIndex.get(b)! - seedIndex.get(a)!; // lower seed (higher index) first
      });
    }

    for (const bye of byeCandidates) {
      const pool = bye === null ? ordered : ordered.filter(p => p !== bye);
      const matching = this.findMatching(pool, opponentSets);
      if (matching !== null) {
        const pairings: Pairing[] = [];
        if (bye !== null) {
          pairings.push({ kind: 'bye', player: bye });
        }
        for (const [a, b] of matching) {
          pairings.push(this.assignColors(a, b, seedIndex, playerHistory));
        }
        return pairings;
      }
    }

    // No bye choice yields a complete rematch-free pairing: finish.
    return null;
  }

  /**
   * Backtracking search for a complete matching that never repeats an opponent.
   * Partners are tried in score order (the pool is already score-sorted), so the
   * first solution found keeps players in adjacent score groups wherever
   * possible. Returns the matched pairs, or `null` if no complete matching
   * exists. A node budget guards against pathological blow-up on large fields.
   */
  private findMatching(
    pool: readonly string[],
    opponentSets: ReadonlyMap<string, Set<string>>
  ): Array<[string, string]> | null {
    const matched = new Array<boolean>(pool.length).fill(false);
    const result: Array<[string, string]> = [];
    let budget = 200_000;

    const recurse = (): boolean => {
      if (--budget < 0) return false;

      let i = 0;
      while (i < pool.length && matched[i]) i++;
      if (i >= pool.length) return true; // everyone paired

      matched[i] = true;
      for (let j = i + 1; j < pool.length; j++) {
        if (matched[j]) continue;
        if (opponentSets.get(pool[i])!.has(pool[j])) continue; // no rematch
        matched[j] = true;
        result.push([pool[i], pool[j]]);
        if (recurse()) return true;
        result.pop();
        matched[j] = false;
      }
      matched[i] = false;
      return false;
    };

    return recurse() ? result : null;
  }

  /**
   * Assign colours to a paired match, balancing white/black counts (best-effort).
   * The player who is "due" white (fewer whites than blacks) gets white; on a tie
   * the higher seed (lower index) gets white.
   */
  private assignColors(
    p1: string,
    p2: string,
    seedIndex: ReadonlyMap<string, number>,
    playerHistory: ReadonlyMap<string, PlayerHistory>
  ): GamePairing {
    const h1 = playerHistory.get(p1);
    const h2 = playerHistory.get(p2);
    const diff1 = (h1?.whiteCount ?? 0) - (h1?.blackCount ?? 0); // positive = more whites
    const diff2 = (h2?.whiteCount ?? 0) - (h2?.blackCount ?? 0);

    let white: string;
    let black: string;

    if (diff1 < diff2) {
      white = p1;
      black = p2;
    } else if (diff2 < diff1) {
      white = p2;
      black = p1;
    } else if ((seedIndex.get(p1) ?? 0) < (seedIndex.get(p2) ?? 0)) {
      white = p1;
      black = p2;
    } else {
      white = p2;
      black = p1;
    }

    return { kind: 'game', white, black };
  }
}
