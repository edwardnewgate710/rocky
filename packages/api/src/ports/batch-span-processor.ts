/**
 * @packageDocumentation
 * BatchSpanProcessor implementation (M13 observability increment 4).
 *
 * Decorates a {@link SpanExporter} to buffer finished spans and export them in batches,
 * turning per-span exports into per-batch exports.
 *
 * Design & Behavior:
 * - Best-effort / non-blocking: `export`, `forceFlush`, and `shutdown` contain downstream export errors
 *   and never throw into the caller's thread (such as inside a tracer `SpanSink`).
 * - Bounded memory / Overflow policy: Drops OLDEST spans when `queue.length > maxQueueSize` to bound memory usage,
 *   incrementing the `droppedSpans` counter per dropped span.
 * - Periodic flush: Bounds the maximum loss window using a configurable {@link Scheduler}
 *   (defaults to {@link intervalScheduler} with unref'd `setInterval`).
 * - Lifecycle drain: `shutdown()` cancels periodic scheduling and force-flushes any remaining queued spans.
 * - Idempotency: `shutdown()` is safe to call multiple times.
 * - Deferred Retry: RETRY of failed batch exports is intentionally deferred, as the synchronous `void`
 *   contract of `SpanExporter.export` cannot signal export status without async/promise refactoring.
 */

import type { SpanData } from './tracer';
import type { SpanExporter } from './span-export';
import type { Metrics, Counter } from './metrics';

export interface ScheduledTask {
  cancel(): void;
}

export interface Scheduler {
  schedule(callback: () => void, delayMs: number): ScheduledTask;
}

export const intervalScheduler: Scheduler = {
  schedule(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    // Do not keep the process alive solely for span flushing.
    if (typeof timer.unref === 'function') timer.unref();
    return { cancel: () => clearInterval(timer) };
  },
};

export interface BatchSpanProcessorOptions {
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduledDelayMillis?: number;
  scheduler?: Scheduler;
  /** Optional metrics registry; when provided, the processor emits span-export counters for scraping at `/v1/metrics`. */
  metrics?: Metrics;
}

const DEFAULT_MAX_QUEUE_SIZE = 2048;
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 512;
const DEFAULT_SCHEDULED_DELAY_MILLIS = 5000;

export class BatchSpanProcessor implements SpanExporter {
  private queue: SpanData[] = [];
  private droppedCount = 0;
  private shuttingDown = false;

  private readonly maxQueueSize: number;
  private readonly maxExportBatchSize: number;
  private readonly scheduledDelayMillis: number;
  private readonly scheduler: Scheduler;
  private readonly task: ScheduledTask;

  private readonly receivedCounter?: Counter;
  private readonly droppedCounter?: Counter;
  private readonly exportedCounter?: Counter;
  private readonly batchesCounter?: Counter;

  constructor(
    private readonly downstream: SpanExporter,
    options?: BatchSpanProcessorOptions,
  ) {
    if (options?.metrics) {
      this.receivedCounter = options.metrics.counter('span_export_received_total');
      this.droppedCounter = options.metrics.counter('span_export_dropped_total');
      this.exportedCounter = options.metrics.counter('span_export_exported_total');
      this.batchesCounter = options.metrics.counter('span_export_batches_total');
    }
    const rawMaxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    const rawMaxExportBatchSize = options?.maxExportBatchSize ?? DEFAULT_MAX_EXPORT_BATCH_SIZE;

    // Floor at 1 so overflow accounting (excess = length - maxQueueSize) stays
    // exact and the queue always has capacity for at least one span.
    this.maxQueueSize = Math.max(1, rawMaxQueueSize);
    // Floor at 1: a batch size of 0 (or negative) would make the
    // `queue.length >= maxExportBatchSize` drain loop spin forever on zero-length
    // batches. Clamp down to maxQueueSize so a batch never exceeds the queue.
    this.maxExportBatchSize = Math.max(
      1,
      rawMaxExportBatchSize > this.maxQueueSize ? this.maxQueueSize : rawMaxExportBatchSize,
    );
    this.scheduledDelayMillis = options?.scheduledDelayMillis ?? DEFAULT_SCHEDULED_DELAY_MILLIS;
    this.scheduler = options?.scheduler ?? intervalScheduler;

    this.task = this.scheduler.schedule(() => this.forceFlush(), this.scheduledDelayMillis);
  }

  export(spans: readonly SpanData[]): void {
    if (this.shuttingDown) {
      this.droppedCount += spans.length;
      this.droppedCounter?.inc(spans.length);
      return;
    }

    this.receivedCounter?.inc(spans.length);

    // Enforce the bound incrementally so a single large export() never allocates
    // past maxQueueSize: push one, evict the oldest if over cap.
    for (const span of spans) {
      this.queue.push(span);
      if (this.queue.length > this.maxQueueSize) {
        this.queue.shift();
        this.droppedCount += 1;
        this.droppedCounter?.inc(1);
      }
    }

    while (this.queue.length >= this.maxExportBatchSize) {
      this.exportBatch(this.maxExportBatchSize);
    }
  }

  private exportBatch(n: number): void {
    const batch = this.queue.splice(0, n);
    if (batch.length === 0) return;
    this.exportedCounter?.inc(batch.length);
    this.batchesCounter?.inc(1);
    try {
      this.downstream.export(batch);
    } catch {
      /* best-effort — contain downstream export errors */
    }
  }

  forceFlush(): void {
    while (this.queue.length > 0) {
      this.exportBatch(this.maxExportBatchSize);
    }
  }

  shutdown(): void {
    if (this.shuttingDown) {
      this.forceFlush();
      return;
    }
    this.shuttingDown = true;
    try {
      this.task.cancel();
    } catch {
      /* best-effort */
    }
    this.forceFlush();
  }

  get droppedSpans(): number {
    return this.droppedCount;
  }

  get queueSize(): number {
    return this.queue.length;
  }
}
