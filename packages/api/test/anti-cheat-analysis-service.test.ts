import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryAntiCheatReportRepository, type PositionEvaluator } from '@chess-platform/anti-cheat';
import { EventStoreGameSource } from '../src/anti-cheat/source';
import { AntiCheatAnalysisService } from '../src/anti-cheat/analysis-service';

const fakeEvaluator: PositionEvaluator = {
  evaluate: (_fen, playedUci) => ({
    topMoves: [
      { uci: playedUci, cp: 30 },
      { uci: '0000', cp: 10 },
    ],
    playedCp: 30,
  }),
};

function createFinishedGameEvents(gameId: string, white: string, black: string) {
  const timeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const };
  let { game, events } = Game.create({
    gameId,
    timeControl,
    players: { white, black },
    rated: true,
    at: 1000,
  });
  const allEvents = [...events];
  let t = 2000;
  for (const uci of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) {
    ({ game, events } = game.playMove(uci, t));
    allEvents.push(...events);
    t += 1000;
  }
  return allEvents;
}

function createUnfinishedGameEvents(gameId: string, white: string, black: string) {
  const timeControl = { initialMs: 180_000, incrementMs: 2_000, delayMs: 0, kind: 'increment' as const };
  let { game, events } = Game.create({
    gameId,
    timeControl,
    players: { white, black },
    rated: true,
    at: 1000,
  });
  const allEvents = [...events];
  ({ game, events } = game.playMove('e2e4', 2000));
  allEvents.push(...events);
  return allEvents;
}

test('AntiCheatAnalysisService: analyzes and stores finished game reports', async () => {
  const store = new InMemoryEventStore();
  const repo = new InMemoryAntiCheatReportRepository();
  const source = new EventStoreGameSource(store);
  const service = new AntiCheatAnalysisService(source, () => fakeEvaluator, repo);

  const gameId = '11111111-1111-7111-8111-111111111111';
  const whiteId = '22222222-2222-7222-8222-222222222222';
  const blackId = '33333333-3333-7333-8333-333333333333';

  const events = createFinishedGameEvents(gameId, whiteId, blackId);
  await store.append(gameId, -1, events);

  const report = await service.analyzeAndStore(gameId);
  assert.ok(report);
  assert.ok(report.white);
  assert.ok(report.black);

  const whiteReports = await repo.listByPlayer(whiteId);
  assert.equal(whiteReports.length, 1);
  assert.equal(whiteReports[0]?.gameId, gameId);

  const blackReports = await repo.listByPlayer(blackId);
  assert.equal(blackReports.length, 1);
  assert.equal(blackReports[0]?.gameId, gameId);
});

test('AntiCheatAnalysisService: returns null for unknown gameId', async () => {
  const store = new InMemoryEventStore();
  const repo = new InMemoryAntiCheatReportRepository();
  const source = new EventStoreGameSource(store);
  const service = new AntiCheatAnalysisService(source, () => fakeEvaluator, repo);

  const report = await service.analyzeAndStore('99999999-9999-7999-8999-999999999999');
  assert.equal(report, null);
});

test('AntiCheatAnalysisService: returns null for unfinished game', async () => {
  const store = new InMemoryEventStore();
  const repo = new InMemoryAntiCheatReportRepository();
  const source = new EventStoreGameSource(store);
  const service = new AntiCheatAnalysisService(source, () => fakeEvaluator, repo);

  const gameId = '44444444-4444-7444-8444-444444444444';
  const whiteId = '22222222-2222-7222-8222-222222222222';
  const blackId = '33333333-3333-7333-8333-333333333333';

  const events = createUnfinishedGameEvents(gameId, whiteId, blackId);
  await store.append(gameId, -1, events);

  const report = await service.analyzeAndStore(gameId);
  assert.equal(report, null);

  const whiteReports = await repo.listByPlayer(whiteId);
  assert.equal(whiteReports.length, 0);
});
