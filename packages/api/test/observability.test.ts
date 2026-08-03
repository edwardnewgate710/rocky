/**
 * M13 observability port tests: JsonLogger (structure, child bindings, level,
 * no-secret-leak through the request path), InMemoryMetrics (counter/histogram
 * + Prometheus render), and W3C traceparent parsing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JsonLogger, NullLogger } from '../src/ports/logger';
import { InMemoryMetrics } from '../src/ports/metrics';
import { RecordingTracer, InMemorySpanRecorder } from '../src/ports/tracer';
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

test('InMemoryMetrics gauge sets, increments, decrements, and renders as Prometheus text', () => {
  const m = new InMemoryMetrics();
  const g = m.gauge('active_games');
  g.set(5);
  g.inc(2);
  g.dec(1);
  const out = m.render();
  assert.ok(out.includes('# TYPE active_games gauge'));
  assert.ok(out.includes('active_games 6'));
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

test('router server span emission, outbound traceparent propagation, route pattern attribution, and PII protection', async () => {
  const recorder = new InMemorySpanRecorder();
  const tracer = new RecordingTracer({ sink: recorder.record });
  const h = await startHarness({}, { tracer });

  try {
    const concreteHandle = 'alice_test_user';
    await h.repos.users.create({ id: 'u1', handle: concreteHandle });

    // Request 1: Valid parameterized route request with inbound traceparent
    const inboundTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const inboundSpanId = '00f067aa0ba902b7';
    const inboundTraceparent = `00-${inboundTraceId}-${inboundSpanId}-01`;

    const res = await fetch(`${h.baseUrl}/v1/users/${concreteHandle}`, {
      headers: { traceparent: inboundTraceparent },
    });
    assert.equal(res.status, 200);

    // Outbound traceparent header check
    const outboundTraceparent = res.headers.get('traceparent');
    assert.ok(outboundTraceparent, 'response contains traceparent header');
    const parsedOutbound = parseTraceparent(outboundTraceparent);
    assert.ok(parsedOutbound, 'outbound traceparent is valid');
    assert.equal(parsedOutbound!.traceId, inboundTraceId);
    assert.equal(parsedOutbound!.flags, '01');

    // Span assertion
    const spans = recorder.spans();
    assert.equal(spans.length, 1);
    const span1 = spans[0]!;
    assert.equal(span1.name, 'http.server');
    assert.equal(span1.traceId, inboundTraceId);
    assert.equal(span1.parentId, inboundSpanId);
    assert.equal(span1.kind, 'server');
    assert.equal(span1.status, 'ok');
    assert.equal(span1.attributes['http.method'], 'GET');
    assert.equal(span1.attributes['http.route'], '/v1/users/:handle');
    assert.equal(span1.attributes['http.status_code'], 200);

    // Assert NO PII attribute values or keys
    for (const [k, v] of Object.entries(span1.attributes)) {
      const valStr = String(v);
      assert.ok(!valStr.includes(concreteHandle), `attribute ${k} must not contain concrete handle`);
      assert.ok(!valStr.includes('u1'), `attribute ${k} must not contain user ID`);
    }

    // Request 2: Handled error path (404)
    recorder.clear();
    const res404 = await fetch(`${h.baseUrl}/v1/users/nonexistent_handle`);
    assert.equal(res404.status, 404);
    const spans404 = recorder.spans();
    assert.equal(spans404.length, 1);
    const span404 = spans404[0]!;
    assert.equal(span404.status, 'ok', '<500 status yields status ok');
    assert.equal(span404.attributes['http.status_code'], 404);
    assert.equal(span404.attributes['http.route'], '/v1/users/:handle');
  } finally {
    await h.close();
  }
});

test('router server span records error status on internal 500 failure', async () => {
  const recorder = new InMemorySpanRecorder();
  const tracer = new RecordingTracer({ sink: recorder.record });
  const throwingEvaluator = {
    evaluate: (): never => {
      throw new Error('Forced anti-cheat evaluator error');
    },
  };
  const h = await startHarness({}, {
    tracer,
    antiCheatEvaluator: throwingEvaluator,
  });

  try {
    const { token } = await h.makeUser('mod_user', ['moderator']);
    const gameId = '00000000-0000-7000-8000-000000000001';
    
    // Create a finished game in the event store so antiCheatAnalysis proceeds to evaluate
    const now = Date.now();
    await h.antiCheatEventStore.append(gameId, -1, [
      {
        type: 'GameCreated',
        gameId,
        variant: 'standard',
        initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        timeControl: { initialMs: 300000, incrementMs: 0, delayMs: 0, kind: 'increment' },
        players: { white: 'u1', black: 'u2' },
        rated: true,
        at: now,
      },
      {
        type: 'MovePlayed',
        ply: 1,
        uci: 'e2e4',
        san: 'e4',
        by: 'w',
        moveTimeMs: 1000,
        remaining: { w: 299000, b: 300000 },
        at: now + 1000,
      },
      {
        type: 'GameEnded',
        result: '1-0',
        termination: 'checkmate',
        winner: 'w',
        at: now + 2000,
      },
    ]);

    const res = await h.json('POST', `/v1/moderation/anti-cheat/games/${gameId}/analyze`, { token });
    assert.equal(res.status, 500);

    const spans = recorder.spans();
    assert.equal(spans.length, 1);
    const span = spans[0]!;
    assert.equal(span.status, 'error');
    assert.equal(span.attributes['http.status_code'], 500);
    assert.equal(span.attributes['http.route'], '/v1/moderation/anti-cheat/games/:gameId/analyze');
  } finally {
    await h.close();
  }
});


// Regression (Qodo, PR #58): splitPath() filters empty segments, so `/v1/metrics/` resolves to the
// SAME route as `/v1/metrics`. The M12 nginx mitigation originally used an exact-match
// `location = /v1/metrics`, which the trailing-slash form walked straight past — the fix looked
// verified because the proxy forwarded it, and nobody checked what the API did with it.
// This asserts the API-side equivalence that makes the proxy rule's shape load-bearing.
test('/v1/metrics/ resolves to the same route as /v1/metrics (why the proxy rule must match both)', async () => {
  const h = await startHarness();
  try {
    const withSlash = await fetch(`${h.baseUrl}/v1/metrics/`);
    assert.equal(
      withSlash.status,
      200,
      'trailing slash hits the same route — any path-based block must cover both forms',
    );
    assert.match(withSlash.headers.get('content-type') ?? '', /text\/plain/);
  } finally {
    await h.close();
  }
});

// The companion to the case above: percent-encoded padding must NOT collapse to the metrics route,
// which is what makes it safe for the proxy to forward `/v1/metrics%20` rather than block it.
test('/v1/metrics%20 does NOT resolve to the metrics route', async () => {
  const h = await startHarness();
  try {
    const res = await fetch(`${h.baseUrl}/v1/metrics%20`);
    assert.equal(res.status, 404, 'percent-encoding is preserved in pathname, so this is not a route');
    const body = await res.text();
    assert.ok(!body.includes('# HELP'), 'no Prometheus text may leak through the encoded form');
  } finally {
    await h.close();
  }
});
