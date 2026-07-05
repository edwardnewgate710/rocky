import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/net/http-client.js';
import type { RetryPolicy } from '../src/net/retry.js';
import { DecodeError, NetworkError, NotFoundError, TimeoutError } from '../src/net/errors.js';
import { FakeTransport, abortableHang, empty, json } from './support/fake-transport.js';

const NO_JITTER: RetryPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, jitter: 'none' };
const immediateSleep = async (): Promise<void> => {};

function client(transport: FakeTransport): HttpClient {
  return new HttpClient({ baseUrl: 'https://api.test', transport, retry: NO_JITTER, sleep: immediateSleep });
}

test('builds URL with base + path + query and sets JSON accept header', async () => {
  const t = new FakeTransport(() => json(200, { ok: true }));
  await client(t).request({ method: 'GET', path: '/v1/x', query: { a: 1, b: 'y', skip: undefined } });
  const call = t.calls[0]!;
  assert.equal(call.url, 'https://api.test/v1/x?a=1&b=y');
  assert.equal(call.headers['accept'], 'application/json');
  assert.equal(call.body, undefined);
});

test('serializes a JSON body and sets content-type', async () => {
  const t = new FakeTransport(() => json(200, {}));
  await client(t).request({ method: 'POST', path: '/v1/x', body: { hi: 1 } });
  const call = t.calls[0]!;
  assert.equal(call.headers['content-type'], 'application/json');
  assert.equal(call.body, '{"hi":1}');
});

test('returns parsed body for 2xx', async () => {
  const t = new FakeTransport(() => json(200, { value: 42 }));
  const out = await client(t).request<{ value: number }>({ method: 'GET', path: '/v1/x' });
  assert.deepEqual(out, { value: 42 });
});

test('204 / empty body decodes to undefined', async () => {
  const t = new FakeTransport(() => empty(204));
  const out = await client(t).request({ method: 'DELETE', path: '/v1/x' });
  assert.equal(out, undefined);
});

test('maps a non-2xx envelope to a typed HttpError', async () => {
  const t = new FakeTransport(() =>
    json(404, { error: { code: 'not_found', message: 'missing', requestId: 'r1' } }),
  );
  await assert.rejects(client(t).request({ method: 'GET', path: '/v1/x' }), (err: unknown) => {
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.requestId, 'r1');
    return true;
  });
});

test('transport rejection becomes a NetworkError', async () => {
  const t = new FakeTransport(() => new Error('offline'));
  await assert.rejects(client(t).request({ method: 'GET', path: '/v1/x' }), NetworkError);
});

test('unparseable 2xx body becomes a DecodeError', async () => {
  const t = new FakeTransport(() => ({ status: 200, headers: {}, body: '{not json' }));
  await assert.rejects(client(t).request({ method: 'GET', path: '/v1/x' }), DecodeError);
});

test('retries an idempotent GET on 503 then succeeds', async () => {
  const t = new FakeTransport(
    () => json(503, { error: { code: 'unavailable', message: 'busy', requestId: 'r' } }),
    () => json(200, { ok: 1 }),
  );
  const out = await client(t).request<{ ok: number }>({ method: 'GET', path: '/v1/x' });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(t.calls.length, 2);
});

test('does not retry a non-idempotent POST on 503', async () => {
  const t = new FakeTransport().onEach(() =>
    json(503, { error: { code: 'unavailable', message: 'busy', requestId: 'r' } }),
  );
  await assert.rejects(client(t).request({ method: 'POST', path: '/v1/x' }));
  assert.equal(t.calls.length, 1);
});

test('client timeout produces a TimeoutError', async () => {
  const c = new HttpClient({
    baseUrl: 'https://api.test',
    transport: abortableHang(),
    retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1, jitter: 'none' },
    sleep: immediateSleep,
    timeoutMs: 20,
  });
  await assert.rejects(c.request({ method: 'GET', path: '/v1/x' }), TimeoutError);
});
