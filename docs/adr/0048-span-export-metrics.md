# 48. Span Export Pipeline Self-Instrumentation (Metrics)

Date: 2026-07-24

## Status

Accepted

## Context

M13 Observability Increment 4 (ADR-0047) introduced `BatchSpanProcessor` in `@chess-platform/api` to buffer finished spans and export them in batches, bounding memory with an oldest-drop overflow policy. Prior to this increment, the processor's runtime health (how many spans were received, dropped, or exported) was invisible to operators scraping Prometheus metrics at `GET /v1/metrics`.

This increment makes the span export pipeline self-observing by instrumenting `BatchSpanProcessor` with Prometheus counters emitted through the existing `Metrics` port.

## Decision

1. **Opt-in `Metrics` Port Integration.**
   - `BatchSpanProcessorOptions` accepts an optional `metrics?: Metrics` registry.
   - When provided, `BatchSpanProcessor` creates and caches four Prometheus counters:
     - `span_export_received_total` — Total count of spans accepted into the export pipeline.
     - `span_export_dropped_total` — Total count of spans dropped (queue overflow eviction + post-shutdown exports).
     - `span_export_exported_total` — Total count of spans handed to the downstream exporter (in batches).
     - `span_export_batches_total` — Total count of batches dispatched to the downstream exporter.

2. **Cardinality & Safety.**
   - All four counters carry NO labels (`labels: {}`), adhering to strict cardinality and PII rules.

3. **Increment Points & Dropped Count Agreement.**
   - `export(spans)`: If shutting down, increments `span_export_dropped_total` by `spans.length` (matching `droppedCount += spans.length`). Otherwise, increments `span_export_received_total` by `spans.length` before enqueuing, and increments `span_export_dropped_total` by `1` per overflow eviction.
   - `exportBatch(n)`: Increments `span_export_exported_total` by `batch.length` and `span_export_batches_total` by `1` when a batch is dispatched downstream.
   - `span_export_dropped_total` and the existing `droppedSpans` getter stay in exact agreement.

4. **Export Dispatched Meaning & Deferred Failure Metrics.**
   - `span_export_exported_total` represents spans handed/dispatched to the downstream exporter. Because the synchronous `void` `export(spans)` contract does not return delivery receipts or promises, it cannot confirm downstream collector receipt.
   - A dedicated export-FAILURE metric and retries remain deferred until the async-exporter increment.

5. **Zero Overhead Default.**
   - When `options.metrics` is absent, counter fields remain undefined and increments are short-circuited via optional chaining (`?.inc(...)`). The no-metrics path is zero-overhead and behaviorally identical to Increment 4.

6. **Bootstrap Wiring.**
   - In production `bootstrap.ts`, the shared `metrics` instance (which backs `GET /v1/metrics`) is passed to `BatchSpanProcessor` on the OTLP export path.

## Consequences

- Operators can scrape `GET /v1/metrics` to monitor span ingest, batching throughput, and alert on span loss (`span_export_dropped_total`).
- The processor remains dependency-free and fully synchronous.
- Zero overhead for callers not providing a `Metrics` registry.
