import { TournamentConfig } from './config';
import { PairingStrategy, Round } from './pairing';
import { GameResult, PlayerStanding, computeStandings } from './standings';

export type TournamentState = 'registration' | 'running' | 'finished';

export class Tournament {
  private state: TournamentState = 'registration';
  private readonly participants = new Set<string>();
  private rounds: Round[] = [];
  
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
    return Array.from(this.participants);
  }

  getRounds(): readonly Round[] {
    return this.rounds;
  }

  register(playerId: string): void {
    if (this.state !== 'registration') {
      throw new Error('Cannot register after tournament has started');
    }
    this.participants.add(playerId);
  }

  withdraw(playerId: string): void {
    if (this.state !== 'registration') {
      throw new Error('Cannot withdraw after tournament has started');
    }
    this.participants.delete(playerId);
  }

  start(): void {
    if (this.state !== 'registration') {
      throw new Error('Tournament already started');
    }
    if (this.participants.size < 2) {
      throw new Error('Need at least 2 players to start a tournament');
    }

    this.rounds = this.pairingStrategy.generateRounds(Array.from(this.participants));
    
    // Index pairings by matchId (roundIndex-pairingIndex)
    for (let r = 0; r < this.rounds.length; r++) {
      const round = this.rounds[r];
      for (let p = 0; p < round.pairings.length; p++) {
        const pairing = round.pairings[p];
        const matchId = `${r}-${p}`;
        if (pairing.kind === 'game') {
          this.pairingsByMatchId.set(matchId, { p1: pairing.white, p2: pairing.black });
        } else {
          this.pairingsByMatchId.set(matchId, { p1: pairing.player, p2: null });
          // Byes are automatically recorded
          this.results.set(matchId, 'bye');
        }
      }
    }

    this.state = 'running';
    this.checkFinished();
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
    this.checkFinished();
  }

  standings(): PlayerStanding[] {
    return computeStandings(this.getParticipants(), this.results, this.pairingsByMatchId);
  }

  private checkFinished(): void {
    if (this.state === 'running' && this.results.size === this.pairingsByMatchId.size) {
      this.state = 'finished';
    }
  }
}
