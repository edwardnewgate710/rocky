import type { TournamentConfig } from './config';
import type { PairingContext, PairingStrategy, Round, CompletedRound, PlayerHistory } from './pairing';
import type { GameResult, PlayerStanding } from './standings';
import { computeStandings } from './standings';

export type TournamentState = 'registration' | 'running' | 'finished';

export class Tournament {
  private state: TournamentState = 'registration';
  private readonly participants: string[] = [];
  private readonly rounds: Round[] = [];

  // matchId -> result
  private readonly results = new Map<string, GameResult | 'bye'>();
  private readonly pairingsByMatchId = new Map<string, { p1: string; p2: string | null }>();

  constructor(
    public readonly config: TournamentConfig,
    private readonly pairingStrategy: PairingStrategy
  ) {}

  getState(): TournamentState {
    return this.state;
  }

  getParticipants(): readonly string[] {
    // Return a copy so callers can't mutate registration state through it.
    return [...this.participants];
  }

  getRounds(): readonly Round[] {
    return this.rounds;
  }

  register(playerId: string): void {
    if (this.state !== 'registration') {
      throw new Error('Cannot register after tournament has started');
    }
    if (!this.participants.includes(playerId)) {
      this.participants.push(playerId);
    }
  }

  withdraw(playerId: string): void {
    if (this.state !== 'registration') {
      throw new Error('Cannot withdraw after tournament has started');
    }
    const idx = this.participants.indexOf(playerId);
    if (idx >= 0) {
      this.participants.splice(idx, 1);
    }
  }

  start(): void {
    if (this.state !== 'registration') {
      throw new Error('Tournament already started');
    }
    if (this.participants.length < 2) {
      throw new Error('Need at least 2 players to start a tournament');
    }

    this.state = 'running';

    // Generate round 1
    this.advanceRound();
  }

  recordResult(roundIndex: number, pairingIndex: number, result: GameResult): void {
    if (this.state !== 'running') {
      throw new Error('Cannot record result unless tournament is running');
    }

    const matchId = `${roundIndex}-${pairingIndex}`;
    if (!this.pairingsByMatchId.has(matchId)) {
      throw new Error('Unknown pairing');
    }
    if (this.pairingsByMatchId.get(matchId)?.p2 === null) {
      throw new Error('Cannot record result for a bye');
    }

    this.results.set(matchId, result);

    // Check if the current round is fully resolved, and if so advance
    this.tryAdvance();
  }

  standings(): PlayerStanding[] {
    return computeStandings(this.getParticipants(), this.results, this.pairingsByMatchId);
  }

  /** Build the PairingContext from current state. */
  private buildContext(): PairingContext {
    const completedRounds: CompletedRound[] = [];
    for (const round of this.rounds) {
      const roundResults = new Map<string, GameResult | 'bye'>();
      for (let p = 0; p < round.pairings.length; p++) {
        const matchId = `${round.roundIndex}-${p}`;
        const result = this.results.get(matchId);
        if (result !== undefined) {
          roundResults.set(matchId, result);
        }
      }
      completedRounds.push({ round, results: roundResults });
    }

    // Build per-player history
    const playerHistory = new Map<string, PlayerHistory>();
    const historyState = new Map<string, {
      opponents: string[];
      whiteCount: number;
      blackCount: number;
      byeCount: number;
      points: number;
    }>();

    for (const pid of this.participants) {
      historyState.set(pid, {
        opponents: [],
        whiteCount: 0,
        blackCount: 0,
        byeCount: 0,
        points: 0
      });
    }

    for (const [matchId, result] of this.results.entries()) {
      const pairing = this.pairingsByMatchId.get(matchId);
      if (!pairing) continue;

      if (result === 'bye') {
        const s = historyState.get(pairing.p1);
        if (s) {
          s.byeCount += 1;
          s.points += 1;
        }
        continue;
      }

      const p2 = pairing.p2;
      if (!p2) continue;

      const s1 = historyState.get(pairing.p1);
      const s2 = historyState.get(p2);
      if (!s1 || !s2) continue;

      s1.opponents.push(p2);
      s2.opponents.push(pairing.p1);
      s1.whiteCount += 1;
      s2.blackCount += 1;

      if (result === 'white_win') {
        s1.points += 1;
      } else if (result === 'black_win') {
        s2.points += 1;
      } else if (result === 'draw') {
        s1.points += 0.5;
        s2.points += 0.5;
      }
    }

    for (const [pid, s] of historyState.entries()) {
      playerHistory.set(pid, {
        opponents: s.opponents,
        whiteCount: s.whiteCount,
        blackCount: s.blackCount,
        byeCount: s.byeCount,
        points: s.points
      });
    }

    return {
      participants: this.participants,
      roundNumber: this.rounds.length,
      completedRounds,
      playerHistory
    };
  }

  /** Index a newly generated round's pairings and auto-record byes. */
  private indexRound(round: Round): void {
    for (let p = 0; p < round.pairings.length; p++) {
      const pairing = round.pairings[p];
      const matchId = `${round.roundIndex}-${p}`;
      if (pairing.kind === 'game') {
        this.pairingsByMatchId.set(matchId, { p1: pairing.white, p2: pairing.black });
      } else {
        this.pairingsByMatchId.set(matchId, { p1: pairing.player, p2: null });
        // Byes are automatically recorded
        this.results.set(matchId, 'bye');
      }
    }
  }

  /** Generate the next round via the pairing strategy. */
  private advanceRound(): void {
    const context = this.buildContext();
    const nextRound = this.pairingStrategy.pairNextRound(context);

    if (nextRound === null) {
      this.state = 'finished';
      return;
    }

    this.rounds.push(nextRound);
    this.indexRound(nextRound);

    // If the round is all byes (shouldn't happen normally), try to advance again
    this.tryAdvance();
  }

  /** Check if the current round is fully resolved; if so, advance. */
  private tryAdvance(): void {
    if (this.state !== 'running' || this.rounds.length === 0) return;

    const currentRound = this.rounds[this.rounds.length - 1];
    let allResolved = true;
    for (let p = 0; p < currentRound.pairings.length; p++) {
      const matchId = `${currentRound.roundIndex}-${p}`;
      if (!this.results.has(matchId)) {
        allResolved = false;
        break;
      }
    }

    if (allResolved) {
      this.advanceRound();
    }
  }
}
