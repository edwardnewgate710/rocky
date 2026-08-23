/**
 * The commentary client calls, asserted at the transport.
 *
 * The controller tests assert against a fake `client.tournaments`, which proves what the controller
 * asks for and nothing about what goes on the wire. This file is the other half: it drives the real
 * `GambitClient` through a fake transport and reads the request it produced. Without it, a client
 * that started sending a request body would pass every other test in the package — the mutation that
 * added `body: { roundIndex }` to `roundRecap` did exactly that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import type { RetryPolicy } from '../src/net/retry.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { TournamentGameCommentary, TournamentRoundRecap } from '../src/api/models.js';

const NO_RETRY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' };

/**
 * @param transport - the scripted transport to record against.
 * @returns a signed-in client, so the `auth: true` path both routes declare is exercised rather
 * than short-circuited by a missing session.
 */
function make(transport: FakeTransport): GambitClient {
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: NO_RETRY,
    sleep: async () => {},
    now: () => 1000,
  });
  client.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  return client;
}

const COMMENTARY: TournamentGameCommentary = {
  tournamentId: 't1',
  gameId: 'g1',
  round: 0,
  white: 'alice',
  black: 'bob',
  result: '1-0',
  tournamentResult: null,
  termination: 'resign',
  ply: 3,
  fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
  variant: 'standard',
  finalMove: { uci: 'b8c6', san: 'Nc6' },
  citation: {
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',
    move: 'b8c6',
    evalKind: 'cp',
    evalValue: 24,
    evalLabel: '+0.24',
    bestLine: ['b8c6'],
    depth: 18,
  },
  commentary: 'A sharp finish.',
  providerId: 'stub',
  model: 'stub-1',
};

const RECAP: TournamentRoundRecap = {
  tournamentId: 't1',
  round: 2,
  results: [{ white: 'alice', black: 'bob', result: 'white_win' }],
  standings: [{ rank: 1, player: 'alice', points: 1 }],
  pairingsNarrated: 1,
  narrative: 'Alice leads.',
  providerId: 'stub',
  model: 'stub-1',
};

test('game commentary posts to the path and sends no body', async () => {
  const t = new FakeTransport(() => json(200, COMMENTARY));
  await make(t).tournaments.gameCommentary('t1', 'g1');

  const call = t.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.test/v1/tournaments/t1/games/g1/commentary');
  assert.equal(call.body, undefined, 'the server derives every fact; a body is a 422');
  assert.equal(call.headers['authorization'], 'Bearer token');
});

test('round recap posts to the path and sends no body', async () => {
  const t = new FakeTransport(() => json(200, RECAP));
  await make(t).tournaments.roundRecap('t1', 2);

  const call = t.calls[0]!;
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'https://api.test/v1/tournaments/t1/rounds/2/recap');
  assert.equal(call.body, undefined, 'the server derives every fact; a body is a 422');
  assert.equal(call.headers['authorization'], 'Bearer token');
});

test('both paths are encoded, so an id cannot escape its segment', async () => {
  const t = new FakeTransport(() => json(200, COMMENTARY)).onEach(() => json(200, RECAP));
  const client = make(t);
  // Both segments carry `/../`, not just the first. A gameId with only a space in it would be
  // encoded identically by `encodeURI`, which leaves `/` alive as a route separator — so that half
  // of this assertion could not have detected the weaker encoder. Raised in the CodeRabbit review.
  await client.tournaments.gameCommentary('t 1/../x', 'g 1/../y');
  await client.tournaments.roundRecap('t 1/../x', 3);

  assert.equal(
    t.calls[0]!.url,
    'https://api.test/v1/tournaments/t%201%2F..%2Fx/games/g%201%2F..%2Fy/commentary',
  );
  assert.equal(t.calls[1]!.url, 'https://api.test/v1/tournaments/t%201%2F..%2Fx/rounds/3/recap');
});

test('the rounds read is a plain GET with no body', async () => {
  const t = new FakeTransport(() =>
    json(200, [{ roundIndex: 0, pairings: [{ kind: 'game', white: 'w', black: 'b', gameId: 'g1' }] }]),
  );
  const rounds = await make(t).tournaments.rounds('t1');

  assert.equal(rounds.length, 1);
  assert.equal(t.calls[0]!.method, 'GET');
  assert.equal(t.calls[0]!.url, 'https://api.test/v1/tournaments/t1/rounds');
  assert.equal(t.calls[0]!.body, undefined);
});
