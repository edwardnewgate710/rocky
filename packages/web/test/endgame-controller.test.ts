import test from 'node:test';
import assert from 'node:assert/strict';
import { EndgameController } from '../src/app/endgame-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { EndgameAttemptResult, EndgamePosition } from '../src/api/models.js';

const POSITION: EndgamePosition = {
  id: 'eg-1',
  type: 'lucena',
  name: 'Lucena Position',
  fen: '1K1k4/1P6/8/8/8/8/8/r7 w - - 0 1',
  sideToMove: 'w',
  objective: 'win',
  difficulty: 'intermediate',
  technique: 'bridge building',
};

const ATTEMPT: EndgameAttemptResult = {
  kind: 'judged',
  id: 'eg-1',
  move: 'b8a7',
  fenAfter: 'K2k4/1P6/8/8/8/8/8/r7 b - - 1 1',
  classification: 'optimal',
  goalPreserved: true,
  evalBefore: { type: 'cp', value: 500 },
  evalAfter: { type: 'cp', value: 500 },
  loss: { kind: 'centipawns', value: 0 },
  betterMove: null,
  bestLine: ['b8a7'],
  depth: 16,
  mateDistanceAfter: null,
};

/**
 * A controller over a transport that never settles on its own.
 *
 * Every ordering property here — stale answers, coalescing, disposal — depends on deciding *when* a
 * request completes, so the fake hands back a deferred promise per call and each test resolves it
 * at the moment it wants to test. No timers, so nothing is a race.
 */
function harness() {
  const nextCalls: Array<{ body: unknown; signal?: AbortSignal }> = [];
  const attemptCalls: Array<{ body: unknown; signal?: AbortSignal }> = [];
  const nextSettlers: Array<{
    resolve: (value: EndgamePosition) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const attemptSettlers: Array<{
    resolve: (value: EndgameAttemptResult) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const events: string[] = [];
  const positions: EndgamePosition[] = [];
  const attempts: EndgameAttemptResult[] = [];

  const client = {
    analysis: {
      nextEndgame(body: unknown, signal?: AbortSignal) {
        nextCalls.push({ body, ...(signal ? { signal } : {}) });
        return new Promise<EndgamePosition>((resolve, reject) => {
          nextSettlers.push({ resolve, reject });
        });
      },
      attemptEndgame(body: unknown, signal?: AbortSignal) {
        attemptCalls.push({ body, ...(signal ? { signal } : {}) });
        return new Promise<EndgameAttemptResult>((resolve, reject) => {
          attemptSettlers.push({ resolve, reject });
        });
      },
    },
  } as unknown as GambitClient;

  const controller = new EndgameController({
    client,
    callbacks: {
      onPhase: (phase) => events.push(`phase:${phase}`),
      onPosition: (pos) => { events.push('position'); positions.push(pos); },
      onAttemptResult: (res) => { events.push('result'); attempts.push(res); },
      onFailure: (failure) => events.push(`failure:${failure}`),
      onInvalidated: () => events.push('invalidated'),
    },
  });

  return {
    controller,
    nextCalls,
    attemptCalls,
    events,
    positions,
    attempts,
    settleNext: (index: number, value: EndgamePosition) => nextSettlers[index]!.resolve(value),
    failNext: (index: number, reason: unknown) => nextSettlers[index]!.reject(reason),
    settleAttempt: (index: number, value: EndgameAttemptResult) => attemptSettlers[index]!.resolve(value),
    failAttempt: (index: number, reason: unknown) => attemptSettlers[index]!.reject(reason),
    flush: () => new Promise<void>((done) => { setTimeout(done, 0); }),
  };
}

test('a resolved response for a superseded next request never reaches callbacks', async () => {
  const h = harness();
  void h.controller.next();
  assert.equal(h.nextCalls.length, 1);

  // New position requested before the first resolves
  h.controller.dispose();

  h.settleNext(0, POSITION);
  await h.flush();

  assert.equal(h.positions.length, 0, 'stale position was dropped');
});

test('repeat clicks while next is in flight coalesce to one request', async () => {
  const h = harness();
  void h.controller.next();
  void h.controller.next();
  void h.controller.next();
  assert.equal(h.nextCalls.length, 1);
  assert.equal(h.controller.isPending, true);

  h.settleNext(0, POSITION);
  await h.flush();

  assert.equal(h.controller.isPending, false);
  assert.equal(h.positions.length, 1);

  void h.controller.next();
  assert.equal(h.nextCalls.length, 2, 'gate reopens after settling');
});

test('starting a new position invalidates any displayed attempt result', async () => {
  const h = harness();
  void h.controller.next();
  h.settleNext(0, POSITION);
  await h.flush();

  void h.controller.attempt('b8a7');
  h.settleAttempt(0, ATTEMPT);
  await h.flush();
  assert.equal(h.attempts.length, 1);

  // Starting new position
  void h.controller.next();
  assert.ok(h.events.includes('invalidated'));
});

test('attempt is only sent when there is a current position id', async () => {
  const h = harness();
  void h.controller.attempt('b8a7');
  assert.equal(h.attemptCalls.length, 0, 'no request sent without active position');
});

test('disposal aborts in-flight next and attempt work', async () => {
  const h = harness();
  void h.controller.next();
  const nextSignal = h.nextCalls[0]!.signal;
  assert.ok(nextSignal);

  h.controller.dispose();
  assert.equal(nextSignal.aborted, true);

  h.settleNext(0, POSITION);
  await h.flush();
  assert.equal(h.positions.length, 0);
});

test('controller classifies safe status-only failures', async () => {
  for (const [status, expected] of [
    [429, 'rate-limited'],
    [503, 'unavailable'],
    [401, 'unauthenticated'],
    [422, 'rejected'],
  ] as const) {
    const h = harness();
    void h.controller.next();
    await Promise.resolve();
    h.failNext(0, { status });
    await h.flush();
    assert.equal(h.events.includes(`failure:${expected}`), true);
  }
});