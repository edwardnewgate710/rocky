/**
 * Client bindings for the session-revocation endpoint (M14 inc 46).
 *
 * The path carries a server-supplied id, so the two things worth pinning are that the id is
 * URL-encoded rather than interpolated raw, and that the call is authenticated — an unauthenticated
 * DELETE would be rejected, but silently, from a control the user just clicked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import type { HttpRequest, HttpResponse, HttpTransport } from '../src/ports/http.js';

class RecordingTransport implements HttpTransport {
  readonly calls: HttpRequest[] = [];
  private readonly responses: ((req: HttpRequest) => HttpResponse)[];

  constructor(...responses: ((req: HttpRequest) => HttpResponse)[]) {
    this.responses = responses;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const responder = this.responses[this.calls.length];
    this.calls.push(req);
    return responder ? responder(req) : { status: 204, headers: {}, body: '' };
  }
}

function makeClient(transport: HttpTransport): GambitClient {
  const client = new GambitClient({
    baseUrl: 'https://api.test',
    transport,
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
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

test('revokeSession deletes the session path with auth and resolves with no value', async () => {
  const transport = new RecordingTransport(() => ({ status: 204, headers: {}, body: '' }));
  const client = makeClient(transport);

  const result = await client.auth.revokeSession('sess-1');

  assert.equal(result, undefined, 'a 204 resolves rather than failing to parse an empty body');
  assert.equal(transport.calls[0]!.method, 'DELETE');
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/auth/sessions/sess-1');
  assert.equal(transport.calls[0]!.headers['authorization'], 'Bearer tok-A');
});

/**
 * Session ids come from the server, but interpolating one straight into a path is the habit that
 * breaks the day an id contains a `/` or `?`. Encoding keeps the id inside its own path segment.
 */
test('revokeSession encodes the id rather than interpolating it into the path', async () => {
  const transport = new RecordingTransport(() => ({ status: 204, headers: {}, body: '' }));
  const client = makeClient(transport);

  await client.auth.revokeSession('a/b?c#d');

  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/auth/sessions/a%2Fb%3Fc%23d');
});

test('a 404 from revokeSession rejects rather than resolving silently', async () => {
  const transport = new RecordingTransport(() => ({
    status: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code: 'not_found', message: 'Session not found' } }),
  }));
  const client = makeClient(transport);

  await assert.rejects(() => client.auth.revokeSession('someone-elses-session'));
});

test('listing sessions is authenticated and returns the view rows', async () => {
  const rows = [{
    id: 'sess-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    expiresAt: '2026-09-01T00:00:00.000Z',
    revokedAt: null,
    lastSeenAt: '2026-08-15T00:00:00.000Z',
    lastIp: '203.0.113.9',
    lastUserAgent: 'Mozilla/5.0',
  }];
  const transport = new RecordingTransport(() => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rows),
  }));
  const client = makeClient(transport);

  const result = await client.auth.sessions();

  assert.deepEqual(result.map((s) => s.id), ['sess-1']);
  assert.equal(transport.calls[0]!.method, 'GET');
  assert.equal(transport.calls[0]!.url, 'https://api.test/v1/auth/sessions');
  assert.equal(transport.calls[0]!.headers['authorization'], 'Bearer tok-A');
});
