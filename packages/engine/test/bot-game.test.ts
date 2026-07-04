import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineManager, FakeEngineTransport, stockfishPlugin } from '../src/index.js';
import { ManualClock, START_FEN } from './helpers.js';

/**
 * Drives a full scripted game through the whole bot path
 * (manager -> pool -> instance -> transport). The fake returns a scripted move per ply,
 * so the test is deterministic; end-to-end legality against the M2 `Game` aggregate is
 * wired in the deployable service (M14, see ENGINE_BRIDGE.md §11).
 */
test('a bot plays out a full scripted game move by move', async () => {
  const clock = new ManualClock();
  const script = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6', 'f3g5', 'd7d5', 'e4d5', 'f6d5', 'd5f7'];
  let ply = 0;

  const manager = new EngineManager({
    clock,
    minWorkers: 1,
    maxWorkers: 1,
    transportFactory: () =>
      new FakeEngineTransport({
        name: 'Stockfish 16',
        go: () => ({ bestmove: script[Math.min(ply, script.length - 1)] }),
      }),
  });
  manager.register(stockfishPlugin);
  await manager.warmup();

  const played: string[] = [];
  for (ply = 0; ply < script.length; ply++) {
    const result = await manager.play({ fen: START_FEN, variant: 'chess', limits: { timeMs: 20 }, strength: { elo: 1600 } });
    played.push(result.move);
  }

  assert.deepEqual(played, script);
  assert.equal(manager.health().status, 'healthy');
});
