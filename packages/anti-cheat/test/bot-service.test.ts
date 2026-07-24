import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { BotDetectionService } from '../src/bot-service';
import { InMemoryBotBehaviorReportRepository } from '../src/bot-repository';
import type { MoveTiming } from '../src/bot-extract';

function createMoveTimings(
  whiteMoves: number[],
  blackMoves: number[],
): MoveTiming[] {
  const moves: MoveTiming[] = [];
  const maxLen = Math.max(whiteMoves.length, blackMoves.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < whiteMoves.length) {
      moves.push({ by: 'w', moveTimeMs: whiteMoves[i]! });
    }
    if (i < blackMoves.length) {
      moves.push({ by: 'b', moveTimeMs: blackMoves[i]! });
    }
  }
  return moves;
}

describe('BotDetectionService', () => {
  it('analyzeAndStore analyzes both players, stores records, and returns reports', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const service = new BotDetectionService(repo);

    const whiteTiming = Array<number>(12).fill(50);
    const blackTiming = [200, 1500, 3000, 500, 4000, 250, 1200, 800, 5000, 300, 1100, 900];
    const moves = createMoveTimings(whiteTiming, blackTiming);

    const report = await service.analyzeAndStore({
      gameId: 'game-1',
      players: { white: 'bot-player', black: 'human-player' },
      moves,
    });

    assert.equal(report.white.sampleSize, 12);
    assert.equal(report.black.sampleSize, 12);
    assert.equal(report.white.suspicion, 'high');
    assert.equal(report.black.suspicion, 'clean');

    const storedW = await repo.listByPlayer('bot-player');
    assert.equal(storedW.length, 1);
    assert.equal(storedW[0]!.gameId, 'game-1');
    assert.equal(storedW[0]!.color, 'white');
    assert.equal(storedW[0]!.report.sampleSize, 12);

    const storedB = await repo.listByPlayer('human-player');
    assert.equal(storedB.length, 1);
    assert.equal(storedB[0]!.gameId, 'game-1');
    assert.equal(storedB[0]!.color, 'black');
    assert.equal(storedB[0]!.report.sampleSize, 12);
  });

  it('re-analyzing the same gameId replaces prior records without duplicate', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const service = new BotDetectionService(repo);

    const moves1 = createMoveTimings(Array<number>(10).fill(50), Array<number>(10).fill(1000));
    const moves2 = createMoveTimings(Array<number>(15).fill(50), Array<number>(15).fill(1000));

    const input1 = {
      gameId: 'game-re-analyze',
      players: { white: 'p-white', black: 'p-black' },
      moves: moves1,
    };

    const input2 = {
      gameId: 'game-re-analyze',
      players: { white: 'p-white', black: 'p-black' },
      moves: moves2,
    };

    await service.analyzeAndStore(input1);
    await service.analyzeAndStore(input2);

    const storedW = await repo.listByPlayer('p-white');
    assert.equal(storedW.length, 1);
    assert.equal(storedW[0]!.report.sampleSize, 15);

    const aggW = await service.aggregatePlayer('p-white');
    assert.equal(aggW.gamesAnalyzed, 1);
    assert.equal(aggW.pooledSampleSize, 15);
  });

  it('aggregatePlayer composes stored reports across multiple games into account aggregate', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const service = new BotDetectionService(repo);

    // Build 3 games (>= BOT_AGG_MIN_GAMES = 3)
    // Bot player (white) has 15 moves per game = 45 moves total (>= BOT_AGG_MIN_POOLED_SAMPLE = 40)
    // Human player (black) has 15 varied moves per game
    const botMoves = Array<number>(15).fill(50);
    const humanMoves = [
      300, 1500, 2800, 450, 3500, 600, 1200, 900, 4200, 750, 1100, 850, 2300, 500, 1800,
    ];

    for (let i = 1; i <= 3; i++) {
      await service.analyzeAndStore({
        gameId: `game-${i}`,
        players: { white: 'bot-account', black: 'human-account' },
        moves: createMoveTimings(botMoves, humanMoves),
      });
    }

    const botAgg = await service.aggregatePlayer('bot-account');
    assert.equal(botAgg.gamesAnalyzed, 3);
    assert.equal(botAgg.pooledSampleSize, 45);
    assert.equal(botAgg.lowConfidence, false);
    assert.equal(botAgg.suspicion, 'high');
    assert.equal(botAgg.flaggedGameIds.length, 3);

    const humanAgg = await service.aggregatePlayer('human-account');
    assert.equal(humanAgg.gamesAnalyzed, 3);
    assert.equal(humanAgg.pooledSampleSize, 45);
    assert.equal(humanAgg.lowConfidence, false);
    assert.equal(humanAgg.suspicion, 'clean');
    assert.equal(humanAgg.flaggedGameIds.length, 0);
  });

  it('aggregatePlayer for player with no stored reports returns zeroed lowConfidence clean aggregate', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const service = new BotDetectionService(repo);

    const agg = await service.aggregatePlayer('unknown-user');
    assert.equal(agg.gamesAnalyzed, 0);
    assert.equal(agg.pooledSampleSize, 0);
    assert.equal(agg.pooledMeanMs, 0);
    assert.equal(agg.pooledStdevMs, 0);
    assert.equal(agg.pooledCoefficientOfVariation, 0);
    assert.equal(agg.pooledInstantMoves, 0);
    assert.equal(agg.pooledInstantFraction, 0);
    assert.equal(agg.lowConfidence, true);
    assert.equal(agg.suspicion, 'clean');
    assert.deepEqual(agg.flaggedGameIds, []);
  });

  it('rejects a game whose two player IDs are identical (would silently drop one report)', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const service = new BotDetectionService(repo);
    const moves = createMoveTimings([50, 50], [50, 50]);

    await assert.rejects(
      () =>
        service.analyzeAndStore({
          gameId: 'g-self',
          players: { white: 'same-id', black: 'same-id' },
          moves,
        }),
      /must be different players/,
    );
    // Nothing was stored for the offending id.
    assert.deepEqual(await repo.listByPlayer('same-id'), []);
  });

  it('passes isBook predicate down to extractTimedMoves', async () => {
    const repo = new InMemoryBotBehaviorReportRepository();
    const service = new BotDetectionService(repo);

    // 10 moves each; first 4 game move indices (0, 1, 2, 3) are book moves
    const moves = createMoveTimings(Array<number>(10).fill(50), Array<number>(10).fill(50));
    const isBook = (index: number) => index < 4;

    const report = await service.analyzeAndStore({
      gameId: 'game-book',
      players: { white: 'w-player', black: 'b-player' },
      moves,
      isBook,
    });

    // 10 total moves for white, 2 book (move 0, 2), 8 sample
    assert.equal(report.white.sampleSize, 8);
    // 10 total moves for black, 2 book (move 1, 3), 8 sample
    assert.equal(report.black.sampleSize, 8);
  });
});
