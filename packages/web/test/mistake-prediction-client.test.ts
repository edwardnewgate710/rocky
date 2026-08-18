/**
 * Client bindings for the engine-grounded mistake prediction endpoint (M15 inc 5).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import type { HttpTransport } from '../src/ports/http.js';
import { FakeTransport, abortableHang, json } from './support/fake-transport.js';
import {
  HttpError,
  RateLimitError,
  RequestAbortedError,
  ServerError,
  ServiceUnavailableError,
} from '../src/net/errors.js';
import type { MistakePredictionResponse } from '../src/api/models.js';

function makeClient(transport: HttpTransport): GambitClient {
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: async () => undefined,
    now: () => 1000,
  });
  client.session.adopt({
    user: { id: 'u1', handle: 'alice', country: null, createdAt: '2026-01-01T00:00:00Z', roles: ['user'] },
    tokens: {
      accessToken: 'tok-A',
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshExpiresAt: '2030-01-01T00:00:00Z',
    },
  });
  return client;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BEFORE_MATE_FEN = 'r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 0 4';

test('posts to /v1/analysis/mistake-prediction with authentication and only the three required body fields', async () => {
  const responseData: MistakePredictionResponse = {
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
    classification: 'ok',
    before: { evalKind: 'cp', evalValue: 35, evalLabel: '+0.35' },
    after: { kind: 'evaluation', evalKind: 'cp', evalValue: -35, evalLabel: '-0.35' },
    centipawnLoss: 0,
    bestMove: 'e2e4',
    bestLine: ['e2e4', 'e7e5', 'g1f3'],
    depth: 16,
  };

  const transport = new FakeTransport(() => json(200, responseData));
  const client = makeClient(transport);

  const result = await client.analysis.predictMistake({
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
  });

  assert.equal(transport.calls.length, 1);
  const req = transport.calls[0]!;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://api.test/v1/analysis/mistake-prediction');
  assert.equal(req.headers['authorization'], 'Bearer tok-A');
  assert.equal(req.headers['content-type'], 'application/json');

  assert.ok(typeof req.body === 'string');
  const parsed = JSON.parse(req.body) as Record<string, unknown>;
  const keys = Object.keys(parsed).sort();
  assert.deepEqual(keys, ['fen', 'move', 'variant']);
  assert.equal(parsed['fen'], START_FEN);
  assert.equal(parsed['variant'], 'standard');
  assert.equal(parsed['move'], 'e2e4');

  assert.deepEqual(result, responseData);
});

test('preserves terminal move outcome in after field without invented evaluation', async () => {
  const terminalResponse: MistakePredictionResponse = {
    fen: BEFORE_MATE_FEN,
    variant: 'standard',
    move: 'f3f7',
    classification: 'ok',
    before: { evalKind: 'mate', evalValue: 1, evalLabel: 'mate in 1' },
    after: {
      kind: 'terminal',
      reason: 'checkmate',
      result: '1-0',
      label: 'checkmate — White wins',
    },
    centipawnLoss: null,
    bestMove: 'f3f7',
    bestLine: ['f3f7'],
    depth: 12,
  };

  const transport = new FakeTransport(() => json(200, terminalResponse));
  const client = makeClient(transport);

  const result = await client.analysis.predictMistake({
    fen: BEFORE_MATE_FEN,
    variant: 'standard',
    move: 'f3f7',
  });

  assert.equal(result.after.kind, 'terminal');
  if (result.after.kind === 'terminal') {
    assert.equal(result.after.reason, 'checkmate');
    assert.equal(result.after.result, '1-0');
    assert.equal(result.after.label, 'checkmate — White wins');
  }
  assert.equal(result.centipawnLoss, null);
  assert.equal(result.classification, 'ok');
  assert.deepEqual(result, terminalResponse);
});

test('rejects with RateLimitError on 429 rate-limited response', async () => {
  const transport = new FakeTransport(() =>
    json(429, {
      error: {
        code: 'rate_limited',
        message: 'Too many mistake prediction requests. Try again shortly.',
        requestId: 'req-rate-limit-1',
      },
    }),
  );
  const client = makeClient(transport);

  await assert.rejects(
    () =>
      client.analysis.predictMistake({
        fen: START_FEN,
        variant: 'standard',
        move: 'e2e4',
      }),
    (err: unknown) => {
      assert.ok(err instanceof RateLimitError, 'error must be an instance of RateLimitError');
      assert.ok(err instanceof HttpError, 'error must be an instance of HttpError');
      assert.equal(err.status, 429);
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.message, 'Too many mistake prediction requests. Try again shortly.');
      assert.equal(err.requestId, 'req-rate-limit-1');
      return true;
    },
  );

  assert.equal(transport.calls.length, 1, 'mistake prediction request must not be retried');
});

test('rejects with ServiceUnavailableError on 503 response when service is unavailable', async () => {
  const transport = new FakeTransport(() =>
    json(503, {
      error: {
        code: 'service_unavailable',
        message: 'mistake prediction is not configured',
        requestId: 'req-503-1',
      },
    }),
  );
  const client = makeClient(transport);

  await assert.rejects(
    () =>
      client.analysis.predictMistake({
        fen: START_FEN,
        variant: 'standard',
        move: 'e2e4',
      }),
    (err: unknown) => {
      assert.ok(err instanceof ServiceUnavailableError, 'error must be an instance of ServiceUnavailableError');
      assert.ok(err instanceof ServerError, 'error must be an instance of ServerError');
      assert.ok(err instanceof HttpError, 'error must be an instance of HttpError');
      assert.equal(err.status, 503);
      assert.equal(err.code, 'service_unavailable');
      assert.equal(err.message, 'mistake prediction is not configured');
      assert.equal(err.requestId, 'req-503-1');
      return true;
    },
  );

  assert.equal(transport.calls.length, 1, 'mistake prediction request must not be retried');
});

test('rejects with RequestAbortedError when caller aborts in-flight request', async () => {
  const transport = abortableHang();
  const client = makeClient(transport);
  const controller = new AbortController();

  const promise = client.analysis.predictMistake(
    {
      fen: START_FEN,
      variant: 'standard',
      move: 'e2e4',
    },
    controller.signal,
  );

  controller.abort();

  await assert.rejects(
    promise,
    (err: unknown) => {
      assert.ok(err instanceof RequestAbortedError, 'error must be an instance of RequestAbortedError');
      assert.equal(err.kind, 'aborted');
      return true;
    },
  );
});

test('GambitClient.predictMistake delegates directly to analysis.predictMistake', async () => {
  const responseData: MistakePredictionResponse = {
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
    classification: 'ok',
    before: { evalKind: 'cp', evalValue: 35, evalLabel: '+0.35' },
    after: { kind: 'evaluation', evalKind: 'cp', evalValue: -35, evalLabel: '-0.35' },
    centipawnLoss: 0,
    bestMove: 'e2e4',
    bestLine: ['e2e4', 'e7e5', 'g1f3'],
    depth: 16,
  };

  const transport = new FakeTransport(() => json(200, responseData));
  const client = makeClient(transport);

  const result = await client.predictMistake({
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
  });

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/analysis/mistake-prediction');
  assert.deepEqual(result, responseData);
});
