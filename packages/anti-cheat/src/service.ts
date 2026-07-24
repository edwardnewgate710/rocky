import { analyzeGame, type GameCorrelationReport, type AnalyzedPly } from './analyzer';
import { aggregatePlayer, type PlayerAggregateReport, type PlayerAggregateInput } from './aggregate';
import type { PositionEvaluator } from './port';
import type { AntiCheatReportRepository } from './repository';

export interface AnalyzeAndStoreInput {
  readonly gameId: string;
  readonly players: {
    readonly white: string;
    readonly black: string;
  };
  readonly plies: readonly AnalyzedPly[];
  readonly depth: number;
}

export class AntiCheatService {
  constructor(
    private readonly evaluator: PositionEvaluator,
    private readonly repository: AntiCheatReportRepository,
  ) {}

  async analyzeAndStore(input: AnalyzeAndStoreInput): Promise<GameCorrelationReport> {
    if (input.players.white === input.players.black) {
      throw new Error(
        `AntiCheatService.analyzeAndStore: white and black must be different players (got "${input.players.white}" for both)`,
      );
    }

    const report = await analyzeGame({
      plies: input.plies,
      depth: input.depth,
      evaluator: this.evaluator,
    });

    await this.repository.saveBatch([
      {
        gameId: input.gameId,
        playerId: input.players.white,
        color: 'white',
        report: report.white,
      },
      {
        gameId: input.gameId,
        playerId: input.players.black,
        color: 'black',
        report: report.black,
      },
    ]);

    return report;
  }

  async aggregatePlayer(playerId: string): Promise<PlayerAggregateReport> {
    const storedReports = await this.repository.listByPlayer(playerId);
    const inputs: PlayerAggregateInput[] = storedReports.map((record) => ({
      gameId: record.gameId,
      report: record.report,
    }));
    return aggregatePlayer(inputs);
  }
}
