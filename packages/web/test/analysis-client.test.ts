/**
 * Client bindings for the engine analysis endpoint (M15 inc 2).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';
import type { AnalysisResponse } from '../src/api/models.js';

class RecordingTransport implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  private readonly handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>;

  constructor(handler: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
    this.handler = handler;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    return this.handler(req);
  }
}

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

test('analyse posts to /v1/analysis with auth and forwards signal', async () => {
  const responseData: AnalysisResponse = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    variant: 'standard',
    applied: { depth: 16, movetimeMs: 1000, multiPv: 3 },
    lines: [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 40 },
        moves: ['e2e4'],
        depth: 12,
        nodes: 100000,
        timeMs: 800,
      },
    ],
  };

  const transport = new RecordingTransport(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(responseData),
  }));

  const client = makeClient(transport);
  const controller = new AbortController();

  const result = await client.analysis.analyse(
    {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      variant: 'standard',
      multiPv: 3,
    },
    controller.signal,
  );

  assert.equal(transport.calls.length, 1);
  const req = transport.calls[0]!;
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://api.test/v1/analysis');
  assert.equal(req.headers['authorization'], 'Bearer tok-A');
  assert.deepEqual(result, responseData);
});

test('analyse forwards abort signal to abort in-flight request', async () => {
  const transport: HttpTransport = {
    send(req: HttpRequest): Promise<HttpResponse> {
      return new Promise<HttpResponse>((_resolve, reject) => {
        if (req.signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };

  const client = makeClient(transport);
  const controller = new AbortController();

  const promise = client.analysis.analyse(
    {
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      variant: 'standard',
      multiPv: 3,
    },
    controller.signal,
  );

  controller.abort();
  await assert.rejects(promise);
});

test('analyse does NOT retry on failure (non-idempotent to protect engine workers)', async () => {
  const transport = new RecordingTransport(() => ({
    status: 500,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code: 'engine_error', message: 'Engine crash' } }),
  }));

  const client = makeClient(transport);

  await assert.rejects(
    () =>
      client.analysis.analyse({
        fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        variant: 'standard',
        multiPv: 3,
      }),
    (err: unknown) => {
      return (err as { status?: number }).status === 500;
    },
  );

  assert.equal(transport.calls.length, 1, 'analysis request must not be retried');
});
