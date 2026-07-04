import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EnginePool,
  FakeEngineTransport,
  stockfishPlugin,
  JobPriority,
  CircuitOpenError,
  ShuttingDownError,
} from '../src/index.js';
import { ManualClock, START_FEN, flush } from './helpers.js';

const analyzeReq = {
  fen: START_FEN,
  variant: 'chess',
  limits: { depth: 10 },
  multiPv: 1,
  priority: JobPriority.LiveAnalysis,
} as const;

test('warms to the minimum and serves analysis', async () => {
  const clock = new ManualClock();
  const pool = new EnginePool({
    plugin: stockfishPlugin,
    transportFactory: () => new FakeEngineTransport({ name: 'Stockfish 16', go: () => ({ info: ['info depth 10 score cp 15 pv e2e4'], bestmove: 'e2e4' }) }),
    clock,
    minWorkers: 1,
    maxWorkers: 3,
  });
  await pool.warmup();
  assert.equal(pool.health().ready, 1);
  const results = await pool.submitAnalyze(analyzeReq);
  assert.equal(results[0].evaluation.value, 15);
});

test('autoscales up to the max under queue pressure', async () => {
  const clock = new ManualClock();
  let created = 0;
  const pool = new EnginePool({
    plugin: stockfishPlugin,
    transportFactory: () => {
      created += 1;
      return new FakeEngineTransport({ name: 'Stockfish 16', go: () => 'hang', bestmove: 'e2e4' });
    },
    clock,
    minWorkers: 1,
    maxWorkers: 3,
  });
  await pool.warmup();

  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const jobs = controllers.map((c) => pool.submitAnalyze({ ...analyzeReq, signal: c.signal }));
  await flush();
  await flush();

  assert.equal(pool.health().ready, 3, 'pool grew to the max to drain the queue');
  assert.equal(created, 3);

  for (const c of controllers) c.abort();
  await Promise.allSettled(jobs);
});

test('detects a crash and hot-replaces the worker', async () => {
  const clock = new ManualClock();
  const transports: FakeEngineTransport[] = [];
  const pool = new EnginePool({
    plugin: stockfishPlugin,
    transportFactory: () => {
      const t = new FakeEngineTransport({ name: 'Stockfish 16', go: () => 'hang' });
      transports.push(t);
      return t;
    },
    clock,
    minWorkers: 1,
    maxWorkers: 1,
  });
  await pool.warmup();
  const firstId = pool.health().workers[0]?.id;

  transports[0].simulateCrash(1);
  await flush();
  await flush();

  assert.equal(pool.health().ready, 1, 'a replacement worker was spawned');
  assert.notEqual(pool.health().workers[0]?.id, firstId, 'the replacement is a new worker');
});

test('opens the circuit breaker after repeated crashes', async () => {
  const clock = new ManualClock();
  const transports: FakeEngineTransport[] = [];
  const pool = new EnginePool({
    plugin: stockfishPlugin,
    transportFactory: () => {
      const t = new FakeEngineTransport({ name: 'Stockfish 16', go: () => 'hang' });
      transports.push(t);
      return t;
    },
    clock,
    minWorkers: 1,
    maxWorkers: 1,
    breaker: { failureThreshold: 3, windowMs: 100_000, cooldownMs: 100_000 },
  });
  await pool.warmup();

  for (let i = 0; i < 3; i++) {
    transports[i].simulateCrash(1);
    await flush();
    await flush();
  }

  assert.equal(pool.health().breaker, 'open');
  await assert.rejects(pool.submitAnalyze(analyzeReq), CircuitOpenError);
});

test('drains gracefully and refuses new work', async () => {
  const clock = new ManualClock();
  const pool = new EnginePool({
    plugin: stockfishPlugin,
    transportFactory: () => new FakeEngineTransport({ name: 'Stockfish 16', bestmove: 'e2e4' }),
    clock,
    minWorkers: 1,
    maxWorkers: 2,
  });
  await pool.warmup();
  await pool.submitAnalyze(analyzeReq);
  await pool.drain(1000);
  await assert.rejects(pool.submitAnalyze(analyzeReq), ShuttingDownError);
});
