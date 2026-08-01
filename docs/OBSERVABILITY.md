# Gambit Observability Guide

This guide describes the operational observability capabilities implemented across the Gambit platform (M13).

## Overview

Gambit implements a dependency-free, zero-overhead observability stack. The ports live in `@chess-platform/api`; structured logging (`JsonLogger`) and Prometheus metrics (`InMemoryMetrics`) are also reused by the deployable `services/gateway`, which constructs them from `@chess-platform/api` (`serve.ts`). Request tracing covers both the API's HTTP router (`http.server` spans) and the gateway service (`gateway.command` and `gateway.forward` spans). All instrumentation adheres to strict PII redaction and bounded cardinality controls.

---

## 1. Structured Logging (`JsonLogger`)

### Format
In production (`bootstrap.ts` and `serve.ts`), the API and Gateway emit single-line JSON records to `stdout`:
```json
{
  "ts": "2026-07-24T10:30:00.000Z",
  "level": "info",
  "msg": "request completed",
  "service": "api",
  "requestId": "018e...",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "method": "GET",
  "path": "/v1/users/:handle",
  "status": 200,
  "durationMs": 12
}
```

### Log Levels
Controlled via `LOG_LEVEL` environment variable (`debug`, `info`, `warn`, `error`; default: `info`).

### Security & PII Rules
- **Never logged**: Access/refresh tokens, passwords, email addresses, `Authorization` headers, cookies, or raw request/response bodies.
- Context loggers carry request metadata (`requestId`, `traceId`, `method`, `path`) created per request via `logger.child()`.

---

## 2. Prometheus Metrics (`/v1/metrics` and `GET /metrics`)

### Endpoint
Metrics are exposed in standard Prometheus text format (`v0.0.4`) at `GET /v1/metrics` on the API and `GET /metrics` on the Gateway.

### Key Metrics
- `http_requests_total` (counter): Count of HTTP requests labeled by `method`, `route` (pattern), and `status`.
- `http_request_duration_seconds` (histogram): Request latency in seconds bucketed across standard intervals (`0.005s` to `10s`), labeled by `route`.
- Gateway counters: `gateway_connections_opened_total`, `gateway_messages_received_total`, `gateway_auth_failures_total`.

### Span Export Pipeline
When OTLP export is enabled, `BatchSpanProcessor` self-instruments by emitting unlabelled Prometheus counters to the metrics registry:
- `span_export_received_total` (counter): Spans accepted into the pipeline.
- `span_export_dropped_total` (counter): Spans dropped due to queue overflow eviction or post-shutdown exports.
- `span_export_exported_total` (counter): Spans handed to the downstream exporter (in batches).
- `span_export_batches_total` (counter): Batches dispatched to the downstream exporter.

### Cardinality Discipline
- **Route Patterns**: HTTP routes are labeled by parameterized pattern (e.g. `/v1/users/:handle`), never concrete values like `/v1/users/alice`.
- **Method Normalization**: on every request path, the HTTP method is normalized to a known verb or `OTHER` before it becomes a metric label or span attribute, so an unrecognized or custom method cannot inflate cardinality.
- **No PII Labels**: Labels never contain user IDs, game IDs, handles, or IP addresses.

---

## 3. Distributed Tracing (`Tracer` & `Span`)

### Trace Context & Propagation
- **Inbound Context**: Inbound `traceparent` headers (`00-<traceId>-<parentId>-<flags>`) are validated and adopted. If absent or invalid, a fresh 128-bit `traceId` is minted.
- **Outbound Context**: Every API response includes both `traceparent` (`00-<traceId>-<spanId>-<flags>`) and legacy `trace-id` headers for downstream propagation.
- **Cross-Node Gateway Context**: Cross-node command forwards carry `traceparent` in the `ForwardedCommand` Redis queue envelope. The owner node parses this header and creates child spans under the forwarder's span.

### Server Request & Command Spans
- **`http.server`**: Each API HTTP request creates an `http.server` span covering the request lifecycle (attributes: `http.method`, `http.route`, `http.status_code`).
- **`gateway.command`**: Each game command processed by the gateway creates a `gateway.command` span (attributes: `cmd.kind`, `cmd.outcome`, `cmd.error_code`).
- **`gateway.forward`**: Cross-node command forwards create a `gateway.forward` span wrapping the Redis list queue RPC (attributes: `forward.outcome`, `forward.timeout`).

### Sampling & Production Storage
- **Sampler**: Default `alwaysOnSampler` (respecting inbound parent sampling decisions when present). Deterministic `probabilitySampler(ratio)` available via `OTEL_TRACES_SAMPLER_ARG`.
- **Production Exporter**: In production, finished spans are emitted as structured `info` log records (`msg: "span"`) via `LoggingSpanExporter`.
- **Introspection/Testing**: `InMemorySpanRecorder` provides a bounded ring-buffer for capturing spans in tests.

### Span Export (`SpanExporter` Seam & OTLP/JSON Exporter)
- **`SpanExporter` Seam**: `SpanExporter` defines `export(spans: readonly SpanData[]): void`. Export is best-effort and non-blocking — implementations contain their own errors and never throw into the request path.
- **Exporters**:
  - `LoggingSpanExporter`: Default. Emits structured `info` log records (`msg: "span"`) with whitelisted attributes (`http.method`, `http.route`, `http.status_code`, `cmd.kind`, `cmd.outcome`, `cmd.error_code`, `forward.outcome`, `forward.timeout`).
  - `OtlpJsonSpanExporter`: Serializes spans into standard OTLP/JSON trace payloads (`OtlpTracesPayload`) with nanosecond BigInt timestamps, mapped enums, and typed attribute values (`stringValue`, `intValue`, `boolValue`, `doubleValue`), sending via an injectable `SpanTransport`.
  - `MultiSpanExporter`: Composite exporter that fans out span batches to multiple child exporters, containing individual exporter failures so one failing transport does not block others.
- **OTLP Endpoint Gate**: Configured via `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used verbatim) or the generic `OTEL_EXPORTER_OTLP_ENDPOINT` (a base URL onto which `/v1/traces` is appended per the OTLP/HTTP spec). When either resolves, production bootstrap in both `api` and `gateway` combines `LoggingSpanExporter` and the (batched) `OtlpJsonSpanExporter` via `MultiSpanExporter`. When neither is set, `LoggingSpanExporter` is used exclusively.
- **Span Processor (`BatchSpanProcessor`)**: OTLP span export is batched by `BatchSpanProcessor` (decorating `OtlpJsonSpanExporter` in production `bootstrap.ts` and `serve.ts`). Defaults to `maxQueueSize = 2048`, `maxExportBatchSize = 512`, and periodic flush delay `scheduledDelayMillis = 5000` via an unref'd `intervalScheduler`. Logging export stays direct and per-span. Queue overflow drops oldest spans and increments `droppedSpans`. `shutdown()` drains remaining queue contents and cancels periodic tasks. The processor is self-instrumented: when `metrics` is provided, it emits unlabelled Prometheus counters (`span_export_received_total`, `span_export_dropped_total`, `span_export_exported_total`, `span_export_batches_total`) for scraping at metrics endpoints.
- **Helm Configuration**: Helm values provide `tracing.enabled`, `tracing.otlpEndpoint`, `tracing.otlpTracesEndpoint`, and `tracing.samplerArg` to render OTEL variables onto API and Gateway Deployments.


