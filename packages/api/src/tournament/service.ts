import type { TournamentsRepository } from '@chess-platform/persistence';
import type { TournamentConfig } from '@chess-platform/tournament';
import { Tournament, createPairingStrategy } from '@chess-platform/tournament';
import { HttpError } from '../http/errors';

export interface CreateTournamentCommand {
  readonly id: string;
  readonly name: string;
  readonly format: 'round_robin' | 'swiss';
  readonly variant: 'standard' | 'chess960';
  readonly timeControl: TournamentConfig['timeControl'];
  readonly rounds?: number; // required if swiss
}

export interface RecordResultCommand {
  readonly roundIndex: number;
  readonly pairingIndex: number;
  readonly result: 'white_win' | 'black_win' | 'draw';
}

export class TournamentService {
  constructor(private readonly repo: TournamentsRepository) {}

  async create(cmd: CreateTournamentCommand): Promise<Tournament> {
    const existing = await this.repo.findById(cmd.id);
    if (existing) {
      throw HttpError.conflict('Tournament ID already exists', { id: cmd.id });
    }

    if (cmd.format === 'swiss' && (typeof cmd.rounds !== 'number' || cmd.rounds < 1)) {
      throw HttpError.validation('Swiss tournaments require a positive number of rounds', { rounds: cmd.rounds });
    }

    let config: TournamentConfig;
    if (cmd.format === 'round_robin') {
      config = {
        id: cmd.id,
        name: cmd.name,
        format: 'round_robin',
        variant: cmd.variant,
        timeControl: cmd.timeControl,
      };
    } else {
      config = {
        id: cmd.id,
        name: cmd.name,
        format: 'swiss',
        variant: cmd.variant,
        timeControl: cmd.timeControl,
        rounds: cmd.rounds!,
      };
    }

    const strategy = createPairingStrategy(config);
    const tournament = new Tournament(config, strategy);
    await this.repo.save(tournament.toSnapshot());
    return tournament;
  }

  async load(id: string): Promise<Tournament> {
    const snap = await this.repo.findById(id);
    if (!snap) {
      throw HttpError.notFound('Tournament not found');
    }
    const strategy = createPairingStrategy(snap.config);
    return Tournament.restore(snap, strategy);
  }

  async register(id: string, playerId: string): Promise<Tournament> {
    const tournament = await this.load(id);
    try {
      tournament.register(playerId);
    } catch (e: any) {
      throw HttpError.conflict(e.message);
    }
    await this.repo.save(tournament.toSnapshot());
    return tournament;
  }

  async withdraw(id: string, playerId: string): Promise<Tournament> {
    const tournament = await this.load(id);
    try {
      tournament.withdraw(playerId);
    } catch (e: any) {
      throw HttpError.conflict(e.message);
    }
    await this.repo.save(tournament.toSnapshot());
    return tournament;
  }

  async start(id: string): Promise<Tournament> {
    const tournament = await this.load(id);
    try {
      tournament.start();
    } catch (e: any) {
      throw HttpError.conflict(e.message);
    }
    await this.repo.save(tournament.toSnapshot());
    return tournament;
  }

  async recordResult(id: string, cmd: RecordResultCommand): Promise<Tournament> {
    const tournament = await this.load(id);
    try {
      tournament.recordResult(cmd.roundIndex, cmd.pairingIndex, cmd.result);
    } catch (e: any) {
      throw HttpError.conflict(e.message);
    }
    await this.repo.save(tournament.toSnapshot());
    return tournament;
  }
}
