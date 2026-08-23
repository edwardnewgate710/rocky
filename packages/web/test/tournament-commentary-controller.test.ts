/**
 * `TournamentCommentaryController` lifecycle: coalescing, staleness, invalidation and disposal.
 *
 * The staleness property is the reason the file exists, and it is a different problem from the
 * coaching section's. A finished game and a completed round cannot change, so a late answer is not
 * wrong about chess — it is about a *different page* than the one now open. A reader clicking
 * through two tournaments while a request is in flight must never see the first one's narrative
 * under the second one's heading.
 *
 * The second property is cost. Each accepted request spends a metered completion, so a duplicate
 * click must coalesce rather than buy the same paragraph twice.
 *
 * Every test drives the ordering through a deferred promise rather than a timer, so it is asserted
 * rather than raced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TournamentCommentaryController } from '../src/app/tournament-commentary-controller.js';
import type { GambitClient } from '../src/api/client.js';
import type { TournamentGameCommentary, TournamentRoundRecap } from '../src/api/models.js';

/**
 * @param gameId - the game the answer is about, echoed the way the server echoes it.
 * @returns a commentary response whose narrative names the game, so a stale answer is identifiable.
 */
function commentary(gameId: string): TournamentGameCommentary {
  return {
    tournamentId: 't1',
    gameId,
    round: 0,
    white: 'alice',
    black: 'bob',
    result: '1-0',
  tournamentResult: null,
    termination: 'resign',
    ply: 31,
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    variant: 'standard',
    finalMove: { uci: 'b8c6', san: 'Nc6' },
    citation: {
      fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
      move: 'b8c6',
      evalKind: 'cp',
      evalValue: 24,
      evalLabel: '+0.24',
      bestLine: ['b8c6', 'f1b5'],
      depth: 18,
    },
    commentary: `narrative for ${gameId}`,
    providerId: 'stub',
    model: 'stub-1',
  };
}

/**
 * @param round - the round the answer is about.
 * @returns a recap whose narrative names the round, so a stale answer is identifiable.
 */
function recap(round: number): TournamentRoundRecap {
  return {
    tournamentId: 't1',
    round,
    results: [{ white: 'alice', black: 'bob', result: 'white_win' }],
    standings: [
      { rank: 1, player: 'alice', points: 1 },
      { rank: 2, player: 'bob', points: 0 },
    ],
    pairingsNarrated: 1,
    narrative: `recap of round ${String(round)}`,
    providerId: 'stub',
    model: 'stub-1',
  };
}

interface Call {
  readonly kind: 'game' | 'round';
  /**
   * Every argument the client passed, captured with a rest parameter.
   *
   * The first draft of this fake declared `(tournamentId, gameId, signal?)` and recorded
   * `body: undefined` as a literal, so the assertion that no body was sent held for every possible
   * client — including one that had started sending one. A fake that cannot observe the thing under
   * test turns its own shape into the assertion. Raised in the CodeRabbit review of PR #153.
   */
  readonly args: readonly unknown[];
}

/**
 * A controller over a transport that never settles on its own.
 *
 * Each call hands back a deferred promise, so every test decides exactly when a request completes.
 * No timers, so nothing is a race.
 */
function harness() {
  const calls: Call[] = [];
  const settlers: Array<{
    resolve: (value: never) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const events: string[] = [];
  const results: unknown[] = [];

  /** @returns a promise the test settles by index, so no ordering depends on a timer. */
  const defer = (): Promise<never> =>
    new Promise<never>((resolve, reject) => {
      settlers.push({ resolve, reject });
    });

  const client = {
    tournaments: {
      gameCommentary(...args: readonly unknown[]) {
        calls.push({ kind: 'game', args });
        return defer();
      },
      roundRecap(...args: readonly unknown[]) {
        calls.push({ kind: 'round', args });
        return defer();
      },
    },
  } as unknown as GambitClient;

  const controller = new TournamentCommentaryController({
    client,
    callbacks: {
      onPhase: (phase) => events.push(`phase:${phase}`),
      onResult: (result) => {
        events.push('result');
        results.push(result);
      },
      onFailure: (failure) => events.push(`failure:${failure}`),
      onInvalidated: () => events.push('invalidated'),
    },
  });

  /**
   * @param call - a recorded call.
   * @returns the signal it carried, if any.
   */
  const signalOf = (call: Call): AbortSignal | undefined =>
    call.args.find((a): a is AbortSignal => a instanceof AbortSignal);

  /**
   * @param call - a recorded call.
   * @returns the resource it named — a game id or a round index rendered as a string.
   */
  const refOf = (call: Call): string => String(call.args[1]);

  return {
    controller,
    calls,
    signalOf,
    refOf,
    events,
    results,
    settle: (index: number, value: unknown) => settlers[index]!.resolve(value as never),
    fail: (index: number, reason: unknown) => settlers[index]!.reject(reason),
    flush: () => new Promise<void>((done) => { setTimeout(done, 0); }),
  };
}

test('a request carries no body, because the server derives every fact itself', async () => {
  const h = harness();
  void h.controller.request({ kind: 'game', tournamentId: 't1', gameId: 'g1' });
  void h.controller.request({ kind: 'round', tournamentId: 't1', round: 2 });
  await h.flush();

  // Asserting on what the client actually passed, not on a 200 coming back: a client that began
  // sending a body would still get a 200 from a fake, and the whole point of the contract is what is
  // absent. The fake captures every argument, so a third one that is not a signal — the only shape a
  // body could take on these signatures — fails here.
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    // Two path values and the cancellation signal. Nothing else is part of the contract, and a
    // request body would arrive as a further argument or in place of the signal — both of which
    // this fails on.
    assert.equal(call.args.length, 3, `${call.kind} passed an unexpected number of arguments`);
    assert.equal(typeof call.args[0], 'string');
    assert.ok(call.args[2] instanceof AbortSignal, `${call.kind} passed a third argument that is not a signal`);
    for (const arg of call.args) {
      assert.equal(
        typeof arg === 'object' && arg !== null && !(arg instanceof AbortSignal),
        false,
        'an object argument is a request body',
      );
    }
  }
  assert.deepEqual(h.calls.map((c) => [c.kind, h.refOf(c)]), [['game', 'g1'], ['round', '2']]);
});

test('an answer about a page the reader has left never reaches the callbacks', async () => {
  const h = harness();
  void h.controller.request({ kind: 'round', tournamentId: 't1', round: 0 });
  assert.equal(h.calls.length, 1);

  // The reader opens a different round while the first request is still open.
  void h.controller.request({ kind: 'round', tournamentId: 't1', round: 1 });
  assert.equal(h.calls.length, 2);
  assert.equal(h.signalOf(h.calls[0]!)?.aborted, true, 'the abandoned request is aborted');

  // The abandoned request settles anyway, as a request already resolved and queued would.
  h.settle(0, recap(0));
  h.settle(1, recap(1));
  await h.flush();

  assert.equal(h.results.length, 1);
  assert.deepEqual(h.results[0], { kind: 'round', value: recap(1) });
});

test('a repeated request for the same thing buys nothing twice', async () => {
  const h = harness();
  void h.controller.request({ kind: 'game', tournamentId: 't1', gameId: 'g1' });
  void h.controller.request({ kind: 'game', tournamentId: 't1', gameId: 'g1' });
  void h.controller.request({ kind: 'game', tournamentId: 't1', gameId: 'g1' });

  assert.equal(h.calls.length, 1, 'each accepted request spends a metered completion');
  assert.equal(h.signalOf(h.calls[0]!)?.aborted, false);
});

test('signing out clears the commentary on screen, not just the control', async () => {
  const h = harness();
  void h.controller.request({ kind: 'game', tournamentId: 't1', gameId: 'g1' });
  h.settle(0, commentary('g1'));
  await h.flush();
  assert.equal(h.results.length, 1);

  h.controller.targetLost();

  assert.ok(h.events.includes('invalidated'), 'the rendered answer is dropped');
  assert.equal(h.events.at(-1), 'phase:idle');
});

test('disposal abandons what is open and refuses to start anything more', async () => {
  const h = harness();
  void h.controller.request({ kind: 'round', tournamentId: 't1', round: 0 });

  h.controller.dispose();
  assert.equal(h.signalOf(h.calls[0]!)?.aborted, true);

  void h.controller.request({ kind: 'round', tournamentId: 't1', round: 1 });
  assert.equal(h.calls.length, 1, 'a disposed controller issues nothing further');

  h.settle(0, recap(0));
  await h.flush();
  assert.equal(h.results.length, 0);
});

test('an abandoned request reports no failure, because nobody made a mistake', async () => {
  const h = harness();
  void h.controller.request({ kind: 'round', tournamentId: 't1', round: 0 });
  void h.controller.request({ kind: 'round', tournamentId: 't1', round: 1 });

  // The abandoned request rejects with the abort, as fetch does.
  h.fail(0, Object.assign(new Error('aborted'), { name: 'AbortError' }));
  await h.flush();

  assert.equal(
    h.events.some((e) => e.startsWith('failure:')),
    false,
    'an error shown here would blame the reader for moving on',
  );
});

test('a failure is classified and reported once', async () => {
  const h = harness();
  void h.controller.request({ kind: 'game', tournamentId: 't1', gameId: 'g1' });
  h.fail(0, Object.assign(new Error('nope'), { status: 429 }));
  await h.flush();

  assert.ok(h.events.some((e) => e.startsWith('failure:')));
  assert.equal(h.events.at(-1), 'phase:error');
  assert.equal(h.results.length, 0);
});
