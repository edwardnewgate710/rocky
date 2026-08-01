/**
 * @packageDocumentation
 * BatchSpanProcessor implementation (M13 observability increment 7, ADR-0063).
 *
 * Decorates a {@link SpanExporter} to buffer finished spans and export them in batches,
 * turning per-span exports into per-batch exports with honest metrics and bounded retry.
 *
 * Design & Behavior:
 * - Best-effort / non-blocking: `export`, `forceFlush`, and `shutdown` contain downstream export errors
 *   and never throw into the caller's thread (such as inside a tracer `SpanSink`).
 * - Honest metrics: `span_export_exported_total` is incremented ONLY upon confirmed export success.
 *   `span_export_failed_total` counts spans whose final export attempt failed.
 * - Bounded retry: Retryable transport failures are retried up to `maxExportRetries` (default 3)
 *   attempts, scheduled through the `Scheduler` seam. Non-retryable failures fail immediately.
 * - Bounded memory / Overflow policy: Drops OLDEST spans when total pending spans (queued + retrying)
 *   exceed `maxQueueSize`, incrementing the `span_export_dropped_total` counter per dropped span.
 * - Periodic flush: Bounds the maximum loss window using a configurable {@link Scheduler}
 *   (defaults to {@link intervalScheduler} with unref'd `setInterval`).
 * - Lifecycle drain: `shutdown()` cancels pending retries, marks unsent retries as failed,
 *   and force-flushes any remaining queued spans synchronously without hanging.
 */

import type { SpanData } from './tracer';
import type { SpanExporter, OutcomeReportingSpanExporter } from './span-export';
import { asOutcomeReporting } from './span-export';
import type { Metrics, Counter } from './metrics';
import type { SpanExportOutcome } from './otlp-span-exporter';

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
  maxExportRetries?: number;
  scheduler?: Scheduler;
  /** Optional metrics registry; when provided, the processor emits span-export counters for scraping at `/v1/metrics`. */
  metrics?: Metrics;
}

const DEFAULT_MAX_QUEUE_SIZE = 2048;
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 512;
const DEFAULT_SCHEDULED_DELAY_MILLIS = 5000;
const DEFAULT_MAX_EXPORT_RETRIES = 3;

interface RetryingBatch {
  spans: SpanData[];
  attempts: number;
  task?: ScheduledTask;
}

export class BatchSpanProcessor implements SpanExporter {
  private queue: SpanData[] = [];
  private retryingBatches: RetryingBatch[] = [];
  private droppedCount = 0;
  private shuttingDown = false;

  private readonly maxQueueSize: number;
  private readonly maxExportBatchSize: number;
  private readonly scheduledDelayMillis: number;
  private readonly maxExportRetries: number;
  private readonly scheduler: Scheduler;
  private readonly task: ScheduledTask;
  /** Set when the downstream exporter can confirm delivery; otherwise exports are counted optimistically. */
  private readonly outcomeExporter: OutcomeReportingSpanExporter | undefined;

  private readonly receivedCounter?: Counter;
  private readonly droppedCounter?: Counter;
  private readonly exportedCounter?: Counter;
  private readonly failedCounter?: Counter;
  private readonly batchesCounter?: Counter;

  constructor(
    private readonly downstream: SpanExporter,
    options?: BatchSpanProcessorOptions,
  ) {
    if (options?.metrics) {
      this.receivedCounter = options.metrics.counter('span_export_received_total');
      this.droppedCounter = options.metrics.counter('span_export_dropped_total');
      this.exportedCounter = options.metrics.counter('span_export_exported_total');
      this.failedCounter = options.metrics.counter('span_export_failed_total');
      this.batchesCounter = options.metrics.counter('span_export_batches_total');
    }
    const rawMaxQueueSize = options?.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    const rawMaxExportBatchSize = options?.maxExportBatchSize ?? DEFAULT_MAX_EXPORT_BATCH_SIZE;

    // Floor at 1 so overflow accounting stays exact and the queue always has capacity.
    this.maxQueueSize = Math.max(1, rawMaxQueueSize);
    this.maxExportBatchSize = Math.max(
      1,
      rawMaxExportBatchSize > this.maxQueueSize ? this.maxQueueSize : rawMaxExportBatchSize,
    );
    this.scheduledDelayMillis = options?.scheduledDelayMillis ?? DEFAULT_SCHEDULED_DELAY_MILLIS;
    this.maxExportRetries = Math.max(1, options?.maxExportRetries ?? DEFAULT_MAX_EXPORT_RETRIES);
    this.scheduler = options?.scheduler ?? intervalScheduler;

    this.outcomeExporter = asOutcomeReporting(downstream);

    this.task = this.scheduler.schedule(() => this.forceFlush(), this.scheduledDelayMillis);
  }

  export(spans: readonly SpanData[]): void {
    if (this.shuttingDown) {
      this.droppedCount += spans.length;
      this.droppedCounter?.inc(spans.length);
      return;
    }

    this.receivedCounter?.inc(spans.length);

    for (const span of spans) {
      this.queue.push(span);
      this.enforceMemoryBound();
    }

    while (this.queue.length >= this.maxExportBatchSize) {
      this.exportBatch(this.maxExportBatchSize);
    }
  }

  private getTotalPendingSpans(): number {
    let total = this.queue.length;
    for (const rb of this.retryingBatches) {
      total += rb.spans.length;
    }
    return total;
  }

  private enforceMemoryBound(): void {
    while (this.getTotalPendingSpans() > this.maxQueueSize) {
      if (this.retryingBatches.length > 0) {
        const oldestBatch = this.retryingBatches[0]!;
        oldestBatch.spans.shift();
        this.droppedCount += 1;
        this.droppedCounter?.inc(1);
        if (oldestBatch.spans.length === 0) {
          oldestBatch.task?.cancel();
          this.retryingBatches.shift();
        }
      } else if (this.queue.length > 0) {
        this.queue.shift();
        this.droppedCount += 1;
        this.droppedCounter?.inc(1);
      } else {
        break;
      }
    }
  }

  private exportBatch(n: number): void {
    const batch = this.queue.splice(0, n);
    if (batch.length === 0) return;
    this.sendBatch(batch, 1);
  }

  private sendBatch(batch: SpanData[], attempts: number): void {
    if (batch.length === 0) return;
    this.batchesCounter?.inc(1);

    const outcomeExporter = this.outcomeExporter;
    if (!outcomeExporter) {
      // A plain SpanExporter cannot report delivery, so a completed call is the only evidence
      // available. Counted optimistically and documented as such in ADR-0063.
      try {
        this.downstream.export(batch);
        this.exportedCounter?.inc(batch.length);
      } catch {
        /* best-effort — contain downstream export errors (ADR-0046) */
        this.failedCounter?.inc(batch.length);
      }
      return;
    }

    // The promise is what ties a result to THIS batch. An earlier revision set a callback on the
    // exporter and matched results to batches by array identity, falling back to "whichever batch
    // is first in the map" — with several batches in flight during a flush that silently credited
    // one batch's success to another.
    let pending: Promise<SpanExportOutcome>;
    try {
      pending = outcomeExporter.exportWithOutcome(batch);
    } catch {
      this.handleOutcome(batch, attempts, {
        ok: false,
        retryable: false,
        reason: 'exporter_threw',
      });
      return;
    }

    void pending.then(
      (outcome) => this.handleOutcome(batch, attempts, outcome),
      () =>
        this.handleOutcome(batch, attempts, {
          ok: false,
          retryable: true,
          reason: 'exporter_rejected',
        }),
    );
  }

  private handleOutcome(
    batch: SpanData[],
    attempts: number,
    outcome: SpanExportOutcome,
  ): void {
    const retryingIndex = this.retryingBatches.findIndex((rb) => rb.spans === batch);
    if (retryingIndex !== -1) {
      this.retryingBatches.splice(retryingIndex, 1);
    }

    const currentSpans = batch;
    const actualCount = currentSpans.length;
    if (actualCount === 0) return;

    if (outcome.ok) {
      this.exportedCounter?.inc(actualCount);
    } else {
      if (outcome.retryable && attempts < this.maxExportRetries && !this.shuttingDown) {
        const nextAttempts = attempts + 1;
        const retryingBatch: RetryingBatch = {
          spans: currentSpans,
          attempts: nextAttempts,
        };

        retryingBatch.task = this.scheduleOnce(() => {
          const idx = this.retryingBatches.indexOf(retryingBatch);
          if (idx !== -1) {
            this.retryingBatches.splice(idx, 1);
          }
          if (!this.shuttingDown) {
            this.sendBatch(retryingBatch.spans, retryingBatch.attempts);
          } else {
            this.failedCounter?.inc(retryingBatch.spans.length);
          }
        }, this.scheduledDelayMillis);
        this.retryingBatches.push(retryingBatch);
      } else {
        this.failedCounter?.inc(actualCount);
      }
    }
  }

  /**
   * Runs `cb` exactly once after `delayMs`, whatever the Scheduler underneath does.
   *
   * The seam exists for the PERIODIC flush, so its default implementation is `setInterval`. A retry
   * scheduled straight through it therefore fires forever: the same batch would be resent every
   * interval, long past `maxExportRetries`, duplicating spans at the collector and inflating the
   * counters. The `fired` latch is the real guard — `cancel()` is the cleanup that stops the timer.
   */
  private scheduleOnce(cb: () => void, delayMs: number): ScheduledTask {
    let task: ScheduledTask | undefined;
    let fired = false;
    task = this.scheduler.schedule(() => {
      if (fired) return;
      fired = true;
      try {
        task?.cancel();
      } catch {
        /* best-effort */
      }
      cb();
    }, delayMs);
    return task;
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

    for (const rb of this.retryingBatches) {
      try {
        rb.task?.cancel();
      } catch {
        /* best-effort */
      }
      this.failedCounter?.inc(rb.spans.length);
    }
    this.retryingBatches = [];

    this.forceFlush();
  }

  get droppedSpans(): number {
    return this.droppedCount;
  }

  get queueSize(): number {
    return this.queue.length;
  }
}
