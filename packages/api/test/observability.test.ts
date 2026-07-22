/**
 * M13 observability port tests: JsonLogger (structure, child bindings, level,
 * no-secret-leak through the request path), InMemoryMetrics (counter/histogram
 * + Prometheus render), and W3C traceparent parsing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JsonLogger, NullLogger } from '../src/ports/logger';
import { InMemoryMetrics } from '../src/ports/metrics';
import { parseTraceparent, generateTraceId } from '../src/http/traceparent';
import { startHarness } from './helpers';

test('JsonLogger emits one JSON line per call with level, msg, and fields', () => {
  const lines: string[] = [];
  const logger = new JsonLogger({ service: 'test' }, { sink: (l) => lines.push(l) });
  logger.info('hello', { a: 1, b: 'x' });
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.level, 'info');
  assert.equal(rec.msg, 'hello');
  assert.equal(rec.service, 'test');
  assert.equal(rec.a, 1);
  assert.equal(rec.b, 'x');
  assert.ok(typeof rec.ts === 'string');
});

test('JsonLogger.child merges bindings into every record', () => {
  const lines: string[] = [];
  const base = new JsonLogger({ service: 'test' }, { sink: (l) => lines.push(l) });
  const child = base.child({ requestId: 'r1', traceId: 't1' });
  child.warn('w');
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.service, 'test');
  assert.equal(rec.requestId, 'r1');
  assert.equal(rec.traceId, 't1');
  assert.equal(rec.level, 'warn');
});

test('JsonLogger honors the minimum level', () => {
  const lines: string[] = [];
  const logger = new JsonLogger({}, { level: 'warn', sink: (l) => lines.push(l) });
  logger.debug('d');
  logger.info('i');
  logger.warn('w');
  logger.error('e');
  assert.deepEqual(lines.map((l) => JSON.parse(l).level), ['warn', 'error']);
});

test('NullLogger emits nothing and returns itself from child', () => {
  const logger = new NullLogger();
  assert.equal(logger.child({ a: 'b' }), logger);
  // No throw, no output — nothing to assert beyond it being callable.
  logger.error('e', { x: 1 });
});

test('request logging never leaks the bearer token', async () => {
  const lines: string[] = [];
  const captured = new JsonLogger({}, { level: 'debug', sink: (l) => lines.push(l) });
  const h = await startHarness({}, { logger: captured });
  try {
    const { token } = await h.makeUser('logsafe');
    await h.json('GET', '/v1/users/me', { token });
    const all = lines.join('\n');
    assert.ok(lines.length > 0, 'a request-completed line was logged');
    assert.ok(!all.includes(token), 'the access token must never appear in logs');
    assert.ok(!all.toLowerCase().includes('bearer '), 'no Authorization header value in logs');
  } finally {
    await h.close();
  }
});

test('InMemoryMetrics counter increments and renders as Prometheus text', () => {
  const m = new InMemoryMetrics();
  m.counter('reqs_total', { route: '/a' }).inc();
  m.counter('reqs_total', { route: '/a' }).inc(2);
  m.counter('reqs_total', { route: '/b' }).inc();
  const out = m.render();
  assert.ok(out.includes('# TYPE reqs_total counter'));
  assert.ok(out.includes('reqs_total{route="/a"} 3'));
  assert.ok(out.includes('reqs_total{route="/b"} 1'));
});

test('InMemoryMetrics histogram buckets and renders _bucket/_sum/_count', () => {
  const m = new InMemoryMetrics();
  const h = m.histogram('lat_seconds', [0.1, 0.5, 1], { route: '/a' });
  h.observe(0.05);
  h.observe(0.3);
  h.observe(2);
  const out = m.render();
  assert.ok(out.includes('# TYPE lat_seconds histogram'));
  assert.ok(out.includes('lat_seconds_bucket{route="/a",le="0.1"} 1'));
  assert.ok(out.includes('lat_seconds_bucket{route="/a",le="0.5"} 2'));
  assert.ok(out.includes('lat_seconds_bucket{route="/a",le="1"} 2'));
  assert.ok(out.includes('lat_seconds_bucket{route="/a",le="+Inf"} 3'));
  assert.ok(out.includes('lat_seconds_count{route="/a"} 3'));
  assert.ok(out.includes('lat_seconds_sum{route="/a"} 2.35'));
});

test('traceparent: a valid header is adopted', () => {
  const p = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.ok(p);
  assert.equal(p!.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(p!.parentId, '00f067aa0ba902b7');
  assert.equal(p!.flags, '01');
});

test('traceparent: malformed / unsupported / all-zero headers are rejected', () => {
  assert.equal(parseTraceparent(undefined), null);
  assert.equal(parseTraceparent('garbage'), null);
  assert.equal(parseTraceparent('99-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), null); // bad version
  assert.equal(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01'), null); // short trace-id
  assert.equal(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), null); // all-zero trace-id
});

test('generateTraceId returns 32 lowercase hex chars', () => {
  const id = generateTraceId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(id, generateTraceId());
});

test('/v1/metrics exposes Prometheus text and bounds method cardinality to OTHER', async () => {
  const h = await startHarness();
  try {
    // A bogus HTTP method never matches a route → failure path labels it OTHER,
    // never the raw client-supplied token, so cardinality stays bounded.
    await fetch(`${h.baseUrl}/v1/health`, { method: 'PROPFIND' }).catch(() => undefined);
    const res = await fetch(`${h.baseUrl}/v1/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();
    assert.ok(text.includes('method="OTHER"'), 'unknown method collapses to OTHER');
    assert.ok(!text.includes('method="PROPFIND"'), 'raw method is never a label');
  } finally {
    await h.close();
  }
});
