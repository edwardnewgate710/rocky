# 45. Distributed Tracing, Span Emission, and Context Propagation

Date: 2026-07-24

## Status

Accepted

## Context

M13 Observability Increment 1 (ADR-0028) introduced `Logger` (`JsonLogger`/`NullLogger`), `Metrics` (`InMemoryMetrics`/`NullMetrics`), and W3C `traceparent` parsing in `@chess-platform/api`. It adopted or minted request trace-ids and propagated them to logs and response headers, but span creation, sampling, and outbound `traceparent` header formatting were explicitly out of scope.

This increment closes that gap by introducing a lightweight, dependency-free `Tracer`/`Span` port, in-process sampling, server request span emission (`http.server`), and proper outbound W3C `traceparent` propagation.

## Decision

1. **Dependency-free `Tracer` / `Span` Port in `@chess-platform/api`.**
   - No `@opentelemetry/*` SDK or native C++ dependencies are added. The tracing ports and adapters reside in `@chess-platform/api` (a service package), leaving domain packages dependency-free.
   - Core interfaces: `SpanKind` (`server` | `client` | `internal`), `SpanStatus` (`unset` | `ok` | `error`), `SpanAttributeValue` (`string` | `number` | `boolean`), `SpanAttributes`, `Span`, `SpanData`, `StartSpanOptions`, `Tracer`, and `SpanSink`.
   - `NullTracer` returns a no-op span (`spanId` = `'0000000000000000'`) with zero allocations and no-op mutation/ending.
   - `RecordingTracer` evaluates a sampler on `startSpan`. If sampled, it allocates a recording span, assigns a 16-hex `spanId` (via `generateSpanId`), tracks attributes and status, and on idempotent `end()` computes `durationMs` and calls `sink(spanData)` exactly once.
   - `InMemorySpanRecorder` provides a bounded ring-buffer sink (default capacity 1000, oldest dropped on overflow) for testing and introspection.

2. **Sampling Seam.**
   - `alwaysOnSampler`: returns `true` unless `parentSampled` is defined (in which case it honors the parent decision).
   - `probabilitySampler(ratio)`: deterministic sampling based on `traceId`. It derives an integer from the first 8 hex characters of `traceId` (`parseInt(traceId.slice(0, 8), 16) / 0xffffffff`), clamped to `[0, 1]`. If `parentSampled` is defined (from inbound W3C `flags`), the parent decision strictly overrides the ratio.

3. **Server Request Span Lifecycle & Propagation in `Router`.**
   - Each HTTP request creates an `http.server` span with `traceId`, `parentId` (from inbound `traceparent`), `kind = 'server'`, and initial attribute `http.route = route.path` (or `resolvedRoutePath` on early failure).
   - Outbound trace propagation adds a W3C `traceparent` header `00-<traceId>-<spanId>-<flags>` alongside the legacy `trace-id` header.
   - The propagated sampled flag (`outboundSampled`) defaults to `inboundSampled ?? true` to align outbound context propagation with the always-on production sampling default.
   - On completion (success, handled `HttpError`, or internal 500), the router sets `http.status_code`, sets span status to `'error'` for status >= 500 and `'ok'` for status < 500, and calls `span.end()`.

4. **Production Default: Spans to Structured Logs.**
   - Production `bootstrap.ts` injects a `RecordingTracer` whose sink emits finished spans through the `JsonLogger` (`logger.info('span', ...)`).
   - A local `pickBoundedAttrs` whitelist strictly filters attributes to bounded fields (`http.method`, `http.route`, `http.status_code`), guaranteeing that PII (userId, handle, token, IP) never enters span logs or attributes.

5. **Deferred Work.**
   - OTLP / OpenTelemetry collector exporter and cross-service context propagation between `realtime-gateway` and `api` remain deferred to later increments.

## Consequences

- Server requests generate clean, correlated `http.server` spans recorded to structured JSON logs in production, enabling span duration and status visibility without external collector infrastructure.
- Outbound responses include spec-compliant `traceparent` headers for downstream clients.
- `NullTracer` keeps non-production or unconfigured callers zero-overhead.
- Strict attribute whitelisting ensures PII and unbounded cardinality are prevented by construction.
