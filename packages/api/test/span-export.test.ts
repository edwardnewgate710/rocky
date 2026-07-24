import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JsonLogger } from '../src/ports/logger';
import type { SpanData, SpanExporter } from '../src/index';
import {
  LoggingSpanExporter,
  MultiSpanExporter,
  spanSinkFromExporter,
  pickBoundedAttrs,
  BOUNDED_SPAN_ATTRS,
} from '../src/ports/span-export';

test('pickBoundedAttrs returns strictly whitelisted keys', () => {
  const attrs = {
    'http.method': 'GET',
    'http.route': '/v1/users',
    'http.status_code': 200,
    'user.id': 'u123',
    'net.peer.ip': '127.0.0.1',
  };
  const picked = pickBoundedAttrs(attrs);
  assert.equal(picked['http.method'], 'GET');
  assert.equal(picked['http.route'], '/v1/users');
  assert.equal(picked['http.status_code'], 200);
  assert.equal('user.id' in picked, false);
  assert.equal('net.peer.ip' in picked, false);
  assert.deepEqual(Object.keys(BOUNDED_SPAN_ATTRS).length, 3);
});

test('LoggingSpanExporter.export emits structured log record with bounded attributes only', () => {
  const lines: string[] = [];
  const logger = new JsonLogger({ service: 'api' }, { sink: (line) => lines.push(line) });
  const exporter = new LoggingSpanExporter(logger);

  const span: SpanData = {
    name: 'http.server',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    parentId: 'a1a2a3a4b1b2b3b4',
    kind: 'server',
    status: 'ok',
    startTimeMs: 1000,
    durationMs: 45,
    attributes: {
      'http.method': 'POST',
      'http.route': '/v1/seeks',
      'http.status_code': 201,
      'user.id': 'u1',
      'net.peer.ip': '192.168.1.1',
    },
  };

  exporter.export([span]);

  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.msg, 'span');
  assert.equal(rec.name, 'http.server');
  assert.equal(rec.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(rec.spanId, '00f067aa0ba902b7');
  assert.equal(rec.parentId, 'a1a2a3a4b1b2b3b4');
  assert.equal(rec.kind, 'server');
  assert.equal(rec.status, 'ok');
  assert.equal(rec.durationMs, 45);
  assert.equal(rec['http.method'], 'POST');
  assert.equal(rec['http.route'], '/v1/seeks');
  assert.equal(rec['http.status_code'], 201);
  assert.equal('user.id' in rec, false, 'un-whitelisted user.id must be absent');
  assert.equal('net.peer.ip' in rec, false, 'un-whitelisted net.peer.ip must be absent');
});

test('MultiSpanExporter fans out to all exporters and contains errors', () => {
  const exporter2Received: SpanData[][] = [];

  const failingExporter: SpanExporter = {
    export() {
      throw new Error('Exporter 1 boom');
    },
  };

  const workingExporter: SpanExporter = {
    export(spans) {
      exporter2Received.push([...spans]);
    },
  };

  const multi = new MultiSpanExporter([failingExporter, workingExporter]);

  const span: SpanData = {
    name: 'test.span',
    traceId: '11111111111111111111111111111111',
    spanId: '2222222222222222',
    parentId: null,
    kind: 'internal',
    status: 'ok',
    startTimeMs: 100,
    durationMs: 5,
    attributes: {},
  };

  assert.doesNotThrow(() => multi.export([span]));
  assert.equal(exporter2Received.length, 1);
  assert.equal(exporter2Received[0]![0]!.name, 'test.span');
});

test('spanSinkFromExporter produces a SpanSink that exports a single-element span array', () => {
  const exportedBatches: SpanData[][] = [];
  const fakeExporter: SpanExporter = {
    export(spans) {
      exportedBatches.push([...spans]);
    },
  };

  const sink = spanSinkFromExporter(fakeExporter);

  const span: SpanData = {
    name: 'sink.span',
    traceId: '33333333333333333333333333333333',
    spanId: '4444444444444444',
    parentId: null,
    kind: 'server',
    status: 'ok',
    startTimeMs: 500,
    durationMs: 10,
    attributes: {},
  };

  sink(span);

  assert.equal(exportedBatches.length, 1);
  assert.equal(exportedBatches[0]!.length, 1);
  assert.equal(exportedBatches[0]![0]!.name, 'sink.span');
});

test('spanSinkFromExporter contains a throwing exporter so it never escapes the request path', () => {
  const throwingExporter: SpanExporter = {
    export() {
      throw new Error('exporter boom');
    },
  };
  const sink = spanSinkFromExporter(throwingExporter);
  const span: SpanData = {
    name: 'sink.span',
    traceId: '55555555555555555555555555555555',
    spanId: '6666666666666666',
    parentId: null,
    kind: 'server',
    status: 'ok',
    startTimeMs: 500,
    durationMs: 10,
    attributes: {},
  };
  assert.doesNotThrow(() => sink(span));
});
