# Gambit Observability Guide

This guide describes the operational observability capabilities implemented across the Gambit platform (M13).

## Overview

Gambit implements a dependency-free, zero-overhead observability stack. The ports live in `@chess-platform/api`; structured logging (`JsonLogger`) and Prometheus metrics (`InMemoryMetrics`) are also reused by the deployable `services/gateway`, which constructs them from `@chess-platform/api` (`serve.ts`). Request tracing (server spans) is currently wired into the API's HTTP router only; the gateway emits structured logs and metrics but not spans yet. All instrumentation adheres to strict PII redaction and bounded cardinality controls.

---

## 1. Structured Logging (`JsonLogger`)

### Format
In production (`bootstrap.ts`), the API and Gateway emit single-line JSON records to `stdout`:
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

## 2. Prometheus Metrics (`/v1/metrics`)

### Endpoint
Metrics are exposed in standard Prometheus text format (`v0.0.4`) at `GET /v1/metrics`.

### Key Metrics
- `http_requests_total` (counter): Count of HTTP requests labeled by `method`, `route` (pattern), and `status`.
- `http_request_duration_seconds` (histogram): Request latency in seconds bucketed across standard intervals (`0.005s` to `10s`), labeled by `route`.

### Cardinality Discipline
- **Route Patterns**: HTTP routes are labeled by parameterized pattern (e.g. `/v1/users/:handle`), never concrete values like `/v1/users/alice`.
- **Method Normalization**: on every request path, the HTTP method is normalized to a known verb or `OTHER` before it becomes a metric label or span attribute, so an unrecognized or custom method cannot inflate cardinality.
- **No PII Labels**: Labels never contain user IDs, game IDs, handles, or IP addresses.

---

## 3. Distributed Tracing (`Tracer` & `Span`)

### Trace Context & Propagation
- **Inbound Context**: Inbound `traceparent` headers (`00-<traceId>-<parentId>-<flags>`) are validated and adopted. If absent or invalid, a fresh 128-bit `traceId` is minted.
- **Outbound Context**: Every API response includes both `traceparent` (`00-<traceId>-<spanId>-<flags>`) and legacy `trace-id` headers for downstream propagation.

### Server Request Spans (`http.server`)
- Each HTTP request creates an `http.server` span covering the request lifecycle.
- **Attributes**: Bounded attributes only (`http.method`, `http.route`, `http.status_code`).
- **Span Status**: Set to `'error'` for status >= 500, `'ok'` for status < 500.

### Sampling & Production Storage
- **Sampler**: Default `alwaysOnSampler` (respecting inbound parent sampling decisions when present). Deterministic `probabilitySampler(ratio)` available.
- **Production Exporter**: In production, finished spans are emitted as structured `info` log records (`msg: "span"`) via `JsonLogger`.
- **Introspection/Testing**: `InMemorySpanRecorder` provides a bounded ring-buffer for capturing spans in tests.
