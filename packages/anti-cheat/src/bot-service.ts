import { analyzeBotBehavior, type BotBehaviorReport } from './bot-behavior';
import { extractTimedMoves, type MoveTiming } from './bot-extract';
import { aggregateBotBehavior, type BotAggregateReport, type BotAggregateInput } from './bot-aggregate';
import type { BotBehaviorReportRepository } from './bot-repository';

export interface AnalyzeBotAndStoreInput {
  readonly gameId: string;
  readonly players: { readonly white: string; readonly black: string };
  /** The game's ordered per-move timings (both sides). */
  readonly moves: readonly MoveTiming[];
  /** Optional opening-book predicate by 0-based game move index (passed to extractTimedMoves). */
  readonly isBook?: (moveIndex: number) => boolean;
}

/** Per-game behavioral report for both players. */
export interface GameBotReport {
  readonly white: BotBehaviorReport;
  readonly black: BotBehaviorReport;
}

export class BotDetectionService {
  constructor(private readonly repository: BotBehaviorReportRepository) {}

  async analyzeAndStore(input: AnalyzeBotAndStoreInput): Promise<GameBotReport> {
    // The two sides must be distinct: reports are keyed by (playerId, gameId), so
    // identical ids would make the black record silently overwrite the white one
    // (one report stored, but two returned). Fail loudly instead of losing data.
    if (input.players.white === input.players.black) {
      throw new Error(
        `BotDetectionService.analyzeAndStore: white and black must be different players (got "${input.players.white}" for both)`,
      );
    }

    const timings = extractTimedMoves(input.moves, input.isBook);
    const whiteReport = analyzeBotBehavior(timings.white);
    const blackReport = analyzeBotBehavior(timings.black);

    await this.repository.saveBatch([
      {
        gameId: input.gameId,
        playerId: input.players.white,
        color: 'white',
        report: whiteReport,
      },
      {
        gameId: input.gameId,
        playerId: input.players.black,
        color: 'black',
        report: blackReport,
      },
    ]);

    return {
      white: whiteReport,
      black: blackReport,
    };
  }

  async aggregatePlayer(playerId: string): Promise<BotAggregateReport> {
    const storedReports = await this.repository.listByPlayer(playerId);
    const inputs: BotAggregateInput[] = storedReports.map((record) => ({
      gameId: record.gameId,
      report: record.report,
    }));
    return aggregateBotBehavior(inputs);
  }
}
