import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Router } from '../src/http/router';
import { json } from '../src/http/context';
import { startHarness } from './helpers';

test('router matches path params and reports 404 vs 405', () => {
  const r = new Router();
  const noop = () => json(200, {});
  const publicPolicy = { required: false } as const;
  const doc = { summary: 's', tags: ['t'], security: 'none' as const, responses: {} };
  r.get('/v1/users/:handle', doc, publicPolicy, noop);
  r.post('/v1/users/:handle', doc, publicPolicy, noop);

  const hit = r.match('GET', '/v1/users/alice');
  assert.ok('route' in hit);
  if ('route' in hit) assert.equal(hit.params['handle'], 'alice');

  const wrongMethod = r.match('DELETE', '/v1/users/alice');
  assert.ok('allow' in wrongMethod);
  if ('allow' in wrongMethod) assert.deepEqual(wrongMethod.allow.sort(), ['GET', 'POST']);

  const missing = r.match('GET', '/nope');
  assert.ok('allow' in missing);
  if ('allow' in missing) assert.equal(missing.allow.length, 0);
});

test('unknown route returns a 404 error envelope with a request id', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('GET', '/v1/nonexistent');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
    assert.ok(res.body.error.requestId);
    assert.ok(res.headers.get('x-request-id'));
  } finally {
    await h.close();
  }
});

test('wrong method returns 405 with an Allow header', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('GET', '/v1/auth/login');
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  } finally {
    await h.close();
  }
});

test('non-JSON content type is rejected with 415', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(res.status, 415);
  } finally {
    await h.close();
  }
});

test('malformed JSON is rejected with 400', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error.code, 'bad_request');
  } finally {
    await h.close();
  }
});

test('malformed percent encoding in a path parameter is rejected with 400', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/users/%`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error.code, 'bad_request');
  } finally {
    await h.close();
  }
});

test('oversized bodies are rejected with 413', async () => {
  const h = await startHarness({ maxBodyBytes: 32 });
  try {
    const res = await h.json('POST', '/v1/auth/register', {
      body: { handle: 'x'.repeat(100), password: 'y'.repeat(100) },
    });
    assert.equal(res.status, 413);
  } finally {
    await h.close();
  }
});

test('the incoming X-Request-Id is echoed back', async () => {
  const h = await startHarness();
  try {
    const res = await h.json('GET', '/v1/health', { headers: { 'x-request-id': 'trace-123' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-request-id'), 'trace-123');
    assert.ok(res.headers.get('trace-id'));
    assert.equal(res.body.status, 'ok');
  } finally {
    await h.close();
  }
});

test('HTTP metrics use route patterns to bound cardinality', async () => {
  const h = await startHarness();
  try {
    await h.json('GET', '/v1/users/alice');
    await h.json('GET', '/v1/users/bob');
    const res = await fetch(`${h.baseUrl}/v1/metrics`);
    const text = await res.text();
    // One metric line for both requests
    if (!text.includes('http_requests_total{method="GET",route="/v1/users/:handle",status="404"} 2')) {
      throw new Error(`Metric not found in:\n${text}`);
    }
  } finally {
    await h.close();
  }
});

test('/v1/ready returns 503 if readiness throws', async () => {
  const h = await startHarness({}, {
    readiness: async () => { throw new Error('db down'); }
  });
  try {
    const res = await h.json('GET', '/v1/ready');
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
  } finally {
    await h.close();
  }
});
