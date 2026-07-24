import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '@chess-platform/game';
import { InMemoryEventStore } from '@chess-platform/persistence';
import { InMemoryAntiCheatReportRepository } from '@chess-platform/anti-cheat';
import type { AnalysisProvider } from '@chess-platform/engine';
import {
  createEngineProviderFromEnv,
  createEngineBackedAnalysisService,
} from '../src/anti-cheat/engine-provider';
import { EventStoreGameSource } from '../src/anti-cheat/source';

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

test('createEngineProviderFromEnv: respects STOCKFISH_PATH environment variable', () => {
  const oldPath = process.env['STOCKFISH_PATH'];
  try {
    delete process.env['STOCKFISH_PATH'];
    assert.equal(createEngineProviderFromEnv(), undefined);

    process.env['STOCKFISH_PATH'] = '/usr/bin/stockfish';
    const provider = createEngineProviderFromEnv();
    assert.ok(provider !== undefined);
  } finally {
    if (oldPath !== undefined) {
      process.env['STOCKFISH_PATH'] = oldPath;
    } else {
      delete process.env['STOCKFISH_PATH'];
    }
  }
});

test('createEngineBackedAnalysisService: analyzes and stores reports using engine provider', async () => {
  const fakeProvider: AnalysisProvider = {
    async analyze(request) {
      return [
        {
          multipv: 1,
          evaluation: { type: 'cp', value: 25 },
          principalVariation: ['e2e4'],
          depth: request.limits.depth ?? 18,
          nodes: 500,
          nps: 1000,
          timeMs: 10,
        },
      ];
    },
    async play() {
      throw new Error('Not implemented');
    },
    capabilitiesFor() {
      return undefined;
    },
  };

  const store = new InMemoryEventStore();
  const repo = new InMemoryAntiCheatReportRepository();
  const source = new EventStoreGameSource(store);
  const service = createEngineBackedAnalysisService(source, fakeProvider, repo);

  const gameId = '11111111-1111-7111-8111-111111111111';
  const whiteId = '22222222-2222-7222-8222-222222222222';
  const blackId = '33333333-3333-7333-8333-333333333333';

  const events = createFinishedGameEvents(gameId, whiteId, blackId);
  await store.append(gameId, -1, events);

  const report = await service.analyzeAndStore(gameId);
  assert.ok(report !== null);

  const whiteReports = await repo.listByPlayer(whiteId);
  assert.equal(whiteReports.length, 1);
  assert.equal(whiteReports[0].gameId, gameId);
  assert.equal(whiteReports[0].playerId, whiteId);

  const blackReports = await repo.listByPlayer(blackId);
  assert.equal(blackReports.length, 1);
  assert.equal(blackReports[0].gameId, gameId);
  assert.equal(blackReports[0].playerId, blackId);
});
