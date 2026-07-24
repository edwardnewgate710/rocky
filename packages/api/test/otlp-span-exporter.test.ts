import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { SpanData } from '../src/ports/tracer';
import {
  toResourceSpans,
  toOtlpAnyValue,
  OtlpJsonSpanExporter,
  resolveOtlpTracesEndpoint,
  type SpanTransport,
  type OtlpTracesPayload,
  type OtlpResourceInfo,
} from '../src/ports/otlp-span-exporter';

const resourceInfo: OtlpResourceInfo = {
  serviceName: 'api',
  scopeName: '@chess-platform/api',
  scopeVersion: '0.1.0',
};

test('toResourceSpans maps a server span to OTLP/JSON format with exact values', () => {
  const span: SpanData = {
    name: 'http.server',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentId: 'a1a2a3a4b1b2b3b4',
    kind: 'server',
    status: 'ok',
    startTimeMs: 1000,
    durationMs: 50,
    attributes: {
      'http.method': 'GET',
      'http.status_code': 200,
    },
  };

  const payload = toResourceSpans([span], resourceInfo);
  assert.equal(payload.resourceSpans.length, 1);

  const resourceSpans = payload.resourceSpans[0]!;
  assert.deepEqual(resourceSpans.resource.attributes, [
    { key: 'service.name', value: { stringValue: 'api' } },
  ]);

  assert.equal(resourceSpans.scopeSpans.length, 1);
  const scopeSpans = resourceSpans.scopeSpans[0]!;
  assert.equal(scopeSpans.scope.name, '@chess-platform/api');
  assert.equal(scopeSpans.scope.version, '0.1.0');

  assert.equal(scopeSpans.spans.length, 1);
  const otlpSpan = scopeSpans.spans[0]!;

  assert.equal(otlpSpan.name, 'http.server');
  assert.equal(otlpSpan.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(otlpSpan.spanId, '00f067aa0ba902b7');
  assert.equal(otlpSpan.parentSpanId, 'a1a2a3a4b1b2b3b4');
  assert.equal(otlpSpan.kind, 2); // server -> 2
  assert.equal(otlpSpan.status.code, 1); // ok -> 1
  assert.equal(otlpSpan.startTimeUnixNano, '1000000000');
  assert.equal(otlpSpan.endTimeUnixNano, '1050000000');

  assert.deepEqual(otlpSpan.attributes, [
    { key: 'http.method', value: { stringValue: 'GET' } },
    { key: 'http.status_code', value: { intValue: '200' } },
  ]);
});

test('kind/status enum coverage', () => {
  const internalUnsetSpan: SpanData = {
    name: 'internal.job',
    traceId: '11111111111111111111111111111111',
    spanId: '2222222222222222',
    parentId: null,
    kind: 'internal',
    status: 'unset',
    startTimeMs: 100,
    durationMs: 10,
    attributes: {},
  };

  const clientErrorSpan: SpanData = {
    name: 'http.client',
    traceId: '33333333333333333333333333333333',
    spanId: '4444444444444444',
    parentId: null,
    kind: 'client',
    status: 'error',
    startTimeMs: 200,
    durationMs: 20,
    attributes: {},
  };

  const payload = toResourceSpans([internalUnsetSpan, clientErrorSpan], resourceInfo);
  const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans;

  assert.equal(spans[0]!.kind, 1); // internal -> 1
  assert.equal(spans[0]!.status.code, 0); // unset -> 0

  assert.equal(spans[1]!.kind, 3); // client -> 3
  assert.equal(spans[1]!.status.code, 2); // error -> 2
});

test('parentId null -> parentSpanId key ABSENT from OtlpSpan', () => {
  const span: SpanData = {
    name: 'root.span',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentId: null,
    kind: 'server',
    status: 'ok',
    startTimeMs: 1000,
    durationMs: 50,
    attributes: {},
  };

  const payload = toResourceSpans([span], resourceInfo);
  const otlpSpan = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  assert.equal('parentSpanId' in otlpSpan, false);
});

test('attribute value types: boolean, double, integer', () => {
  assert.deepEqual(toOtlpAnyValue('hello'), { stringValue: 'hello' });
  assert.deepEqual(toOtlpAnyValue(true), { boolValue: true });
  assert.deepEqual(toOtlpAnyValue(false), { boolValue: false });
  assert.deepEqual(toOtlpAnyValue(42), { intValue: '42' });
  assert.deepEqual(toOtlpAnyValue(1.5), { doubleValue: 1.5 });
});

test('BigInt nano precision preserves exact large numbers without float loss', () => {
  const span: SpanData = {
    name: 'large.ts',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentId: null,
    kind: 'server',
    status: 'ok',
    startTimeMs: 1700000000000,
    durationMs: 5,
    attributes: {},
  };

  const payload = toResourceSpans([span], resourceInfo);
  const otlpSpan = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
  assert.equal(otlpSpan.startTimeUnixNano, '1700000000000000000');
  assert.equal(otlpSpan.endTimeUnixNano, '1700000000005000000');
});

test('resolveOtlpTracesEndpoint: signal-specific verbatim, generic base appends /v1/traces', () => {
  // Signal-specific endpoint is used exactly as given (even with a custom path).
  assert.equal(
    resolveOtlpTracesEndpoint('http://collector:4318/v1/traces', 'http://base:4318'),
    'http://collector:4318/v1/traces',
  );
  // Generic base URL gets /v1/traces appended.
  assert.equal(
    resolveOtlpTracesEndpoint(undefined, 'http://collector:4318'),
    'http://collector:4318/v1/traces',
  );
  // Trailing slashes on the base are trimmed before appending.
  assert.equal(
    resolveOtlpTracesEndpoint(undefined, 'http://collector:4318/'),
    'http://collector:4318/v1/traces',
  );
  // Neither configured -> undefined.
  assert.equal(resolveOtlpTracesEndpoint(undefined, undefined), undefined);
});

test('OtlpJsonSpanExporter export calls transport, skips empty array, and swallows transport errors', () => {
  const calls: OtlpTracesPayload[] = [];
  const fakeTransport: SpanTransport = {
    send(payload) {
      calls.push(payload);
    },
  };

  const exporter = new OtlpJsonSpanExporter(fakeTransport, resourceInfo);

  // Empty array -> no transport call
  exporter.export([]);
  assert.equal(calls.length, 0);

  // Non-empty array -> transport called once
  const span: SpanData = {
    name: 'http.server',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentId: null,
    kind: 'server',
    status: 'ok',
    startTimeMs: 1000,
    durationMs: 10,
    attributes: {},
  };

  exporter.export([span]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name, 'http.server');

  // Throwing transport is swallowed
  const throwingTransport: SpanTransport = {
    send() {
      throw new Error('Transport network failure');
    },
  };
  const throwingExporter = new OtlpJsonSpanExporter(throwingTransport, resourceInfo);
  assert.doesNotThrow(() => throwingExporter.export([span]));
});
