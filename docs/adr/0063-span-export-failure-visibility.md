# 63. Span Export Failure Visibility and Bounded Retry

Date: 2026-08-01

## Status

Accepted

## Context

Prior to this increment (ADR-0047, ADR-0048), `FetchSpanTransport.send()` swallowed network rejections and synchronous errors while never inspecting `response.ok` (treating HTTP 401, 413, 429, 500 as successes). Furthermore, `BatchSpanProcessor.exportBatch` incremented `span_export_exported_total` *before* issuing the downstream `export()` call, meaning the metric measured export attempts rather than confirmed collector delivery. If the OTLP collector was down, misconfigured, or rejecting payloads, spans were silently lost while metrics reported perfect pipeline health. ADR-0047 and ADR-0048 deferred failure handling, noting it required an async exporter result.

This increment resolves those blind spots by introducing asynchronous outcome reporting (`SpanExportOutcome`), HTTP status and network failure classification, bounded retries with backoff, honest `span_export_exported_total` metrics, and a new `span_export_failed_total` counter.

## Decision

1. **Async Outcome Reporting without Blocking the Request Path (`SpanExportOutcome`).**
   - The non-negotiable contract of `SpanExporter.export(spans: readonly SpanData[]): void` remains unchanged: span export is best-effort and non-blocking and MUST NOT block or fail the caller's request path.
   - `SpanTransport.send` now returns `Promise<SpanExportOutcome>`:
     - `{ readonly ok: true }`
     - `{ readonly ok: false; readonly retryable: boolean; readonly reason: string }`
   - Callers do NOT await `send()`. `OtlpJsonSpanExporter.export()` issues `send()` asynchronously and attaches outcome callbacks without blocking. `send()` MUST NOT reject under any circumstances; all rejections and synchronous throws are caught and resolved to `{ ok: false, retryable: true, reason: 'network' }`.

2. **Classification in `FetchSpanTransport`.**
   - Network/DNS/TLS rejections or synchronous throws resolve to `{ ok: false, retryable: true, reason: 'network' }`.
   - `response.ok === false`:
     - `408`, `429`, and any `5xx` -> retryable (`retryable: true`, reason `'http_<status>'`).
     - all other `4xx` (e.g. 401, 403, 413) -> permanent/non-retryable (`retryable: false`, reason `'http_<status>'`), as retrying a 401 or 413 will fail identically forever and wastes resources.
   - `response.ok === true` -> `{ ok: true }`.

3. **Exporter Outcome Callback (`onOutcome`).**
   - `OtlpJsonSpanExporter` accepts an optional `onOutcome?: (outcome: SpanExportOutcome, spanCount: number, spans?: readonly SpanData[]) => void` callback.
   - The exporter maps and dispatches payloads; retry and metrics policy belong exclusively to `BatchSpanProcessor`.

4. **BatchSpanProcessor: Honest Metrics & Bounded Retry.**
   - **Honest `span_export_exported_total`**: Moved from export dispatch to confirmed success (`ok: true`).
   - **New `span_export_failed_total`**: Incremented by the span count of a batch whose final attempt failed (either non-retryable or retries exhausted).
   - **Bounded Retry**: Retryable failures are retried up to `maxExportRetries` (default 3) attempts. Backoff is scheduled through the existing `Scheduler` seam — never direct `setTimeout`.
   - **Bounded Memory**: Spans in retrying batches count toward `maxQueueSize`. If total pending spans (queued + retrying) exceed `maxQueueSize`, the oldest spans (from the oldest retrying batch or fresh queue) are evicted, incrementing `span_export_dropped_total`.
   - **Synchronous Non-Blocking `shutdown()`**: Cancels pending retry tasks, counts unsent retrying spans as failed, and force-flushes queued spans synchronously. `shutdown()` never hangs.

### Retries are one-shot, whatever the Scheduler does

The `Scheduler` seam exists for the PERIODIC flush, so its default implementation
(`intervalScheduler`) is `setInterval` — repeating. A retry scheduled straight through it fires
forever: the same batch is resent every interval, long past `maxExportRetries`, duplicating spans
at the collector and inflating the counters this increment set out to make honest. Production wires
the default scheduler, so this would have shipped.

`BatchSpanProcessor.scheduleOnce` latches on first invocation and cancels its own task, making a
retry one-shot under a repeating or a one-shot implementation alike.

The regression test uses a deliberately *repeating* fake. The queueing fake used by the other retry
tests splices each task out as it runs, which makes every task one-shot by construction — it could
not have caught this, and a test harness more forgiving than the real implementation is worse than
no test at all.

### Correlation is the promise, not a callback

`BatchSpanProcessor` calls `exportWithOutcome(batch)` and closes over that batch in the `.then`.
That is the whole correlation mechanism.

A first cut of this increment instead had the processor assign a callback onto the downstream
exporter (`downstream.onOutcome = ...`) from its constructor and match results back to batches
through a `Map` keyed by array identity, with a fallback that picked *whichever batch happened to
be first in the map* when the lookup missed. Because `export()` drains a full queue by firing
several batches back to back, outcomes were routinely attributed to the wrong batch — one batch's
success could mark another exported and leave the real one retrying. Monkey-patching a collaborator
from a constructor also meant wrapping the same exporter twice silently corrupted both.

The capability interface avoids all of it: no mutation of a collaborator, no identity map, and the
result of a call is delivered to the call that made it.

## Consequences

- OTLP export failures (network outages, collector HTTP errors) are visible via `span_export_failed_total` at `/v1/metrics` and `/metrics`.
- `span_export_exported_total` reflects confirmed delivery rather than attempts.
- Transient network and 5xx collector errors are retried up to 3 times without breaking memory bounds.
- Non-retryable configuration errors (e.g. 401 Unauthorized) fail fast without wasteful retry loops.
- `SpanExporter.export()` remains strictly non-blocking on the request path.
