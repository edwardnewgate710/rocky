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
import { OtlpJsonSpanExporter, type SpanTransport } from '../src/ports/otlp-span-exporter';

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


// --- ADR-0063: export failure visibility + bounded retry --------------------

/**
 * The scheduler helper above keeps only the LAST scheduled callback, which is fine for the single
 * periodic flush but silently loses retry tasks. This one keeps every pending task so retries can
 * be run deliberately.
 */
function makeQueueingScheduler() {
  const tasks: (() => void)[] = [];
  const scheduler: Scheduler = {
    schedule(cb) {
      tasks.push(cb);
      return {
        cancel() {
          const i = tasks.indexOf(cb);
          if (i !== -1) tasks.splice(i, 1);
        },
      };
    },
  };
  // Runs every task queued at call time; tasks queued BY those tasks wait for the next call.
  const runPending = (): void => {
    const due = tasks.splice(0, tasks.length);
    for (const t of due) t();
  };
  return { scheduler, runPending, pendingCount: () => tasks.length };
}

/** Lets the promise chain inside sendBatch settle before assertions run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function makeOtlpExporter(transport: SpanTransport): OtlpJsonSpanExporter {
  return new OtlpJsonSpanExporter(transport, {
    serviceName: 'api',
    scopeName: 'test',
    scopeVersion: '0.1.0',
  });
}

function counterValue(metrics: InMemoryMetrics, name: string): number {
  for (const line of metrics.render().split('\n')) {
    const [metric, value] = line.trim().split(' ');
    if (metric === name) return Number(value);
  }
  return 0;
}

test('a retryable failure is retried up to the cap, then counted failed', async () => {
  const { scheduler, runPending } = makeQueueingScheduler();
  const metrics = new InMemoryMetrics();
  let attempts = 0;
  const exporter = makeOtlpExporter({
    async send() {
      attempts += 1;
      return { ok: false as const, retryable: true, reason: 'http_503' };
    },
  });

  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 1,
    maxExportRetries: 3,
    scheduler,
    metrics,
  });

  processor.export([makeSpan('s1')]);
  await flush();
  assert.equal(attempts, 1, 'the first attempt is immediate');

  for (let i = 0; i < 4; i++) {
    runPending();
    await flush();
  }

  assert.equal(attempts, 3, 'attempts must stop at maxExportRetries');
  assert.equal(counterValue(metrics, 'span_export_failed_total'), 1);
  assert.equal(counterValue(metrics, 'span_export_exported_total'), 0);
});

test('success on a retry counts exported once and never counts failed', async () => {
  const { scheduler, runPending } = makeQueueingScheduler();
  const metrics = new InMemoryMetrics();
  let attempts = 0;
  const exporter = makeOtlpExporter({
    async send() {
      attempts += 1;
      return attempts < 2
        ? { ok: false as const, retryable: true, reason: 'http_500' }
        : { ok: true as const };
    },
  });

  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 1,
    maxExportRetries: 3,
    scheduler,
    metrics,
  });

  processor.export([makeSpan('s1')]);
  await flush();
  runPending();
  await flush();

  assert.equal(attempts, 2);
  assert.equal(
    counterValue(metrics, 'span_export_exported_total'),
    1,
    'counted once for the batch, not once per attempt',
  );
  assert.equal(counterValue(metrics, 'span_export_failed_total'), 0);
});

test('a non-retryable failure (HTTP 401) is not retried and is counted failed at once', async () => {
  const { scheduler, runPending, pendingCount } = makeQueueingScheduler();
  const metrics = new InMemoryMetrics();
  let attempts = 0;
  const exporter = makeOtlpExporter({
    async send() {
      attempts += 1;
      return { ok: false as const, retryable: false, reason: 'http_401' };
    },
  });

  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 1,
    maxExportRetries: 3,
    scheduler,
    metrics,
  });

  const before = pendingCount();
  processor.export([makeSpan('s1')]);
  await flush();

  assert.equal(attempts, 1);
  assert.equal(pendingCount(), before, 'no retry may be scheduled');
  assert.equal(counterValue(metrics, 'span_export_failed_total'), 1);

  runPending();
  await flush();
  assert.equal(attempts, 1, 'still no retry after the scheduler runs');
});

// The regression this whole increment exists for: the counter used to be incremented before the
// send even happened, so a collector rejecting everything looked perfectly healthy.
test('span_export_exported_total does not move while the transport is failing', async () => {
  const { scheduler } = makeQueueingScheduler();
  const metrics = new InMemoryMetrics();
  const exporter = makeOtlpExporter({
    async send() {
      return { ok: false as const, retryable: false, reason: 'http_413' };
    },
  });

  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 2,
    maxExportRetries: 1,
    scheduler,
    metrics,
  });

  processor.export([makeSpan('s1'), makeSpan('s2')]);
  await flush();

  assert.equal(counterValue(metrics, 'span_export_exported_total'), 0);
  assert.equal(counterValue(metrics, 'span_export_failed_total'), 2);
});

test('an exporter whose promise rejects is treated as a failure, not an unhandled rejection', async () => {
  const { scheduler } = makeQueueingScheduler();
  const metrics = new InMemoryMetrics();
  const rejecting = {
    export(): void {
      /* no-op */
    },
    exportWithOutcome(): Promise<never> {
      return Promise.reject(new Error('badly behaved exporter'));
    },
  };

  const processor = new BatchSpanProcessor(rejecting, {
    maxExportBatchSize: 1,
    maxExportRetries: 1,
    scheduler,
    metrics,
  });

  assert.doesNotThrow(() => processor.export([makeSpan('s1')]));
  await flush();

  assert.equal(counterValue(metrics, 'span_export_failed_total'), 1);
  assert.equal(counterValue(metrics, 'span_export_exported_total'), 0);
});

test('shutdown during a pending retry neither hangs nor loses the failure count', async () => {
  const { scheduler } = makeQueueingScheduler();
  const metrics = new InMemoryMetrics();
  const exporter = makeOtlpExporter({
    async send() {
      return { ok: false as const, retryable: true, reason: 'http_503' };
    },
  });

  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 1,
    maxExportRetries: 5,
    scheduler,
    metrics,
  });

  processor.export([makeSpan('s1')]);
  await flush();

  assert.doesNotThrow(() => processor.shutdown());
  assert.equal(
    counterValue(metrics, 'span_export_failed_total'),
    1,
    'spans still awaiting retry are counted failed',
  );
  assert.doesNotThrow(() => processor.shutdown(), 'shutdown stays idempotent');
});

test('spans awaiting retry still count against maxQueueSize', async () => {
  const { scheduler } = makeQueueingScheduler();
  const metrics = new InMemoryMetrics();
  const exporter = makeOtlpExporter({
    async send() {
      return { ok: false as const, retryable: true, reason: 'http_503' };
    },
  });

  const processor = new BatchSpanProcessor(exporter, {
    maxQueueSize: 2,
    maxExportBatchSize: 1,
    maxExportRetries: 5,
    scheduler,
    metrics,
  });

  // Each export fails and parks its span in the retry buffer; the bound must still hold.
  for (const name of ['s1', 's2', 's3', 's4']) {
    processor.export([makeSpan(name)]);
    await flush();
  }

  assert.ok(
    processor.droppedSpans > 0,
    'exceeding the bound with retrying batches must drop, not grow without limit',
  );
  assert.equal(
    counterValue(metrics, 'span_export_dropped_total'),
    processor.droppedSpans,
    'the dropped counter must agree with droppedSpans',
  );
});

// Regression (Qodo, PR #57): retries were scheduled through the Scheduler seam, whose default
// implementation is setInterval. A retry task therefore fired FOREVER, resending the same batch
// every interval past maxExportRetries. The queueing fake above splices each task out when it runs,
// making every task one-shot by construction — it could never have caught this. This fake repeats,
// like the real one.
function makeRepeatingScheduler() {
  const tasks = new Set<() => void>();
  const scheduler: Scheduler = {
    schedule(cb) {
      tasks.add(cb);
      return {
        cancel() {
          tasks.delete(cb);
        },
      };
    },
  };
  // Fires every LIVE task, and keeps firing it on later ticks unless it cancelled itself.
  const tick = (): void => {
    for (const t of [...tasks]) t();
  };
  return { scheduler, tick, liveCount: () => tasks.size };
}

test('retries stop at the cap even when the scheduler repeats (setInterval-style)', async () => {
  const { scheduler, tick } = makeRepeatingScheduler();
  const metrics = new InMemoryMetrics();
  let attempts = 0;
  const exporter = makeOtlpExporter({
    async send() {
      attempts += 1;
      return { ok: false as const, retryable: true, reason: 'http_503' };
    },
  });

  const processor = new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 1,
    maxExportRetries: 2,
    scheduler,
    metrics,
  });

  processor.export([makeSpan('s1')]);
  await flush();
  assert.equal(attempts, 1);

  // Tick far more times than the cap. With a repeating scheduler and no self-cancel, the retry
  // task would resend on every one of these.
  for (let i = 0; i < 10; i++) {
    tick();
    await flush();
  }

  assert.equal(attempts, 2, 'a repeating scheduler must not resend past maxExportRetries');
  assert.equal(counterValue(metrics, 'span_export_failed_total'), 1);
  assert.equal(counterValue(metrics, 'span_export_exported_total'), 0);
});
