# 46. Span Export Seam and OTLP/JSON Exporter

Date: 2026-07-24

## Status

Accepted

## Context

M13 Observability Increment 2 (ADR-0045) introduced the `Tracer` / `Span` / `RecordingTracer` ports and `http.server` span emission in `@chess-platform/api`. Finished spans were passed directly to an inline sink lambda in production `bootstrap.ts` that logged structured `info` records with whitelisted HTTP attributes.

This increment introduces a formal `SpanExporter` seam, refactors the production log sink into a reusable `LoggingSpanExporter`, adds a `MultiSpanExporter` fan-out composite, and introduces an `OtlpJsonSpanExporter` that serializes span batches to OTLP/JSON format and hands them to an injectable `SpanTransport`.

## Decision

1. **`SpanExporter` Seam & Best-Effort Contract in `@chess-platform/api`.**
   - Core interface: `export interface SpanExporter { export(spans: readonly SpanData[]): void; }`.
   - Contract: `export` is **best-effort and non-blocking**. It MUST NOT throw and MUST NOT perform slow synchronous work on the caller's thread; implementations queue or fire-and-forget internally and contain their own errors.
   - `spanSinkFromExporter(exporter)` adapts a `SpanExporter` to the tracer's `SpanSink` signature `(span) => exporter.export([span])`, wrapping the call in `try/catch` so a misbehaving exporter can never throw out of the tracer sink into the request path.
   - `BOUNDED_SPAN_ATTRS` (`['http.method', 'http.route', 'http.status_code']`) and `pickBoundedAttrs(attrs)` are exported from `span-export.ts` as the single source of truth for attribute whitelisting.

2. **`LoggingSpanExporter` & `MultiSpanExporter`.**
   - `LoggingSpanExporter` wraps a `Logger` and emits `logger.info('span', { name, traceId, spanId, parentId, kind, status, durationMs, ...pickBoundedAttrs(attributes) })` per span, matching the exact record shape produced in Increment 2.
   - `MultiSpanExporter` fans out `export(spans)` to multiple child exporters. Each child call is wrapped in a `try/catch` block so a failure in one exporter (e.g. network failure) does not prevent export to others.

3. **Pure OTLP/JSON Mapping & `OtlpJsonSpanExporter`.**
   - OTLP/JSON types defined: `OtlpAnyValue` (`stringValue`, `intValue`, `boolValue`, `doubleValue`), `OtlpKeyValue`, `OtlpSpan`, `OtlpResource`, `OtlpScopeSpans`, `OtlpResourceSpans`, `OtlpTracesPayload`, `OtlpResourceInfo`, and `SpanTransport`.
   - Pure mapping helper `toResourceSpans(spans, resource)` maps `SpanData` to `OtlpSpan`:
     - `kind`: `internal` → 1, `server` → 2, `client` → 3.
     - `status.code`: `unset` → 0, `ok` → 1, `error` → 2.
     - `parentSpanId`: populated ONLY when `span.parentId !== null` (omitted from object otherwise).
     - Timestamps in nanoseconds via `BigInt` math to prevent numeric precision loss: `startTimeUnixNano = String(BigInt(span.startTimeMs) * 1000000n)` and `endTimeUnixNano = String((BigInt(span.startTimeMs) + BigInt(span.durationMs)) * 1000000n)`.
     - Attribute values typed via `toOtlpAnyValue`: strings → `stringValue`, booleans → `boolValue`, integer numbers → `intValue` (string encoded int64), non-integer numbers → `doubleValue`.
     - Wrapped in single `resourceSpans` (`service.name` resource attribute) and single `scopeSpans` (`name` and `version`).
   - `OtlpJsonSpanExporter` delegates to an injected `SpanTransport`. No-ops when `spans` array is empty. Wraps `transport.send()` in `try/catch`.

4. **Environment Gate & Boundary Transport.**
   - The traces endpoint is resolved per the OpenTelemetry OTLP/HTTP spec by the pure helper `resolveOtlpTracesEndpoint(tracesEndpoint, baseEndpoint)`: a signal-specific `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is used verbatim, while the generic `OTEL_EXPORTER_OTLP_ENDPOINT` is a **base** URL onto which `/v1/traces` is appended (trimming a lone trailing slash first). When neither is set, no OTLP exporter is built.
   - In `bootstrap.ts`, when a traces endpoint resolves, production constructs an `OtlpJsonSpanExporter` backed by `FetchSpanTransport(resolvedUrl)` and combines it with `LoggingSpanExporter` via `MultiSpanExporter`. Otherwise it uses `LoggingSpanExporter` exclusively.
   - `FetchSpanTransport` is a thin, fire-and-forget boundary adapter that POSTs `JSON.stringify(payload)` to the target endpoint using global `fetch`, with unawaited `.catch(() => {})`.

5. **PII and Deferred Work.**
   - PII discipline is strictly preserved: `LoggingSpanExporter` whitelists bounded HTTP attributes; OTLP export forwards whatever attributes were set on the span (which the HTTP router already restricts to method, route pattern, and status code).
   - **Buffered / batched async export, queueing, and retry remain deferred** (spans currently export per-`end()`).

## Consequences

- Applications can export spans to any OpenTelemetry collector over OTLP/JSON via a single environment variable `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Log-based span visibility is preserved by default without breaking change.
- Multi-exporter fan-out allows logging and OTLP collectors to run concurrently without interference.
- Tracing export remains fully non-blocking and safe for the request path.
