# 47. Buffered and Batched Span Export (BatchSpanProcessor)

Date: 2026-07-24

## Status

Accepted

## Context

M13 Observability Increment 3 (ADR-0046) introduced the `SpanExporter` seam, `LoggingSpanExporter`, `MultiSpanExporter`, and `OtlpJsonSpanExporter` in `@chess-platform/api`. Finished spans were exported one at a time (`export([span])` per `end()`), causing the OTLP path to issue an individual HTTP POST request per span. ADR-0046 explicitly deferred batched and async export.

This increment introduces `BatchSpanProcessor`, a `SpanExporter` decorator that buffers finished spans and flushes them to a downstream `SpanExporter` in batches, reducing network overhead by turning per-span OTLP HTTP POSTs into per-batch HTTP POSTs.

## Decision

1. **`BatchSpanProcessor` Decorator & `SpanExporter` Seam.**
   - Implemented in `packages/api/src/ports/batch-span-processor.ts`.
   - `BatchSpanProcessor` implements `SpanExporter`, wrapping a downstream `SpanExporter`.
   - Incoming spans via `export(spans)` are buffered into an in-memory queue.
   - Whenever `queue.length >= maxExportBatchSize`, the processor automatically flushes a batch of `maxExportBatchSize` spans to downstream.

2. **Scheduler Seam & Periodic Flush.**
   - Queue contents are periodically force-flushed every `scheduledDelayMillis` (default: 5000ms) to bound the maximum span loss window.
   - Periodic scheduling is abstracted behind a `Scheduler` interface (`schedule(callback, delayMs): ScheduledTask`) and `intervalScheduler` implementation using Node's `setInterval` with `timer.unref()`, ensuring timer execution does not keep Node processes alive solely for span flushing.
   - The `Scheduler` seam permits manual scheduler injection in unit tests for deterministic testing without fake timers.

3. **Bounded Memory & Overflow Policy.**
   - `maxQueueSize` (default: 2048) bounds memory usage under high throughput or downstream export stalls.
   - Defaults match OpenTelemetry standards (`maxQueueSize = 2048`, `maxExportBatchSize = 512`, `scheduledDelayMillis = 5000`). Both `maxQueueSize` and `maxExportBatchSize` are floored at `1` (so overflow accounting stays exact and a zero/negative batch size cannot spin the drain loop on zero-length batches), and `maxExportBatchSize` is additionally clamped down to `maxQueueSize`.
   - The bound is enforced **incrementally during ingest**: each span is pushed and, if the queue then exceeds `maxQueueSize`, the **oldest** span is evicted and the introspectable `droppedSpans` counter is incremented. This keeps the bounded-memory guarantee true even for a single oversized `export()` call (the queue never allocates past `maxQueueSize`), and keeps the drop count exact.

4. **Lifecycle Drain & Containment.**
   - `forceFlush()` flushes the entire queue in chunks of `maxExportBatchSize`.
   - `shutdown()` sets `shuttingDown = true`, cancels the periodic scheduler task, and calls `forceFlush()`. Calls to `export()` after shutdown drop incoming spans and increment `droppedSpans`. `shutdown()` is idempotent.
   - Best-effort / non-blocking contract: `exportBatch` catches downstream export exceptions, ensuring network errors never escape to the caller's thread or interrupt queue flushing.

5. **Bootstrap Wiring.**
   - In production `bootstrap.ts`, when `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is configured, `BatchSpanProcessor` wraps **only** `OtlpJsonSpanExporter` inside `MultiSpanExporter`.
   - `LoggingSpanExporter` remains direct and unbatched, as per-span log records are cheap and immediate.

6. **Deferred Retries & Lifecycle Scope.**
   - **Retry remains deferred:** The synchronous `void` `export(spans)` contract cannot report export failure without async/promise refactoring.
   - Formal service shutdown drain hooks for long-running services remain a follow-up; the unref'd periodic timer bounds loss window meanwhile.

## Consequences

- OTLP export HTTP POST frequency is reduced from per-span to per-batch (up to 512 spans per POST).
- Logging span export behavior remains identical to Increment 3 (direct per-span logs).
- Memory usage is strictly bounded with oldest-drop semantics and drop metrics.
- Deterministic testing is preserved via the injectable `Scheduler` seam.
