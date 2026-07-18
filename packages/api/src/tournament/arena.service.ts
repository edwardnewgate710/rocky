import { ArenaTournament, type ArenaConfig } from '@chess-platform/tournament';
import type { TournamentsRepository } from '@chess-platform/persistence';
import { isArenaSnapshot } from '@chess-platform/persistence';
import { HttpError } from '../http/errors';

import type { GameResult } from '@chess-platform/tournament';
import type { GameLauncher } from './launcher';

export class ArenaService {
  constructor(
    private readonly repo: TournamentsRepository,
    private readonly launcher: GameLauncher,
    private readonly clock: () => number
  ) {}

  async create(config: ArenaConfig): Promise<ArenaTournament> {
    const arena = new ArenaTournament(config);
    await this.repo.save(arena.toSnapshot());
    return arena;
  }

  async getTournament(id: string): Promise<ArenaTournament> {
    const snap = await this.repo.findById(id);
    if (!snap) throw HttpError.notFound('arena not found');
    if (!isArenaSnapshot(snap)) throw HttpError.conflict('not an arena tournament');
    const arena = ArenaTournament.restore(snap);
    const wasRunning = arena.getState() === 'running';
    arena.settle(this.clock());
    if (wasRunning && arena.getState() === 'finished') {
      await this.repo.save(arena.toSnapshot());
    }
    return arena;
  }

  private async reconcileLaunch(arena: ArenaTournament): Promise<void> {
    const pairings = arena.pairAvailable(this.clock());
    for (const p of pairings) {
      if (!arena.gameIdFor(p.pairingId)) {
        const { gameId } = await this.launcher.launch({
          tournamentId: arena.config.id,
          matchId: p.pairingId,
          white: p.white,
          black: p.black,
          variant: arena.config.variant,
          timeControl: arena.config.timeControl,
          attempt: 0,
        });
        arena.linkGame(p.pairingId, gameId);
      }
    }
  }

  async register(id: string, playerId: string): Promise<ArenaTournament> {
    const arena = await this.getTournament(id);
    arena.register(playerId);
    await this.repo.save(arena.toSnapshot());
    return arena;
  }

  async withdraw(id: string, playerId: string): Promise<ArenaTournament> {
    const arena = await this.getTournament(id);
    arena.withdraw(playerId);
    await this.repo.save(arena.toSnapshot());
    return arena;
  }

  async start(id: string, atMs: number): Promise<ArenaTournament> {
    const arena = await this.getTournament(id);
    arena.start(atMs);
    await this.reconcileLaunch(arena);
    await this.repo.save(arena.toSnapshot());
    return arena;
  }

  async getStandings(id: string) {
    const arena = await this.getTournament(id);
    return arena.standings();
  }

  async recordResultByGame(id: string, gameId: string, result: GameResult): Promise<ArenaTournament> {
    const arena = await this.getTournament(id);
    arena.recordResultByGame(gameId, result, this.clock());
    await this.reconcileLaunch(arena);
    await this.repo.save(arena.toSnapshot());
    return arena;
  }

  async abandonGame(id: string, gameId: string): Promise<ArenaTournament> {
    const arena = await this.getTournament(id);
    arena.abandonGame(gameId);
    await this.reconcileLaunch(arena);
    await this.repo.save(arena.toSnapshot());
    return arena;
  }
}
