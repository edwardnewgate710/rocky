import type { BotBehaviorReport } from './bot-behavior';

export interface StoredBotReport {
  readonly gameId: string;
  readonly playerId: string;
  readonly color: 'white' | 'black';
  readonly report: BotBehaviorReport;
}

export interface BotBehaviorReportRepository {
  /**
   * Upsert by (gameId, playerId): re-analysis REPLACES the prior record, never
   * appends a duplicate — so `aggregateBotBehavior`'s duplicate-gameId guard never trips.
   */
  saveBatch(records: readonly StoredBotReport[]): Promise<void>;
  /** Every stored record for one player, at most one per gameId. */
  listByPlayer(playerId: string): Promise<readonly StoredBotReport[]>;
}

export class InMemoryBotBehaviorReportRepository implements BotBehaviorReportRepository {
  // Keyed by `playerId` -> `gameId` -> `StoredBotReport`
  private readonly store = new Map<string, Map<string, StoredBotReport>>();

  async saveBatch(records: readonly StoredBotReport[]): Promise<void> {
    for (const record of records) {
      let playerReports = this.store.get(record.playerId);
      if (!playerReports) {
        playerReports = new Map();
        this.store.set(record.playerId, playerReports);
      }
      playerReports.set(record.gameId, record);
    }
  }

  async listByPlayer(playerId: string): Promise<readonly StoredBotReport[]> {
    const playerReports = this.store.get(playerId);
    if (!playerReports) {
      return [];
    }
    return Array.from(playerReports.values());
  }
}
