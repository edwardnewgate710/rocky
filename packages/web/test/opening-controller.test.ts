/**
 * `OpeningController` lifecycle: coalescing, staleness, invalidation and disposal.
 *
 * The property worth the file is the third one. Identification is keyed on the move order, and a
 * game moves on while a request is in flight, so a response that arrives after the board has
 * advanced must not overwrite what is on screen. Every test here drives that through a deferred
 * promise rather than a timer, so the ordering is asserted rather than raced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpeningController } from '../src/app/opening-controller.js';
import type { OpeningTarget } from '../src/app/opening-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { OpeningExplorationResponse } from '../src/api/models.js';

const RUY_LOPEZ = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];

/**
 * @param moves - the sequence the answer is about, echoed the way the server echoes it.
 * @returns a well-formed identification response.
 */
function response(moves: readonly string[]): OpeningExplorationResponse {
  return {
    moves: [...moves],
    found: true,
    eco: 'C60',
    name: 'Ruy Lopez (Spanish Opening)',
    matchedMoves: 5,
    outOfBook: moves.length > 5,
    continuations: [{ move: 'a7a6', san: 'a6', eco: 'C70', name: 'Ruy Lopez, Morphy Defense' }],
  };
}

/**
 * A controller over a transport that never settles on its own.
 *
 * Every ordering property here — stale answers, coalescing, disposal — depends on deciding *when* a
 * request completes, so the fake hands back a deferred promise per call and the test resolves it at
 * the moment it wants to test. No timers, so nothing is a race.
 */
function harness() {
  const calls: Array<{ body: { variant: string; moves: readonly string[] }; signal?: AbortSignal }> = [];
  const settlers: Array<{
    resolve: (value: OpeningExplorationResponse) => void;
    reject: (reason: unknown) => void;
  }> = [];
  let target: OpeningTarget | null = { variant: 'standard', moves: RUY_LOPEZ };
  const events: string[] = [];
  const results: OpeningExplorationResponse[] = [];
  const client = {
    analysis: {
      exploreOpening(body: { variant: string; moves: readonly string[] }, signal?: AbortSignal) {
        calls.push({ body, ...(signal ? { signal } : {}) });
        return new Promise<OpeningExplorationResponse>((resolve, reject) => {
          settlers.push({ resolve, reject });
        });
      },
    },
  } as unknown as GambitClient;
  const controller = new OpeningController({
    client,
    getTarget: () => target,
    callbacks: {
      onPhase: (phase) => events.push(`phase:${phase}`),
      onResult: (result) => { events.push('result'); results.push(result); },
      onFailure: (failure) => events.push(`failure:${failure}`),
      onInvalidated: () => events.push('invalidated'),
    },
  });
  return {
    controller,
    calls,
    events,
    results,
    setTarget: (next: OpeningTarget | null) => { target = next; },
    settle: (index: number, value: OpeningExplorationResponse) => settlers[index]!.resolve(value),
    fail: (index: number, reason: unknown) => settlers[index]!.reject(reason),
    /** Let the promise chain inside `identify` run to completion. */
    flush: () => new Promise<void>((done) => { setTimeout(done, 0); }),
  };
}

test('a resolved response for a superseded sequence never reaches the callbacks', async () => {
  const h = harness();
  void h.controller.identify();
  assert.equal(h.calls.length, 1);

  // The game moves on while the first look-up is still open.
  const advanced = { variant: 'standard', moves: [...RUY_LOPEZ, 'a7a6'] };
  h.setTarget(advanced);
  h.controller.sequenceChanged(advanced);

  h.settle(0, response(RUY_LOPEZ));
  await h.flush();

  assert.equal(h.results.length, 0, 'the stale answer was dropped');
  assert.ok(h.events.includes('invalidated'));
  assert.deepEqual(
    h.events.filter((event) => event === 'result'),
    [],
    'and no result phase was announced for it',
  );
});

test('a rejection for a superseded sequence does not surface as a failure', async () => {
  const h = harness();
  void h.controller.identify();
  const advanced = { variant: 'standard', moves: [...RUY_LOPEZ, 'a7a6'] };
  h.setTarget(advanced);
  h.controller.sequenceChanged(advanced);

  h.fail(0, new Error('network went away with the old request'));
  await h.flush();

  assert.deepEqual(
    h.events.filter((event) => event.startsWith('failure:')),
    [],
    'the reader is not shown an error belonging to a position they have left',
  );
});

test('repeat identification while one is in flight issues exactly one request', async () => {
  const h = harness();
  void h.controller.identify();
  void h.controller.identify();
  void h.controller.identify();
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.isPending, true);

  h.settle(0, response(RUY_LOPEZ));
  await h.flush();

  assert.equal(h.controller.isPending, false);
  assert.equal(h.results.length, 1);

  void h.controller.identify();
  assert.equal(h.calls.length, 2, 'and the gate reopens once the first has settled');
});

test('disposal aborts the request and suppresses a completion that arrives afterwards', async () => {
  const h = harness();
  void h.controller.identify();
  const signal = h.calls[0]!.signal;
  assert.ok(signal, 'the request carries a signal so it can be abandoned');

  h.controller.dispose();
  assert.equal(signal.aborted, true);

  h.settle(0, response(RUY_LOPEZ));
  await h.flush();
  assert.equal(h.results.length, 0);
});

test('disposal stops a later identification from starting at all', async () => {
  const h = harness();
  h.controller.dispose();
  void h.controller.identify();
  assert.equal(h.calls.length, 0);
});

test('being told the same sequence again keeps the displayed result', async () => {
  const h = harness();
  void h.controller.identify();
  h.settle(0, response(RUY_LOPEZ));
  await h.flush();
  assert.equal(h.results.length, 1);

  h.controller.sequenceChanged({ variant: 'standard', moves: [...RUY_LOPEZ] });

  assert.equal(
    h.events.includes('invalidated'),
    false,
    'an unchanged ledger must not throw away an answer the reader is still reading',
  );
});

/**
 * Two sequences that reach the same position are different questions.
 *
 * The server answers them differently — it matches on the move order, not the board (ADR-0127) —
 * so a controller keyed on the position would let one transposition's answer stand for the other.
 */
test('a transposed sequence is treated as a different question, not the same one', async () => {
  const h = harness();
  void h.controller.identify();
  h.settle(0, response(RUY_LOPEZ));
  await h.flush();

  h.controller.sequenceChanged({
    variant: 'standard',
    moves: ['g1f3', 'b8c6', 'e2e4', 'e7e5', 'f1b5'],
  });

  assert.ok(h.events.includes('invalidated'));
});

test('a variant change invalidates even when the moves are identical', async () => {
  const h = harness();
  void h.controller.identify();
  h.settle(0, response(RUY_LOPEZ));
  await h.flush();

  h.controller.sequenceChanged({ variant: 'crazyhouse', moves: [...RUY_LOPEZ] });
  assert.ok(h.events.includes('invalidated'));
});

test('nothing is requested when there is no usable sequence', async () => {
  const h = harness();
  h.setTarget(null);
  void h.controller.identify();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.events, []);
});

test('the request carries the variant and moves it was asked about, and nothing else', async () => {
  const h = harness();
  void h.controller.identify();
  assert.deepEqual(h.calls[0]!.body, { variant: 'standard', moves: RUY_LOPEZ });
});

/**
 * The target can disappear rather than change: the ledger outruns the server ceiling, stops being a
 * contiguous run from ply 1, or the variant leaves standard. `sequenceChanged` cannot express that —
 * it needs a target to compare — so a displayed result would otherwise keep describing a move order
 * the game no longer has. Raised in the Qodo and CodeRabbit reviews of PR #150.
 */
test('losing the target invalidates a displayed result', async () => {
  const h = harness();
  void h.controller.identify();
  h.settle(0, response(RUY_LOPEZ));
  await h.flush();
  assert.equal(h.results.length, 1);

  h.controller.targetLost();
  assert.ok(h.events.includes('invalidated'));
  assert.equal(h.events.at(-1), 'phase:idle');
});

test('losing the target aborts an in-flight look-up and suppresses its answer', async () => {
  const h = harness();
  void h.controller.identify();
  const signal = h.calls[0]!.signal;

  h.controller.targetLost();
  assert.equal(signal!.aborted, true);

  h.settle(0, response(RUY_LOPEZ));
  await h.flush();
  assert.equal(h.results.length, 0);
});

/** Nothing was displayed, so there is nothing to take back — and no note to overwrite. */
test('losing a target that was never set says nothing', () => {
  const h = harness();
  h.controller.targetLost();
  assert.deepEqual(h.events, []);
});
