import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  NullTracer,
  RecordingTracer,
  InMemorySpanRecorder,
  alwaysOnSampler,
  probabilitySampler,
  resolveTracesSampler,
  type SpanData,
} from '../src/ports/tracer';
import {
  parseTraceparent,
  generateSpanId,
  formatTraceparent,
  isSampled,
} from '../src/http/traceparent';

test('RecordingTracer records a span with correct attributes and duration', () => {
  const spans: SpanData[] = [];
  let time = 100;
  const tracer = new RecordingTracer({
    sink: (s) => spans.push(s),
    now: () => time,
    generateSpanId: () => '1122334455667788',
  });

  const span = tracer.startSpan('test.span', {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    parentId: '00f067aa0ba902b7',
    kind: 'client',
    attributes: { 'http.method': 'GET' },
  });

  span.setAttribute('http.status_code', 200);
  span.setStatus('ok');

  time = 175;
  span.end();

  assert.equal(spans.length, 1);
  const data = spans[0]!;
  assert.equal(data.name, 'test.span');
  assert.equal(data.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(data.spanId, '1122334455667788');
  assert.equal(data.parentId, '00f067aa0ba902b7');
  assert.equal(data.kind, 'client');
  assert.equal(data.status, 'ok');
  assert.equal(data.startTimeMs, 100);
  assert.equal(data.durationMs, 75);
  assert.equal(data.attributes['http.method'], 'GET');
  assert.equal(data.attributes['http.status_code'], 200);

  // A second call to end() must be a no-op
  span.end();
  assert.equal(spans.length, 1);
});

test('Sampler behavior: probabilitySampler and parentSampled overrides', () => {
  const spans: SpanData[] = [];
  const sink = (s: SpanData) => spans.push(s);

  // probabilitySampler(0) -> not recorded
  const zeroTracer = new RecordingTracer({ sink, sampler: probabilitySampler(0) });
  const noopSpan = zeroTracer.startSpan('noop', { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
  noopSpan.end();
  assert.equal(spans.length, 0);

  // probabilitySampler(1) -> recorded
  const oneTracer = new RecordingTracer({ sink, sampler: probabilitySampler(1) });
  const recSpan = oneTracer.startSpan('rec', { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
  recSpan.end();
  assert.equal(spans.length, 1);

  // Determinism on same traceId across calls
  const pSampler = probabilitySampler(0.5);
  const traceA = '1234567890abcdef1234567890abcdef';
  const decision1 = pSampler({ traceId: traceA, parentSampled: undefined });
  const decision2 = pSampler({ traceId: traceA, parentSampled: undefined });
  assert.equal(decision1, decision2);

  // parentSampled overrides ratio: parentSampled=true records with ratio 0
  const parentTrue = zeroTracer.startSpan('parent.true', {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    sampledFlag: true,
  });
  parentTrue.end();
  assert.equal(spans.length, 2);

  // parentSampled=false skips with ratio 1
  const parentFalse = oneTracer.startSpan('parent.false', {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    sampledFlag: false,
  });
  parentFalse.end();
  assert.equal(spans.length, 2);
});

test('InMemorySpanRecorder ring buffer capacity and clear', () => {
  const recorder = new InMemorySpanRecorder({ capacity: 2 });
  const tracer = new RecordingTracer({ sink: recorder.record, sampler: alwaysOnSampler });

  tracer.startSpan('s1', { traceId: '11111111111111111111111111111111' }).end();
  tracer.startSpan('s2', { traceId: '22222222222222222222222222222222' }).end();
  tracer.startSpan('s3', { traceId: '33333333333333333333333333333333' }).end();

  const recorded = recorder.spans();
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0]!.name, 's2');
  assert.equal(recorded[1]!.name, 's3');

  recorder.clear();
  assert.equal(recorder.spans().length, 0);
});

test('NullTracer mints a valid propagation id, is silent, and reports not sampled', () => {
  const tracer = new NullTracer(() => 'aabbccddeeff0011');
  const span = tracer.startSpan('null.span', { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
  // A valid 16-hex, non-all-zero id so the outbound traceparent parses downstream.
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(span.spanId, '0000000000000000');
  assert.equal(span.sampled, false);
  span.setAttribute('a', 'b');
  span.setStatus('error');
  assert.doesNotThrow(() => span.end());
});

test('unsampled RecordingTracer span still has a valid non-zero propagation id and is not sampled', () => {
  const spans: SpanData[] = [];
  const tracer = new RecordingTracer({
    sink: (s) => spans.push(s),
    sampler: probabilitySampler(0),
    generateSpanId: () => '1234abcd5678ef90',
  });
  const span = tracer.startSpan('http.server', { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
  assert.equal(span.spanId, '1234abcd5678ef90');
  assert.notEqual(span.spanId, '0000000000000000');
  assert.equal(span.sampled, false);
  span.end();
  assert.equal(spans.length, 0); // not recorded
});

test('sampled RecordingTracer span reports sampled=true', () => {
  const tracer = new RecordingTracer({ sink: () => {}, sampler: probabilitySampler(1) });
  const span = tracer.startSpan('http.server', { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
  assert.equal(span.sampled, true);
});

test('RecordingSpan.end swallows a throwing sink so export stays off the request path', () => {
  const tracer = new RecordingTracer({
    sink: () => {
      throw new Error('sink boom');
    },
  });
  const span = tracer.startSpan('http.server', { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' });
  assert.doesNotThrow(() => span.end());
});

test('formatTraceparent round-trips with parseTraceparent, generateSpanId and isSampled work correctly', () => {
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const spanId = generateSpanId();
  assert.match(spanId, /^[0-9a-f]{16}$/);

  const formattedSampled = formatTraceparent({ traceId, spanId, sampled: true });
  assert.equal(formattedSampled, `00-${traceId}-${spanId}-01`);

  const parsedSampled = parseTraceparent(formattedSampled);
  assert.ok(parsedSampled);
  assert.equal(parsedSampled!.traceId, traceId);
  assert.equal(parsedSampled!.parentId, spanId);
  assert.equal(parsedSampled!.flags, '01');
  assert.equal(isSampled(parsedSampled!.flags), true);

  const formattedNotSampled = formatTraceparent({ traceId, spanId, sampled: false });
  assert.equal(formattedNotSampled, `00-${traceId}-${spanId}-00`);

  const parsedNotSampled = parseTraceparent(formattedNotSampled);
  assert.ok(parsedNotSampled);
  assert.equal(parsedNotSampled!.flags, '00');
  assert.equal(isSampled(parsedNotSampled!.flags), false);
});

// Regression (Qodo, PR #56): probabilitySampler clamps with Math.max/Math.min, and both propagate
// NaN, so an unvalidated `Number("abc")` produced a sampler that failed every comparison and
// recorded nothing at all — tracing silently off across a whole deployment, with no error.
test('resolveTracesSampler rejects non-probability values instead of silently sampling nothing', () => {
  const traceId = '0'.repeat(31) + '1';

  const unset = resolveTracesSampler(undefined);
  assert.equal(unset.warning, undefined);
  assert.equal(unset.sampler({ traceId, parentSampled: undefined }), true);

  assert.equal(resolveTracesSampler('').warning, undefined);

  for (const bad of ['abc', 'NaN', '-0.5', '1.5', 'Infinity']) {
    const { sampler, warning } = resolveTracesSampler(bad);
    assert.ok(warning, `"${bad}" must produce a warning`);
    assert.equal(
      sampler({ traceId, parentSampled: undefined }),
      true,
      `"${bad}" must fall back to always-on, never to sampling nothing`,
    );
  }

  // A valid ratio is honoured: 0 samples nothing, 1 samples everything.
  assert.equal(resolveTracesSampler('0').sampler({ traceId, parentSampled: undefined }), false);
  assert.equal(resolveTracesSampler('1').sampler({ traceId, parentSampled: undefined }), true);
  assert.equal(resolveTracesSampler('0.5').warning, undefined);
});
