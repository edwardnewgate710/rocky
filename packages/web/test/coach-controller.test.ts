/**
 * `CoachController` lifecycle: coalescing, staleness, invalidation and disposal.
 *
 * Staleness is the property worth the file, and it matters more here than for any sibling section.
 * Coaching is the slowest request the API serves — up to four engine searches and a provider call —
 * so a player moving twice while one is in flight is the ordinary case, not the edge case. An answer
 * about a position two moves stale would sit beside a board that has moved on, and every word of it
 * would be wrong about what the reader is looking at.
 *
 * Every test drives the ordering through a deferred promise rather than a timer, so it is asserted
 * rather than raced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CoachController } from '../src/app/coach-controller.js';
import type { CoachTarget } from '../src/app/coach-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { CoachResponse } from '../src/api/models.js';

const ITALIAN_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const ITALIAN_MOVES = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'];

/**
 * @param fen - the position the answer is about, echoed the way the server echoes it.
 * @returns a response with every section omitted, which is a real server answer and keeps these
 * lifecycle tests from depending on the shape of any one section.
 */
function response(fen: string): CoachResponse {
  return {
    fen,
    variant: 'standard',
    move: null,
    mistake: { kind: 'omitted', reason: 'not_requested' },
    explanation: { kind: 'omitted', reason: 'not_requested' },
    opening: { kind: 'omitted', reason: 'not_applicable' },
    puzzle: { kind: 'omitted', reason: 'not_applicable' },
    endgame: { kind: 'omitted', reason: 'not_applicable' },
    featuresFired: [],
  };
}

/**
 * A controller over a transport that never settles on its own.
 *
 * The fake hands back a deferred promise per call so each test decides exactly when a request
 * completes. No timers, so nothing is a race.
 */
function harness() {
  const calls: Array<{ body: { fen: string; variant: string }; signal?: AbortSignal }> = [];
  const settlers: Array<{
    resolve: (value: CoachResponse) => void;
    reject: (reason: unknown) => void;
  }> = [];
  let target: CoachTarget | null = {
    fen: ITALIAN_FEN,
    variant: 'standard',
    moves: ITALIAN_MOVES,
  };
  const events: string[] = [];
  const results: CoachResponse[] = [];
  const client = {
    analysis: {
      coach(body: { fen: string; variant: string }, signal?: AbortSignal) {
        calls.push({ body, ...(signal ? { signal } : {}) });
        return new Promise<CoachResponse>((resolve, reject) => {
          settlers.push({ resolve, reject });
        });
      },
    },
  } as unknown as GambitClient;
  const controller = new CoachController({
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
    setTarget: (next: CoachTarget | null) => { target = next; },
    settle: (index: number, value: CoachResponse) => settlers[index]!.resolve(value),
    fail: (index: number, reason: unknown) => settlers[index]!.reject(reason),
    /** Let the promise chain inside `coach` run to completion. */
    flush: () => new Promise<void>((done) => { setTimeout(done, 0); }),
  };
}

test('an answer about a position the board has left never reaches the callbacks', async () => {
  const h = harness();
  void h.controller.coach();
  assert.equal(h.calls.length, 1);

  // The game moves on while the coaching request is still open.
  const advanced = { fen: 'advanced-fen', variant: 'standard', moves: [...ITALIAN_MOVES, 'g8f6'] };
  h.setTarget(advanced);
  h.controller.positionChanged(advanced);

  h.settle(0, response(ITALIAN_FEN));
  await h.flush();

  assert.deepEqual(h.results, [], 'a stale coaching answer was rendered');
  assert.equal(h.events.includes('invalidated'), true);
});

test('asking twice for the same position coalesces rather than paying twice', async () => {
  const h = harness();
  void h.controller.coach();
  void h.controller.coach();

  // One request, not two. This is the most expensive endpoint in the API, so a double-click must
  // not buy two of them.
  assert.equal(h.calls.length, 1);

  h.settle(0, response(ITALIAN_FEN));
  await h.flush();
  assert.equal(h.results.length, 1);
});

test('asking about a new position abandons the request for the old one', async () => {
  const h = harness();
  void h.controller.coach();
  const first = h.calls[0]?.signal;

  const advanced = { fen: 'advanced-fen', variant: 'standard', moves: ITALIAN_MOVES };
  h.setTarget(advanced);
  void h.controller.coach();

  assert.equal(h.calls.length, 2);
  assert.equal(first?.aborted, true, 'the superseded request was left running');
  assert.equal(h.calls[1]?.body.fen, 'advanced-fen');
});

test('disposal aborts what is open and refuses to start anything further', async () => {
  const h = harness();
  void h.controller.coach();
  const signal = h.calls[0]?.signal;

  h.controller.dispose();
  assert.equal(signal?.aborted, true);

  // A response that was already in flight must not render into a torn-down section.
  h.settle(0, response(ITALIAN_FEN));
  await h.flush();
  assert.deepEqual(h.results, []);

  // And nothing new starts.
  await h.controller.coach();
  assert.equal(h.calls.length, 1);
});

test('a failure is classified rather than reported as one undifferentiated error', async () => {
  const h = harness();
  void h.controller.coach();
  h.fail(0, { status: 429 });
  await h.flush();

  // 429 and 503 need different words: one says wait a moment, the other says this server cannot
  // do it right now. Collapsing them would tell a rate-limited reader the feature was broken.
  assert.equal(h.events.includes('failure:rate-limited'), true);
  assert.equal(h.events.includes('failure:unavailable'), false);
});

test('a redundant position notification does not discard a good answer', async () => {
  const h = harness();
  void h.controller.coach();
  h.settle(0, response(ITALIAN_FEN));
  await h.flush();
  assert.equal(h.results.length, 1);

  // The same target, announced again — a re-render, a resync at an unchanged position. Nothing
  // changed, so the answer on screen is still about the position on the board.
  h.controller.positionChanged({ fen: ITALIAN_FEN, variant: 'standard', moves: ITALIAN_MOVES });
  assert.equal(h.events.includes('invalidated'), false);
});

test('losing the position clears the section', async () => {
  const h = harness();
  void h.controller.coach();
  h.settle(0, response(ITALIAN_FEN));
  await h.flush();

  h.controller.targetLost();
  assert.equal(h.events.includes('invalidated'), true);
});
