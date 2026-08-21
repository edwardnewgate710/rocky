import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, json } from './support/fake-transport.js';
import type { EndgameAttemptResult, EndgamePosition } from '../src/api/models.js';

const POSITION_RESPONSE: EndgamePosition = {
  id: 'eg-1',
  type: 'lucena',
  name: 'Lucena Position',
  fen: '1K1k4/1P6/8/8/8/8/8/r7 w - - 0 1',
  sideToMove: 'w',
  objective: 'win',
  difficulty: 'intermediate',
  technique: 'bridge building',
};

const ATTEMPT_RESPONSE: EndgameAttemptResult = {
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
  bestLine: ['b8a7', 'd8d7'],
  depth: 18,
  mateDistanceAfter: null,
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

test('nextEndgame posts only published fields with authentication', async () => {
  const transport = new FakeTransport(() => json(200, POSITION_RESPONSE));
  const result = await clientWith(transport).analysis.nextEndgame({
    type: 'lucena',
    difficulty: 'intermediate',
  });
  assert.deepEqual(result, POSITION_RESPONSE);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/endgames/next');
  assert.equal(transport.calls[0]!.headers['authorization'], 'Bearer token');
  assert.deepEqual(JSON.parse(String(transport.calls[0]!.body)), {
    type: 'lucena',
    difficulty: 'intermediate',
  });
});

test('nextEndgame sends nothing caller added beyond published fields', async () => {
  const transport = new FakeTransport(() => json(200, POSITION_RESPONSE));
  await clientWith(transport).analysis.nextEndgame({
    type: 'lucena',
    difficulty: 'intermediate',
    strayField: 'unexpected',
  } as never);
  assert.deepEqual(Object.keys(JSON.parse(String(transport.calls[0]!.body))).sort(), [
    'difficulty',
    'type',
  ]);
});

test('nextEndgame does not retry a failed POST', async () => {
  const transport = new FakeTransport(() => json(503, {
    error: { code: 'service_unavailable', message: 'unavailable', requestId: 'r1' },
  }));
  await assert.rejects(
    () => clientWith(transport).analysis.nextEndgame(),
  );
  assert.equal(transport.calls.length, 1);
});

test('attemptEndgame posts only id and move with authentication', async () => {
  const transport = new FakeTransport(() => json(200, ATTEMPT_RESPONSE));
  const result = await clientWith(transport).analysis.attemptEndgame({
    id: 'eg-1',
    move: 'b8a7',
  });
  assert.deepEqual(result, ATTEMPT_RESPONSE);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/endgames/attempt');
  assert.equal(transport.calls[0]!.headers['authorization'], 'Bearer token');
  assert.deepEqual(JSON.parse(String(transport.calls[0]!.body)), {
    id: 'eg-1',
    move: 'b8a7',
  });
});

test('attemptEndgame sends nothing caller added beyond published fields', async () => {
  const transport = new FakeTransport(() => json(200, ATTEMPT_RESPONSE));
  await clientWith(transport).analysis.attemptEndgame({
    id: 'eg-1',
    move: 'b8a7',
    eval: 500,
  } as never);
  assert.deepEqual(Object.keys(JSON.parse(String(transport.calls[0]!.body))).sort(), [
    'id',
    'move',
  ]);
});

test('attemptEndgame does not retry a failed POST', async () => {
  const transport = new FakeTransport(() => json(503, {
    error: { code: 'service_unavailable', message: 'unavailable', requestId: 'r1' },
  }));
  await assert.rejects(
    () => clientWith(transport).analysis.attemptEndgame({ id: 'eg-1', move: 'b8a7' }),
  );
  assert.equal(transport.calls.length, 1);
});