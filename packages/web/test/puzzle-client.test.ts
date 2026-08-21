import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, json } from './support/fake-transport.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

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

test('findPuzzle posts only the exact position target with authentication', async () => {
  const response = {
    kind: 'insufficient',
    fen: FEN,
    variant: 'standard',
    reason: 'not_enough_lines',
    bestMove: null,
    comparisonMove: null,
  };
  const transport = new FakeTransport(() => json(200, response));
  const result = await clientWith(transport).analysis.findPuzzle({ fen: FEN, variant: 'standard' });
  assert.deepEqual(result, response);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/analysis/puzzle');
  assert.equal(transport.calls[0]!.headers['authorization'], 'Bearer token');
  assert.deepEqual(JSON.parse(String(transport.calls[0]!.body)), { fen: FEN, variant: 'standard' });
});

test('findPuzzle does not retry a failed POST and double engine load', async () => {
  const transport = new FakeTransport(() => json(503, {
    error: { code: 'service_unavailable', message: 'unavailable', requestId: 'r1' },
  }));
  await assert.rejects(() => clientWith(transport).analysis.findPuzzle({ fen: FEN, variant: 'standard' }));
  assert.equal(transport.calls.length, 1);
});
