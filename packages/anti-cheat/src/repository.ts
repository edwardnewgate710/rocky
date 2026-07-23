import type { PlayerCorrelationReport } from './analyzer';

export interface StoredPlayerReport {
  readonly gameId: string;
  readonly playerId: string;
  readonly color: 'white' | 'black';
  readonly report: PlayerCorrelationReport;
}

export interface AntiCheatReportRepository {
  /**
   * Upsert by (gameId, playerId) atomically: re-analysis REPLACES the prior record,
   * never appends a duplicate.
   */
  saveBatch(records: readonly StoredPlayerReport[]): Promise<void>;

  /**
   * Every stored record for one player, at most one per gameId.
   */
  listByPlayer(playerId: string): Promise<readonly StoredPlayerReport[]>;
}

export class InMemoryAntiCheatReportRepository implements AntiCheatReportRepository {
  // Keyed by `playerId` -> `gameId` -> `StoredPlayerReport`
  private readonly store = new Map<string, Map<string, StoredPlayerReport>>();

  async saveBatch(records: readonly StoredPlayerReport[]): Promise<void> {
    for (const record of records) {
      let playerReports = this.store.get(record.playerId);
      if (!playerReports) {
        playerReports = new Map();
        this.store.set(record.playerId, playerReports);
      }
      playerReports.set(record.gameId, record);
    }
  }

  async listByPlayer(playerId: string): Promise<readonly StoredPlayerReport[]> {
    const playerReports = this.store.get(playerId);
    if (!playerReports) {
      return [];
    }
    return Array.from(playerReports.values());
  }
}
