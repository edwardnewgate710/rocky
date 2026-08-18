/**
 * Client bindings for the engine-grounded move explanation endpoint (M15 inc 4).
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
import type { MoveExplanationResponse } from '../src/api/models.js';

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

test('posts to /v1/ai/move-explanation with authentication and only the three required body fields', async () => {
  const responseData: MoveExplanationResponse = {
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
    explanation: 'e4 stakes a claim in the center and frees lines for the queen and bishop.',
    citation: {
      moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: -35, evalLabel: '-0.35' },
      evalKind: 'cp',
      evalValue: 35,
      evalLabel: '+0.35',
      bestMove: 'e2e4',
      bestLine: ['e2e4', 'e7e5', 'g1f3'],
      depth: 16,
    },
    providerId: 'mock-llm',
    model: 'mock-model',
  };

  const transport = new FakeTransport(() => json(200, responseData));
  const client = makeClient(transport);

  const result = await client.analysis.explainMove({
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
  });

  assert.equal(transport.calls.length, 1);
  const req = transport.calls[0]!;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://api.test/v1/ai/move-explanation');
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

test('returns successful explanation response with intact evaluation citation', async () => {
  const responseData: MoveExplanationResponse = {
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
    explanation: 'e4 controls key central squares and opens diagonals.',
    citation: {
      moveOutcome: {
        kind: 'evaluation',
        evalKind: 'cp',
        evalValue: -35,
        evalLabel: '-0.35',
      },
      evalKind: 'cp',
      evalValue: 35,
      evalLabel: '+0.35',
      bestMove: 'e2e4',
      bestLine: ['e2e4', 'e7e5', 'g1f3'],
      depth: 16,
    },
    providerId: 'mock-llm',
    model: 'mock-model',
  };

  const transport = new FakeTransport(() => json(200, responseData));
  const client = makeClient(transport);

  const result = await client.analysis.explainMove({
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
  });

  assert.equal(result.citation.moveOutcome.kind, 'evaluation');
  if (result.citation.moveOutcome.kind === 'evaluation') {
    assert.equal(result.citation.moveOutcome.evalKind, 'cp');
    assert.equal(result.citation.moveOutcome.evalValue, -35);
    assert.equal(result.citation.moveOutcome.evalLabel, '-0.35');
  }
  assert.equal(result.citation.evalKind, 'cp');
  assert.equal(result.citation.evalValue, 35);
  assert.equal(result.citation.evalLabel, '+0.35');
  assert.equal(result.citation.bestMove, 'e2e4');
  assert.deepEqual(result.citation.bestLine, ['e2e4', 'e7e5', 'g1f3']);
  assert.equal(result.citation.depth, 16);
  assert.equal(result.explanation, 'e4 controls key central squares and opens diagonals.');
  assert.equal(result.providerId, 'mock-llm');
  assert.equal(result.model, 'mock-model');
  assert.deepEqual(result, responseData);
});

test('preserves terminal move outcome without normalizing or inventing evaluation', async () => {
  const terminalResponse: MoveExplanationResponse = {
    fen: BEFORE_MATE_FEN,
    variant: 'standard',
    move: 'f3f7',
    explanation: 'Qxf7# delivers checkmate, winning the game immediately.',
    citation: {
      moveOutcome: {
        kind: 'terminal',
        reason: 'checkmate',
        result: '1-0',
      },
      evalKind: 'mate',
      evalValue: 1,
      evalLabel: '#+1',
      bestMove: 'f3f7',
      bestLine: ['f3f7'],
      depth: 12,
    },
    providerId: 'mock-llm',
    model: 'mock-model',
  };

  const transport = new FakeTransport(() => json(200, terminalResponse));
  const client = makeClient(transport);

  const result = await client.analysis.explainMove({
    fen: BEFORE_MATE_FEN,
    variant: 'standard',
    move: 'f3f7',
  });

  assert.equal(result.citation.moveOutcome.kind, 'terminal');
  if (result.citation.moveOutcome.kind === 'terminal') {
    assert.equal(result.citation.moveOutcome.reason, 'checkmate');
    assert.equal(result.citation.moveOutcome.result, '1-0');
  }
  assert.deepEqual(result, terminalResponse);
});

test('rejects with RateLimitError on 429 rate-limited response', async () => {
  const transport = new FakeTransport(() =>
    json(429, {
      error: {
        code: 'rate_limited',
        message: 'Too many move explanation requests. Try again shortly.',
        requestId: 'req-rate-limit-1',
      },
    }),
  );
  const client = makeClient(transport);

  await assert.rejects(
    () =>
      client.analysis.explainMove({
        fen: START_FEN,
        variant: 'standard',
        move: 'e2e4',
      }),
    (err: unknown) => {
      assert.ok(err instanceof RateLimitError, 'error must be an instance of RateLimitError');
      assert.ok(err instanceof HttpError, 'error must be an instance of HttpError');
      assert.equal(err.status, 429);
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.message, 'Too many move explanation requests. Try again shortly.');
      assert.equal(err.requestId, 'req-rate-limit-1');
      return true;
    },
  );

  assert.equal(transport.calls.length, 1, 'move explanation request must not be retried');
});

test('rejects with ServiceUnavailableError on 503 response when service is unavailable', async () => {
  const transport = new FakeTransport(() =>
    json(503, {
      error: {
        code: 'service_unavailable',
        message: 'Move explanation subsystem not configured on this deployment',
        requestId: 'req-503-1',
      },
    }),
  );
  const client = makeClient(transport);

  await assert.rejects(
    () =>
      client.analysis.explainMove({
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
      assert.equal(err.message, 'Move explanation subsystem not configured on this deployment');
      assert.equal(err.requestId, 'req-503-1');
      return true;
    },
  );

  assert.equal(transport.calls.length, 1, 'move explanation request must not be retried');
});

test('rejects with RequestAbortedError when caller aborts in-flight request', async () => {
  const transport = abortableHang();
  const client = makeClient(transport);
  const controller = new AbortController();

  const promise = client.analysis.explainMove(
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

test('GambitClient.explainMove delegates directly to analysis.explainMove', async () => {
  const responseData: MoveExplanationResponse = {
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
    explanation: 'e4 stakes a claim in the center and frees lines for the queen and bishop.',
    citation: {
      moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: -35, evalLabel: '-0.35' },
      evalKind: 'cp',
      evalValue: 35,
      evalLabel: '+0.35',
      bestMove: 'e2e4',
      bestLine: ['e2e4', 'e7e5', 'g1f3'],
      depth: 16,
    },
    providerId: 'mock-llm',
    model: 'mock-model',
  };

  const transport = new FakeTransport(() => json(200, responseData));
  const client = makeClient(transport);

  const result = await client.explainMove({
    fen: START_FEN,
    variant: 'standard',
    move: 'e2e4',
  });

  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/ai/move-explanation');
  assert.deepEqual(result, responseData);
});

