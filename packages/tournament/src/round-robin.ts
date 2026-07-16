import type { Pairing, PairingContext, PairingStrategy, Round } from './pairing';

/**
 * Implements a standard Berger-table (circle method) round-robin pairing strategy.
 * For N players, this guarantees that every player plays every other player exactly once,
 * and handles odd N by assigning one bye per round.
 * It also assigns colors mathematically to ensure the difference between white and black
 * games for any player is at most 1.
 *
 * Internally pre-computes the full schedule on the first call, then returns one
 * round per `pairNextRound` invocation. Returns `null` after all rounds are emitted.
 */
export class RoundRobinPairing implements PairingStrategy {
  /** Cached full schedule, computed lazily on first call. */
  private schedule: Round[] | null = null;
  /** The participant list the cached schedule was computed for. */
  private scheduledParticipants: readonly string[] | null = null;

  pairNextRound(context: PairingContext): Round | null {
    const { participants, roundNumber } = context;

    if (participants.length < 2) {
      return null;
    }

    // Recompute if this instance is reused for a different participant set,
    // so a cached schedule can never emit games for another tournament's players.
    const participantsChanged =
      this.scheduledParticipants === null ||
      participants.length !== this.scheduledParticipants.length ||
      participants.some((player, index) => player !== this.scheduledParticipants![index]);

    // Lazily compute the full schedule on the first call (or when it changed).
    if (this.schedule === null || participantsChanged) {
      this.scheduledParticipants = [...participants];
      this.schedule = this.computeFullSchedule(participants);
    }

    if (roundNumber >= this.schedule.length) {
      return null;
    }

    return this.schedule[roundNumber];
  }

  private computeFullSchedule(participants: readonly string[]): Round[] {
    const n = participants.length;
    const isOdd = n % 2 !== 0;
    const totalPlayers = isOdd ? n + 1 : n;
    const totalRounds = totalPlayers - 1;
    const half = totalPlayers / 2;
    const rounds: Round[] = [];

    for (let r = 0; r < totalRounds; r++) {
      const pairings: Pairing[] = [];
      
      // The fixed player is totalPlayers - 1 (0-indexed).
      // The other players rotate. In round r, the fixed player plays player r.
      // So p1 = r, p2 = totalPlayers - 1.
      // To match Berger table standard colors, we use the FIDE color rule based on 1-indexed math:
      // FIDE r is (r + 1). FIDE fixed player is N.
      pairings.push(this.createPairing(r + 1, totalPlayers, r + 1, half, isOdd, participants));

      // For the other pairs, we step outwards from r.
      // In a circle of size N-1, the pairs are (r + i) and (r - i) mod (N-1).
      for (let i = 1; i < half; i++) {
        const a = (r + i) % (totalPlayers - 1);
        const b = (r - i + totalPlayers - 1) % (totalPlayers - 1);
        pairings.push(this.createPairing(a + 1, b + 1, r + 1, half, isOdd, participants));
      }

      rounds.push({
        roundIndex: r,
        pairings
      });
    }

    return rounds;
  }

  private createPairing(
    p1: number,
    p2: number,
    r: number,
    half: number,
    isOdd: boolean,
    participants: readonly string[]
  ): Pairing {
    const totalPlayers = half * 2;
    // Map 1-based index to 0-based participant array
    // If the index is `totalPlayers` and we had an odd number of participants, it's a bye.
    const id1 = p1 === totalPlayers && isOdd ? null : participants[p1 - 1];
    const id2 = p2 === totalPlayers && isOdd ? null : participants[p2 - 1];

    if (id1 === null) {
      return { kind: 'bye', player: id2! };
    }
    if (id2 === null) {
      return { kind: 'bye', player: id1 };
    }

    // Determine colors
    let whitePlayer: string;
    let blackPlayer: string;

    if (p1 === totalPlayers || p2 === totalPlayers) {
      // Fixed player rule:
      // If r <= n/2, fixed player is Black, the other is White.
      // If r > n/2, fixed player is White, the other is Black.
      const fixedIsP1 = p1 === totalPlayers;
      const fixedGetsWhite = r > half;
      
      if (fixedGetsWhite) {
        whitePlayer = fixedIsP1 ? id1 : id2;
        blackPlayer = fixedIsP1 ? id2 : id1;
      } else {
        whitePlayer = fixedIsP1 ? id2 : id1;
        blackPlayer = fixedIsP1 ? id1 : id2;
      }
    } else {
      // Other matches rule:
      // If a + b is odd, smaller index gets White.
      // If a + b is even, larger index gets White.
      const sum = p1 + p2;
      if (sum % 2 !== 0) {
        const p1IsSmaller = p1 < p2;
        whitePlayer = p1IsSmaller ? id1 : id2;
        blackPlayer = p1IsSmaller ? id2 : id1;
      } else {
        const p1IsLarger = p1 > p2;
        whitePlayer = p1IsLarger ? id1 : id2;
        blackPlayer = p1IsLarger ? id2 : id1;
      }
    }

    return {
      kind: 'game',
      white: whitePlayer,
      black: blackPlayer
    };
  }
}
