import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EngineManager,
  FakeEngineTransport,
  InMemoryLruCache,
  stockfishPlugin,
  fairyStockfishPlugin,
  NoEngineForVariantError,
  InvalidFenError,
  ShuttingDownError,
  type EnginePlugin,
} from '../src/index.js';
import { ManualClock, START_FEN } from './helpers.js';

const STOCKFISH_OPTIONS = [
  'option name Threads type spin default 1 min 1 max 512',
  'option name Hash type spin default 16 min 1 max 1024',
  'option name MultiPV type spin default 1 min 1 max 256',
  'option name UCI_Chess960 type check default false',
];

function makeManager(clock: ManualClock, onGo?: () => void): { manager: EngineManager; cache: InMemoryLruCache } {
  const cache = new InMemoryLruCache(100);
  const manager = new EngineManager({
    clock,
    cache,
    minWorkers: 1,
    maxWorkers: 2,
    transportFactory: (plugin: EnginePlugin) => {
      if (plugin.id === 'stockfish') {
        return new FakeEngineTransport({
          name: 'Stockfish 16',
          optionLines: STOCKFISH_OPTIONS,
          go: () => {
            onGo?.();
            return { info: ['info depth 10 score cp 20 pv e2e4'], bestmove: 'e2e4' };
          },
        });
      }
      return new FakeEngineTransport({
        name: 'Fairy-Stockfish 14',
        variants: ['crazyhouse', 'atomic', 'kingofthehill'],
        go: () => ({ info: ['info depth 8 score cp 5 pv e2e4'], bestmove: 'e2e4' }),
      });
    },
  });
  manager.register(stockfishPlugin);
  manager.register(fairyStockfishPlugin);
  return { manager, cache };
}

test('routes standard chess to Stockfish and variants to Fairy-Stockfish', async () => {
  const clock = new ManualClock();
  const { manager } = makeManager(clock);
  await manager.warmup();

  assert.ok(manager.capabilitiesFor('chess'));
  assert.ok(manager.capabilitiesFor('crazyhouse'));
  assert.equal(manager.capabilitiesFor('antichess'), undefined);

  const std = await manager.analyze({ fen: START_FEN, variant: 'chess', limits: { depth: 10 } });
  assert.equal(std[0].evaluation.value, 20);

  const zh = await manager.analyze({ fen: START_FEN, variant: 'crazyhouse', limits: { depth: 8 } });
  assert.equal(zh[0].evaluation.value, 5);
});

test('serves a repeated analysis from cache', async () => {
  const clock = new ManualClock();
  let goCalls = 0;
  const { manager } = makeManager(clock, () => (goCalls += 1));
  await manager.warmup();

  const first = await manager.analyze({ fen: START_FEN, variant: 'chess', limits: { depth: 10 } });
  const second = await manager.analyze({ fen: START_FEN, variant: 'chess', limits: { depth: 10 } });
  assert.deepEqual(second, first);
  assert.equal(goCalls, 1, 'the second identical analysis was cached');
});

test('rejects an unsupported variant', async () => {
  const clock = new ManualClock();
  const { manager } = makeManager(clock);
  await manager.warmup();
  await assert.rejects(manager.analyze({ fen: START_FEN, variant: 'antichess', limits: { depth: 5 } }), NoEngineForVariantError);
});

test('rejects an invalid FEN before touching an engine', async () => {
  const clock = new ManualClock();
  const { manager } = makeManager(clock);
  await assert.rejects(manager.analyze({ fen: 'not a fen; rm -rf /', variant: 'chess', limits: { depth: 5 } }), InvalidFenError);
});

test('reports healthy status and shuts down cleanly', async () => {
  const clock = new ManualClock();
  const { manager } = makeManager(clock);
  await manager.warmup();
  assert.equal(manager.health().status, 'healthy');
  await manager.shutdown({ deadlineMs: 1000 });
  await assert.rejects(manager.analyze({ fen: START_FEN, variant: 'chess', limits: { depth: 5 } }), ShuttingDownError);
});
