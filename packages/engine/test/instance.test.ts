import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UciEngineInstance,
  FakeEngineTransport,
  CancelledError,
  EngineCrashError,
  EngineTimeoutError,
  EngineVersionError,
  type DeadInfo,
} from '../src/index.js';
import { ManualClock, START_FEN, flush } from './helpers.js';

function newInstance(transport: FakeEngineTransport, clock: ManualClock, minVersion?: string): UciEngineInstance {
  return new UciEngineInstance(transport, {
    id: 'test',
    clock,
    watchdogMs: 1000,
    initTimeoutMs: 1000,
    ...(minVersion ? { minVersion } : {}),
  });
}

test('initializes and discovers capabilities', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({ name: 'Stockfish 16', variants: ['crazyhouse'] });
  const instance = newInstance(transport, clock);
  const caps = await instance.init();
  assert.equal(caps.engineName, 'Stockfish 16');
  assert.equal(caps.version, '16');
  assert.ok(caps.variants.has('crazyhouse'));
  assert.equal(instance.alive, true);
});

test('analyze parses info into a structured result', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({
    go: () => ({ info: ['info depth 18 score cp 42 nodes 100000 nps 800000 time 120 pv e2e4 e7e5'], bestmove: 'e2e4', ponder: 'e7e5' }),
  });
  const instance = newInstance(transport, clock);
  await instance.init();
  const [best] = await instance.analyze({ fen: START_FEN, limits: { depth: 18 }, multiPv: 1 });
  assert.equal(best.evaluation.type, 'cp');
  assert.equal(best.evaluation.value, 42);
  assert.deepEqual(best.principalVariation, ['e2e4', 'e7e5']);
  assert.equal(best.depth, 18);
  assert.equal(instance.jobsCompleted, 1);
});

test('analyze preserves score bounds in structured results', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({
    go: () => ({
      info: ['info depth 18 score cp 42 lowerbound nodes 100000 nps 800000 time 120 pv e2e4'],
      bestmove: 'e2e4',
    }),
  });
  const instance = newInstance(transport, clock);
  await instance.init();

  const [best] = await instance.analyze({ fen: START_FEN, limits: { depth: 18 }, multiPv: 1 });

  assert.equal(best.evaluationBound, 'lowerbound');
});

test('multiPv returns lines ordered best-first', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({
    go: () => ({
      info: [
        'info depth 12 multipv 1 score cp 30 pv e2e4',
        'info depth 12 multipv 2 score cp 10 pv d2d4',
      ],
      bestmove: 'e2e4',
    }),
  });
  const instance = newInstance(transport, clock);
  await instance.init();
  const results = await instance.analyze({ fen: START_FEN, limits: { depth: 12 }, multiPv: 2 });
  assert.equal(results.length, 2);
  assert.equal(results[0].multipv, 1);
  assert.equal(results[1].multipv, 2);
});

test('analysis rejects a MultiPV count the discovered engine cannot honor', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({
    optionLines: ['option name MultiPV type spin default 1 min 1 max 2'],
  });
  const instance = newInstance(transport, clock);
  await instance.init();
  const commandsAfterInit = [...transport.sent];

  await assert.rejects(
    instance.analyze({ fen: START_FEN, limits: { depth: 12 }, multiPv: 3 }),
    (error: unknown) => error instanceof Error && /MultiPV/.test(error.message),
  );
  assert.deepEqual(
    transport.sent,
    commandsAfterInit,
    'a rejected search must not send setup commands to a worker returned to the pool',
  );
});

test('play returns the chosen move and ponder', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({ bestmove: 'g1f3' });
  const instance = newInstance(transport, clock);
  await instance.init();
  const result = await instance.play({ fen: START_FEN, limits: { timeMs: 100 }, multiPv: 1 });
  assert.equal(result.move, 'g1f3');
});

test('cancellation via AbortSignal rejects with CancelledError', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({ go: () => 'hang', bestmove: 'e2e4' });
  const instance = newInstance(transport, clock);
  await instance.init();
  const controller = new AbortController();
  const promise = instance.analyze({ fen: START_FEN, limits: { depth: 30 }, multiPv: 1, signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(promise, CancelledError);
  assert.equal(instance.alive, true, 'a cancelled search leaves the engine reusable');
});

test('the watchdog kills a hung search', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({ go: () => 'hang' });
  const instance = newInstance(transport, clock);
  await instance.init();
  const promise = instance.analyze({ fen: START_FEN, limits: { depth: 30 }, multiPv: 1 });
  await flush();
  clock.advance(1001);
  await assert.rejects(promise, EngineTimeoutError);
  assert.equal(instance.alive, false);
});

test('an unexpected crash rejects the search and reports death', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({ go: () => 'hang' });
  const instance = newInstance(transport, clock);
  await instance.init();
  let dead: DeadInfo | undefined;
  instance.onDead((info) => (dead = info));
  const promise = instance.analyze({ fen: START_FEN, limits: { depth: 30 }, multiPv: 1 });
  await flush();
  transport.simulateCrash(1);
  await assert.rejects(promise, EngineCrashError);
  await flush();
  assert.equal(instance.alive, false);
  assert.equal(dead?.expected, false);
});

test('enforces the engine version floor', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport({ name: 'Stockfish 12' });
  const instance = newInstance(transport, clock, '15');
  await assert.rejects(instance.init(), EngineVersionError);
});

test('dispose quits the engine gracefully', async () => {
  const clock = new ManualClock();
  const transport = new FakeEngineTransport();
  const instance = newInstance(transport, clock);
  await instance.init();
  let dead: DeadInfo | undefined;
  instance.onDead((info) => (dead = info));
  await instance.dispose();
  assert.equal(instance.alive, false);
  assert.equal(dead?.expected, true);
});
