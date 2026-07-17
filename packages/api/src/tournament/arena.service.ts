import { ArenaTournament, type ArenaConfig } from '@chess-platform/tournament';
import type { TournamentsRepository } from '@chess-platform/persistence';
import { isArenaSnapshot } from '@chess-platform/persistence';
import { HttpError } from '../http/errors';

export class ArenaService {
  constructor(private readonly repo: TournamentsRepository) {}

  async create(config: ArenaConfig): Promise<ArenaTournament> {
    const arena = new ArenaTournament(config);
    await this.repo.save(arena.toSnapshot());
    return arena;
  }

  async getTournament(id: string): Promise<ArenaTournament> {
    const snap = await this.repo.findById(id);
    if (!snap) throw HttpError.notFound('arena not found');
    if (!isArenaSnapshot(snap)) throw HttpError.conflict('not an arena tournament');
    return ArenaTournament.restore(snap);
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
    await this.repo.save(arena.toSnapshot());
    return arena;
  }

  async getStandings(id: string) {
    const arena = await this.getTournament(id);
    return arena.standings();
  }
}
