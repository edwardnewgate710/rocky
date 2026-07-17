import type { TournamentsRepository } from '@chess-platform/persistence';
import { isArenaSnapshot } from '@chess-platform/persistence';
import type { RoundBasedConfig } from '@chess-platform/tournament';
import { Tournament, createPairingStrategy } from '@chess-platform/tournament';
import type { GameResult } from '@chess-platform/tournament';
import { HttpError } from '../http/errors';
import type { GameLauncher } from './launcher';

export interface CreateTournamentCommand {
  readonly id: string;
  readonly name: string;
  readonly format: 'round_robin' | 'swiss';
  readonly variant: 'standard' | 'chess960';
  readonly timeControl: RoundBasedConfig['timeControl'];
  readonly rounds?: number; // required if swiss
  readonly tiebreakOrder?: RoundBasedConfig['tiebreakOrder'];
}

export interface RecordResultCommand {
  readonly roundIndex: number;
  readonly pairingIndex: number;
  readonly result: 'white_win' | 'black_win' | 'draw';
}

export class TournamentService {
  constructor(
    private readonly repo: TournamentsRepository,
    private readonly launcher: GameLauncher
  ) {}

  async create(cmd: CreateTournamentCommand): Promise<Tournament> {
    const existing = await this.repo.findById(cmd.id);
    if (existing) {
      throw HttpError.conflict('Tournament ID already exists', { id: cmd.id });
    }

    if (cmd.format === 'swiss' && (typeof cmd.rounds !== 'number' || cmd.rounds < 1)) {
      throw HttpError.validation('Swiss tournaments require a positive number of rounds', { rounds: cmd.rounds });
    }

    let config: RoundBasedConfig;
    if (cmd.format === 'round_robin') {
      config = {
        id: cmd.id,
        name: cmd.name,
        format: 'round_robin',
        variant: cmd.variant,
        timeControl: cmd.timeControl,
        tiebreakOrder: cmd.tiebreakOrder,
      };
    } else {
      config = {
        id: cmd.id,
        name: cmd.name,
        format: 'swiss',
        variant: cmd.variant,
        timeControl: cmd.timeControl,
        rounds: cmd.rounds!,
        tiebreakOrder: cmd.tiebreakOrder,
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
    if (isArenaSnapshot(snap)) {
      throw HttpError.conflict('Not a round-based tournament');
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
      await this.reconcileLaunch(tournament);
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
      await this.reconcileLaunch(tournament);
    } catch (e: any) {
      throw HttpError.conflict(e.message);
    }
    await this.repo.save(tournament.toSnapshot());
    return tournament;
  }

  async recordResultByGame(id: string, gameId: string, result: GameResult): Promise<Tournament> {
    const tournament = await this.load(id);
    try {
      tournament.recordResultByGame(gameId, result);
      await this.reconcileLaunch(tournament);
    } catch (e: any) {
      if (e.message.includes('Unknown game ID')) {
        throw HttpError.notFound('Game ID not found in this tournament');
      }
      throw HttpError.conflict(e.message);
    }
    await this.repo.save(tournament.toSnapshot());
    return tournament;
  }

  /**
   * Abandon an undecided game (e.g. it was aborted) and immediately reconcile,
   * which launches a fresh game for the same pairing so the round can proceed.
   */
  async abandonGame(id: string, gameId: string): Promise<Tournament> {
    const tournament = await this.load(id);
    try {
      tournament.abandonGame(gameId);
      await this.reconcileLaunch(tournament);
    } catch (e: any) {
      if (e.message.includes('Unknown game ID')) {
        throw HttpError.notFound('Game ID not found in this tournament');
      }
      throw HttpError.conflict(e.message);
    }
    await this.repo.save(tournament.toSnapshot());
    return tournament;
  }

  private async reconcileLaunch(tournament: Tournament): Promise<void> {
    const rounds = tournament.getRounds();
    for (const round of rounds) {
      for (let pIndex = 0; pIndex < round.pairings.length; pIndex++) {
        const pairing = round.pairings[pIndex];
        if (pairing.kind === 'game') {
          if (!tournament.gameIdFor(round.roundIndex, pIndex)) {
            const result = await this.launcher.launch({
              tournamentId: tournament.config.id,
              matchId: `${round.roundIndex}-${pIndex}`,
              white: pairing.white,
              black: pairing.black,
              variant: tournament.config.variant,
              timeControl: tournament.config.timeControl,
              attempt: tournament.launchAttemptFor(round.roundIndex, pIndex),
            });
            tournament.linkGame(round.roundIndex, pIndex, result.gameId);
          }
        }
      }
    }
  }
}
