import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { SpanData, SpanExporter } from '../src/index';
import {
  BatchSpanProcessor,
  Scheduler,
  intervalScheduler,
} from '../src/ports/batch-span-processor';
import { spanSinkFromExporter } from '../src/ports/span-export';
import { InMemoryMetrics } from '../src/ports/metrics';

function makeManualScheduler() {
  let scheduled: (() => void) | null = null;
  let cancelled = false;
  const scheduler: Scheduler = {
    schedule(cb) {
      scheduled = cb;
      return {
        cancel() {
          cancelled = true;
        },
      };
    },
  };
  return {
    scheduler,
    tick: () => scheduled?.(),
    wasCancelled: () => cancelled,
  };
}

function makeSpan(name = 'test.span'): SpanData {
  return {
    name,
    traceId: '11111111111111111111111111111111',
    spanId: '2222222222222222',
    parentId: null,
    kind: 'internal',
    status: 'ok',
    startTimeMs: 1000,
    durationMs: 10,
    attributes: {},
  };
}

test('BatchSpanProcessor buffers without exporting until maxExportBatchSize is reached', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxExportBatchSize: 3,
    scheduler,
  });

  processor.export([makeSpan('s1')]);
  processor.export([makeSpan('s2')]);
  assert.equal(batches.length, 0, 'Should not export before batch size is reached');

  processor.export([makeSpan('s3')]);
  assert.equal(batches.length, 1, 'Should export exactly one batch upon reaching batch size');
  assert.equal(batches[0]!.length, 3);
  assert.deepEqual(
    batches[0]!.map((s) => s.name),
    ['s1', 's2', 's3'],
  );
  assert.equal(processor.queueSize, 0);
});

test('BatchSpanProcessor forceFlush() exports the remaining sub-batch', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxExportBatchSize: 3,
    scheduler,
  });

  processor.export([makeSpan('s1')]);
  processor.export([makeSpan('s2')]);
  assert.equal(batches.length, 0);

  processor.forceFlush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 2);
  assert.deepEqual(
    batches[0]!.map((s) => s.name),
    ['s1', 's2'],
  );
  assert.equal(processor.queueSize, 0);
});

test('BatchSpanProcessor forceFlush() chunks a large backlog into maxExportBatchSize batches', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxExportBatchSize: 2,
    maxQueueSize: 100,
    scheduler,
  });

  processor.export([
    makeSpan('s1'),
    makeSpan('s2'),
    makeSpan('s3'),
    makeSpan('s4'),
    makeSpan('s5'),
  ]);

  // Push of 5 auto-flushes 2 full batches (2+2), leaving 1 span in queue.
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 2);
  assert.equal(batches[1]!.length, 2);
  assert.equal(processor.queueSize, 1);

  processor.forceFlush();
  assert.equal(batches.length, 3);
  assert.equal(batches[2]!.length, 1);
  assert.deepEqual(
    batches.map((b) => b.length),
    [2, 2, 1],
  );
  assert.equal(processor.queueSize, 0);
});

test('BatchSpanProcessor overflow drops OLDEST and counts them', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxQueueSize: 2,
    maxExportBatchSize: 100,
    scheduler,
  });

  processor.export([makeSpan('s1'), makeSpan('s2'), makeSpan('s3')]);

  assert.equal(processor.droppedSpans, 1);

  processor.forceFlush();
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0]!.map((s) => s.name),
    ['s2', 's3'],
  );
});

test('BatchSpanProcessor periodic flush via scheduler tick', () => {
  const { scheduler, tick } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxExportBatchSize: 5,
    scheduler,
  });

  processor.export([makeSpan('s1')]);
  assert.equal(batches.length, 0);

  tick();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 1);
  assert.equal(batches[0]![0]!.name, 's1');
});

test('BatchSpanProcessor shutdown() flushes the remaining queue AND cancels the scheduled task', () => {
  const { scheduler, wasCancelled } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxExportBatchSize: 5,
    scheduler,
  });

  processor.export([makeSpan('s1')]);
  processor.shutdown();

  assert.equal(batches.length, 1);
  assert.equal(batches[0]![0]!.name, 's1');
  assert.equal(wasCancelled(), true);

  // Subsequent export after shutdown is dropped
  processor.export([makeSpan('s2')]);
  assert.equal(batches.length, 1);
  assert.equal(processor.droppedSpans, 1);
});

test('BatchSpanProcessor contains a throwing downstream exporter', () => {
  const { scheduler } = makeManualScheduler();
  const failingDownstream: SpanExporter = {
    export() {
      throw new Error('Downstream export failure');
    },
  };

  const processor = new BatchSpanProcessor(failingDownstream, {
    maxExportBatchSize: 2,
    scheduler,
  });

  assert.doesNotThrow(() => {
    processor.export([makeSpan('s1'), makeSpan('s2')]);
  });

  processor.export([makeSpan('s3')]);
  assert.doesNotThrow(() => {
    processor.forceFlush();
  });
});

test('BatchSpanProcessor is a SpanExporter compatible with spanSinkFromExporter', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxExportBatchSize: 5,
    scheduler,
  });

  const sink = spanSinkFromExporter(processor);

  assert.doesNotThrow(() => {
    sink(makeSpan('sink.s1'));
  });

  assert.equal(batches.length, 0, 'Sink call should buffer into processor without throwing');
  processor.forceFlush();
  assert.equal(batches.length, 1);
  assert.equal(batches[0]![0]!.name, 'sink.s1');
});

test('BatchSpanProcessor clamps maxExportBatchSize to maxQueueSize when larger', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxQueueSize: 2,
    maxExportBatchSize: 10,
    scheduler,
  });

  processor.export([makeSpan('s1'), makeSpan('s2')]);
  // Since maxExportBatchSize was clamped to 2 (maxQueueSize), pushing 2 spans triggers auto-export.
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.length, 2);
});

test('BatchSpanProcessor floors maxExportBatchSize at 1 so a zero batch size cannot spin forever', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxQueueSize: 10,
    maxExportBatchSize: 0, // would make the drain loop spin on zero-length batches if unclamped
    scheduler,
  });

  // If the batch size were left at 0, this export would never return.
  assert.doesNotThrow(() => {
    processor.export([makeSpan('s1'), makeSpan('s2')]);
  });
  // Floored to 1 -> each span auto-exports as a single-span batch.
  assert.equal(batches.length, 2);
  assert.equal(batches[0]!.length, 1);
  assert.equal(processor.queueSize, 0);
});

test('BatchSpanProcessor bounds a single large export to the newest maxQueueSize spans', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxQueueSize: 3,
    maxExportBatchSize: 3,
    scheduler,
  });

  // One oversized export() must retain only the newest maxQueueSize (3); the two
  // oldest are dropped during ingest, never allocating past the bound.
  processor.export([
    makeSpan('s1'),
    makeSpan('s2'),
    makeSpan('s3'),
    makeSpan('s4'),
    makeSpan('s5'),
  ]);
  assert.equal(processor.droppedSpans, 2);

  processor.forceFlush();
  // Only the newest 3 were ever retained/exported; s1 and s2 were evicted.
  assert.deepEqual(
    batches.flat().map((s) => s.name),
    ['s3', 's4', 's5'],
  );
});

test('BatchSpanProcessor floors maxQueueSize at 1 and counts drops exactly', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxQueueSize: 0, // floored to 1
    maxExportBatchSize: 100, // clamped down to maxQueueSize (1)
    scheduler,
  });

  processor.export([makeSpan('s1'), makeSpan('s2')]);
  // Exactly one dropped (the oldest), not over-counted by raw excess math.
  assert.equal(processor.droppedSpans, 1);

  processor.forceFlush();
  assert.deepEqual(
    batches.flat().map((s) => s.name),
    ['s2'],
  );
});

test('intervalScheduler returns a ScheduledTask with cancel function', () => {
  const task = intervalScheduler.schedule(() => {}, 60000);
  assert.equal(typeof task.cancel, 'function');
  assert.doesNotThrow(() => task.cancel());
});

test('BatchSpanProcessor records received, exported, and batches metrics when provided', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };
  const metrics = new InMemoryMetrics();

  const processor = new BatchSpanProcessor(downstream, {
    maxExportBatchSize: 2,
    scheduler,
    metrics,
  });

  processor.export([makeSpan('s1'), makeSpan('s2'), makeSpan('s3')]);
  processor.forceFlush();

  const rendered = metrics.render();
  assert.match(rendered, /^span_export_received_total 3$/m);
  assert.match(rendered, /^span_export_exported_total 3$/m);
  assert.match(rendered, /^span_export_batches_total 2$/m);
});

test('BatchSpanProcessor records dropped metrics on queue overflow', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };
  const metrics = new InMemoryMetrics();

  const processor = new BatchSpanProcessor(downstream, {
    maxQueueSize: 2,
    maxExportBatchSize: 100,
    scheduler,
    metrics,
  });

  processor.export([makeSpan('s1'), makeSpan('s2'), makeSpan('s3')]);

  assert.equal(processor.droppedSpans, 1);
  const rendered = metrics.render();
  assert.match(rendered, /^span_export_dropped_total 1$/m);
});

test('BatchSpanProcessor records dropped metrics on post-shutdown export', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };
  const metrics = new InMemoryMetrics();

  const processor = new BatchSpanProcessor(downstream, {
    maxExportBatchSize: 5,
    scheduler,
    metrics,
  });

  processor.export([makeSpan('s1')]);
  processor.forceFlush();
  processor.shutdown();

  processor.export([makeSpan('s2'), makeSpan('s3')]);

  assert.equal(processor.droppedSpans, 2);
  const rendered = metrics.render();
  assert.match(rendered, /^span_export_dropped_total 2$/m);
});

test('BatchSpanProcessor operates without throwing when no metrics registry is provided', () => {
  const { scheduler } = makeManualScheduler();
  const batches: SpanData[][] = [];
  const downstream: SpanExporter = { export: (s) => batches.push([...s]) };

  const processor = new BatchSpanProcessor(downstream, {
    maxQueueSize: 2,
    maxExportBatchSize: 2,
    scheduler,
  });

  assert.doesNotThrow(() => {
    processor.export([makeSpan('s1'), makeSpan('s2'), makeSpan('s3')]);
    processor.forceFlush();
    processor.shutdown();
    processor.export([makeSpan('s4')]);
  });
});

