import test from 'node:test';
import assert from 'node:assert/strict';
import { PuzzleController } from '../src/app/puzzle-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { PuzzleGenerationResponse } from '../src/api/models.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const RESULT: PuzzleGenerationResponse = {
  kind: 'puzzle',
  fen: FEN,
  variant: 'standard',
  evidence: { kind: 'centipawn_gap', gapCp: 270 },
  bestMove: 'e2e4',
  comparisonMove: 'd2d4',
  bestEvaluation: { type: 'cp', value: 350 },
  comparisonEvaluation: { type: 'cp', value: 80 },
  depth: 16,
  solutionMove: 'e2e4',
  solutionLine: ['e2e4', 'e7e5'],
  difficulty: 'easy',
};

function harness() {
  const calls: Array<{ body: { fen: string; variant: string }; signal?: AbortSignal }> = [];
  let resolve: ((value: PuzzleGenerationResponse) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  let position = { fen: FEN, variant: 'standard' };
  const events: string[] = [];
  const client = {
    analysis: {
      findPuzzle(body: { fen: string; variant: string }, signal?: AbortSignal) {
        calls.push({ body, ...(signal ? { signal } : {}) });
        return new Promise<PuzzleGenerationResponse>((ok, bad) => { resolve = ok; reject = bad; });
      },
    },
  } as unknown as GambitClient;
  const controller = new PuzzleController({
    client,
    getPosition: () => position,
    callbacks: {
      onPhase: (phase) => events.push(`phase:${phase}`),
      onResult: () => events.push('result'),
      onFailure: (failure) => events.push(`failure:${failure}`),
      onInvalidated: () => events.push('invalidated'),
    },
  });
  return {
    calls,
    events,
    controller,
    resolve: () => resolve?.(RESULT),
    reject: (reason: unknown) => reject?.(reason),
    moveTo: (fen: string) => { position = { ...position, fen }; controller.positionChanged(position); },
  };
}

test('PuzzleController coalesces repeat clicks and sends no caller policy', async () => {
  const h = harness();
  void h.controller.find();
  void h.controller.find();
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.body, { fen: FEN, variant: 'standard' });
  assert.ok(h.calls[0]!.signal);
  h.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.events.includes('result'), true);
});

test('PuzzleController discards a response after the position changes', async () => {
  const h = harness();
  void h.controller.find();
  await Promise.resolve();
  h.moveTo('8/8/8/8/8/8/8/K6k w - - 0 1');
  h.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.events.includes('invalidated'), true);
  assert.equal(h.events.includes('result'), false);
  assert.equal(h.calls[0]!.signal?.aborted, true);
});

test('PuzzleController classifies safe status-only failures', async () => {
  for (const [status, expected] of [[429, 'rate-limited'], [503, 'unavailable'], [401, 'unauthenticated'], [422, 'rejected']] as const) {
    const h = harness();
    void h.controller.find();
    await Promise.resolve();
    h.reject({ status });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(h.events.includes(`failure:${expected}`), true);
  }
});

test('PuzzleController emits nothing after disposal', async () => {
  const h = harness();
  void h.controller.find();
  await Promise.resolve();
  const count = h.events.length;
  h.controller.dispose();
  h.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(h.events.length, count);
});
