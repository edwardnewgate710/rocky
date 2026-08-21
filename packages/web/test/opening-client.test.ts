import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GambitClient } from '../src/api/client.js';
import { MAX_OPENING_PLIES } from '../src/app/opening-controller.js';
import { FakeTransport, json } from './support/fake-transport.js';

const UCI = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
const RESPONSE = {
  moves: UCI,
  found: true,
  eco: 'C60',
  name: 'Ruy Lopez (Spanish Opening)',
  matchedMoves: 5,
  outOfBook: false,
  continuations: [{ move: 'a7a6', san: 'a6', eco: 'C70', name: 'Ruy Lopez, Morphy Defense' }],
};

/**
 * @param transport - the scripted transport to record against.
 * @returns a signed-in client, so the `auth: true` header path is exercised rather than skipped.
 */
function clientWith(transport: FakeTransport): GambitClient {
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, jitter: 'none' },
    sleep: async () => undefined,
  });
  client.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: { accessToken: 'token', tokenType: 'Bearer', expiresIn: 900, refreshExpiresAt: '2030-01-01T00:00:00Z' },
  });
  return client;
}

test('exploreOpening posts only the move order and variant, with authentication', async () => {
  const transport = new FakeTransport(() => json(200, RESPONSE));
  const result = await clientWith(transport).analysis.exploreOpening({
    variant: 'standard',
    moves: UCI,
  });
  assert.deepEqual(result, RESPONSE);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/openings/explore');
  assert.equal(transport.calls[0]!.headers['authorization'], 'Bearer token');
  assert.deepEqual(JSON.parse(String(transport.calls[0]!.body)), {
    variant: 'standard',
    moves: UCI,
  });
});

/**
 * The body is assembled field by field, so a caller passing something extra cannot smuggle it onto
 * the wire — the server refuses unknown properties outright, which would turn one stray field into
 * a 422 for the whole request.
 */
test('exploreOpening sends nothing the caller added beyond the published fields', async () => {
  const transport = new FakeTransport(() => json(200, RESPONSE));
  await clientWith(transport).analysis.exploreOpening({
    variant: 'standard',
    moves: UCI,
    depth: 30,
    stats: true,
  } as never);
  assert.deepEqual(Object.keys(JSON.parse(String(transport.calls[0]!.body))).sort(), [
    'moves', 'variant',
  ]);
});

test('exploreOpening forwards initialFen only when the caller supplies one', async () => {
  const transport = new FakeTransport().onEach(() => json(200, RESPONSE));
  const client = clientWith(transport);
  await client.analysis.exploreOpening({ variant: 'standard', moves: UCI, initialFen: 'x' });
  assert.equal(JSON.parse(String(transport.calls[0]!.body)).initialFen, 'x');

  await client.analysis.exploreOpening({ variant: 'standard', moves: UCI });
  assert.equal('initialFen' in JSON.parse(String(transport.calls[1]!.body)), false);
});

test('exploreOpening does not retry a failed POST', async () => {
  const transport = new FakeTransport(() => json(503, {
    error: { code: 'service_unavailable', message: 'unavailable', requestId: 'r1' },
  }));
  await assert.rejects(
    () => clientWith(transport).analysis.exploreOpening({ variant: 'standard', moves: UCI }),
  );
  assert.equal(transport.calls.length, 1);
});

/**
 * The client's ply ceiling is a second copy of a server constant, so it is held to the server's own
 * published value rather than to a number written twice.
 *
 * `openapi.json` is committed and regenerated from `MAX_EXPLORED_PLIES`, and a separate API test
 * asserts the committed document matches the generator — so this closes the loop without the web
 * package taking a dependency on the API package.
 */
test('the client ply ceiling matches the maxItems the API contract publishes', () => {
  const spec = JSON.parse(
    readFileSync(new URL('../../../api/openapi.json', import.meta.url), 'utf8'),
  ) as {
    components: {
      schemas: { OpeningExplorationRequest: { properties: { moves: { maxItems?: number } } } };
    };
  };
  assert.equal(
    spec.components.schemas.OpeningExplorationRequest.properties.moves.maxItems,
    MAX_OPENING_PLIES,
  );
});
