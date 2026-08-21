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

/**
 * The platform's own variant name is `standard` — that is what `@chess-platform/core` declares and
 * what `services/gateway/src/engine-bot.ts` passes when a bot plays an ordinary game. UCI engines
 * call it `chess`, and every test above speaks the engine's vocabulary rather than the platform's,
 * which is exactly why the gap survived: routing a real game threw
 * `NoEngineForVariantError: No registered engine supports variant "standard"` and the computer never
 * moved.
 *
 * `stockfishPlugin.variantSetup` already handled `standard`, so the engine could always play it. Only
 * the routing said otherwise.
 */
test('routes the platform variant name "standard" to Stockfish, not just the UCI name "chess"', async () => {
  const clock = new ManualClock();
  const { manager } = makeManager(clock);
  await manager.warmup();

  // Warm: capabilities are discovered and report the UCI name, so this is the path that failed.
  const standard = await manager.analyze({ fen: START_FEN, variant: 'standard', limits: { depth: 10 } });
  assert.equal(standard[0].evaluation.value, 20);
  assert.ok(manager.capabilitiesFor('standard'), 'capabilitiesFor must resolve the platform name too');

  // The UCI name keeps working; this widens routing rather than moving it.
  const chess = await manager.analyze({ fen: START_FEN, variant: 'chess', limits: { depth: 10 } });
  assert.equal(chess[0].evaluation.value, 20);
});

test('routing "standard" works cold, before any engine has been warmed', async () => {
  const clock = new ManualClock();
  const { manager } = makeManager(clock);

  // No warmup(): the pool falls back to the plugin's declared variants, which listed only the UCI
  // name. A bot game starting before the first warmup hit this path.
  const standard = await manager.analyze({ fen: START_FEN, variant: 'standard', limits: { depth: 10 } });
  assert.equal(standard[0].evaluation.value, 20);
});

test('MultiPV capability uses the plugin guarantee cold and discovered limits warm', async () => {
  const clock = new ManualClock();
  const { manager } = makeManager(clock);

  assert.equal(manager.supportsMultiPv('standard', 3), true);
  assert.equal(manager.supportsMultiPv('standard', 4), false);
  assert.equal(manager.supportsMultiPv('antichess', 3), false);

  await manager.warmup();
  assert.equal(manager.supportsMultiPv('standard', 256), true);
  assert.equal(manager.supportsMultiPv('standard', 257), false);
});

/**
 * Resolving the name must not become widening it. An engine build that genuinely lacks a variant has
 * to stay unroutable even though the plugin lists it in `expectedVariants`, or the manager picks a
 * pool that will fail at play time over one that could have served the game.
 *
 * The fake Stockfish below reports no variants at all beyond ordinary chess, which is what a build
 * without `UCI_Chess960` looks like. Fairy is the pool that can serve it.
 */
test('a warm engine is not routed a variant its own capabilities do not report', async () => {
  const clock = new ManualClock();
  const cache = new InMemoryLruCache(100);
  const manager = new EngineManager({
    clock,
    cache,
    minWorkers: 1,
    maxWorkers: 2,
    transportFactory: (plugin: EnginePlugin) =>
      plugin.id === 'stockfish'
        ? new FakeEngineTransport({
            name: 'Stockfish 16',
            // No UCI_Chess960 option: this build cannot play Chess960, whatever the plugin expects.
            optionLines: ['option name Threads type spin default 1 min 1 max 512'],
            go: () => ({ info: ['info depth 10 score cp 20 pv e2e4'], bestmove: 'e2e4' }),
          })
        : new FakeEngineTransport({
            name: 'Fairy-Stockfish 14',
            variants: ['chess960', 'crazyhouse'],
            go: () => ({ info: ['info depth 8 score cp 5 pv e2e4'], bestmove: 'e2e4' }),
          }),
  });
  manager.register(stockfishPlugin);
  manager.register(fairyStockfishPlugin);
  await manager.warmup();

  // Routed to Fairy (evaluation 5), never to the Stockfish pool that merely expects the variant.
  const c960 = await manager.analyze({ fen: START_FEN, variant: 'chess960', limits: { depth: 8 } });
  assert.equal(c960[0].evaluation.value, 5, 'chess960 must go to the engine that reports it');
});

/**
 * The same vocabulary gap exists on Fairy-Stockfish and predates this change: the platform says
 * `threecheck`, Fairy's `UCI_Variant` value is `3check`, and a warm pool checks discovered
 * capabilities. Routing resolves through `engineVariantName`, which is fed by the map the plugin
 * already used for `variantSetup` — so the translation lives in one place rather than two.
 */
test('routes the platform name "threecheck" to Fairy, which reports it as "3check"', async () => {
  const clock = new ManualClock();
  const cache = new InMemoryLruCache(100);
  const manager = new EngineManager({
    clock,
    cache,
    minWorkers: 1,
    maxWorkers: 2,
    transportFactory: (plugin: EnginePlugin) =>
      plugin.id === 'stockfish'
        ? new FakeEngineTransport({
            name: 'Stockfish 16',
            optionLines: STOCKFISH_OPTIONS,
            go: () => ({ info: ['info depth 10 score cp 20 pv e2e4'], bestmove: 'e2e4' }),
          })
        : new FakeEngineTransport({
            name: 'Fairy-Stockfish 14',
            // The engine's own vocabulary, as a real Fairy build reports it.
            variants: ['3check', 'crazyhouse'],
            go: () => ({ info: ['info depth 8 score cp 5 pv e2e4'], bestmove: 'e2e4' }),
          }),
  });
  manager.register(stockfishPlugin);
  manager.register(fairyStockfishPlugin);
  await manager.warmup();

  const threeCheck = await manager.analyze({ fen: START_FEN, variant: 'threecheck', limits: { depth: 8 } });
  assert.equal(threeCheck[0].evaluation.value, 5);
});

/**
 * A search cut short by its time budget must be cached as what it *reached*, not as what it was
 * asked for.
 *
 * `CacheMeta.limits` is documented as the limits the search actually achieved, and `limitsSatisfy`
 * trusts that when deciding whether an entry can serve a later request. The manager stored the
 * *requested* limits, so a `depth: 20` request that a `movetime` ceiling stopped at depth 10 was
 * filed as depth 20 — and the next `depth: 20` request was handed the depth-10 lines without a new
 * search.
 *
 * The damage is not to the first caller, who was always going to get depth 10 for that budget. It
 * is that answer quality becomes a function of when the first identical request happened to run: one
 * issued while the machine was loaded poisons the entry for every caller after it, including those
 * whose own search would have gone deeper. Raised in the Qodo review of PR #132, by the first
 * consumer to enable a real cache.
 *
 * The fake engine here always reports `depth 10`, so asking for 20 is exactly the truncated search.
 */
test('a search that falls short of its requested depth is not cached as having reached it', async () => {
  const clock = new ManualClock();
  let goCalls = 0;
  const { manager } = makeManager(clock, () => (goCalls += 1));
  await manager.warmup();

  const deep = await manager.analyze({ fen: START_FEN, variant: 'chess', limits: { depth: 20 } });
  assert.equal(deep[0].depth, 10, 'the fake engine reaches depth 10 whatever is requested');
  assert.equal(goCalls, 1);

  // Asking again for depth 20 must search again, because nothing has yet achieved depth 20.
  await manager.analyze({ fen: START_FEN, variant: 'chess', limits: { depth: 20 } });
  assert.equal(goCalls, 2, 'a depth-20 request must not be served by a depth-10 result');

  // A request within what was actually achieved is still a legitimate hit — the fix must not
  // disable caching, only stop it overstating.
  await manager.analyze({ fen: START_FEN, variant: 'chess', limits: { depth: 8 } });
  assert.equal(goCalls, 2, 'a depth-8 request is satisfied by the depth-10 result already held');
});
