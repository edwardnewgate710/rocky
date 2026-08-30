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

#### Analysis cache (ADR-0138, ADR-0139)

Three *reporters* feed the series below — the engine's orchestration observer, the process-local hot
tier, and the durable adapter's fault hook — and they answer different questions, so none can be
derived from the others. (Three reporters, five metric families: a reporter is who is talking, not
how many series it writes.)

- `analysis_cache_events_total` (counter), labeled `event`: what the **request** did, straight from the
  engine's orchestration events (`cache_hit`, `cache_miss`, `request_coalesced`,
  `engine_computation_started`, `cancellation`, and the rest).
- `analysis_cache_lookup_seconds` (histogram), labeled `outcome` (`hit`, `miss`, `read_failure`):
  lookup latency.
- `analysis_cache_hot_total` (counter), labeled `outcome` (`hit`, `miss`, `durable_hit`, `expired`,
  `evicted`): which **tier** answered, and why an entry left memory. `expired` means "left because
  its deadline had passed", counted wherever that happens — a read that finds it dead, an eviction
  that gives it up first, or a write that replaces it — while `evicted` is reserved for a *live*
  entry given up to make room. That is what keeps the two a clean split between TTL pressure and
  capacity pressure.
- `analysis_cache_faults_total` (counter), labeled `fault` (`read`, `write`, `payload`, `retention`):
  whether the **database** misbehaved.
- `analysis_cache_retention_deleted_total` (counter): rows removed by the retention sweep.

**`cache_hit` no longer means "PostgreSQL answered".** Since ADR-0139 a process-local hot tier sits in
front of the durable cache behind the same port, so the orchestrator — which holds one cache and
cannot see inside it — records `cache_hit` whether the answer came from this process's memory or from
a round trip. `analysis_cache_hot_total` is what separates them, and its five outcomes are two different kinds of
signal rather than one breakdown.

`hit`, `miss` and `durable_hit` describe **lookups**. Exactly one of `hit` or `miss` is recorded per
lookup, so `hit + miss` is the lookup count and `hit / (hit + miss)` is the hot tier's own hit rate;
`durable_hit` refines `miss` rather than adding to it, being the share of misses PostgreSQL answered.

`expired` and `evicted` describe **entries leaving memory**, and are not part of that decomposition —
they are recorded on writes and evictions as well as on reads, so they neither sum to the lookup
count nor sit inside `miss`. Read them against each other, not against the lookup series: `expired`
rising means entries are ageing out at the sixty-second deadline, `evicted` rising means capacity
pressure against `ANALYSIS_CACHE_ENTRIES`, and those call for different responses.

The bridge back to the orchestrator's own counters is exact, but it is not one-to-one, because
`readCache` has two early returns that record neither `cache_hit` nor `cache_miss`:

```text
hit + durable_hit  ==  cache_hit  + cache_result_rejected
miss - durable_hit ==  cache_miss + cache_read_failure
```

Both correction terms are normally zero — a rejected payload means a tier returned something
unusable, and a read failure means the cache threw rather than missing — so a persistent gap between
the two sides is itself the signal that one of those is happening.

A read that times out is absorbed too, so its latency lands in `analysis_cache_lookup_seconds{outcome="miss"}` and the `read_failure` series stays empty for a Postgres-backed cache. Miss latency percentiles therefore include absorbed database timeouts; `analysis_cache_faults_total{fault="read"}` is what says how many.

**Do not infer cache health from the event counters alone.** The Postgres adapter absorbs every fault
and returns normally, so a failed read is recorded as `cache_miss` and — the sharp case — a failed
write is recorded as `cache_write_completed`, because `set` resolved. During a total database outage
the event counters describe a healthy cache with a poor hit rate. `analysis_cache_faults_total` is the
only series that distinguishes a cold cache from a broken one.

Every label above is a closed enum from a union type in the engine or the persistence adapter, so the
series count is fixed at build time. The signals carry no FEN, cache key, game, user or request id —
those fields do not exist on them.

### Span Export Pipeline
When OTLP export is enabled, `BatchSpanProcessor` self-instruments by emitting unlabelled Prometheus counters to the metrics registry:
- `span_export_received_total` (counter): Spans accepted into the pipeline.
- `span_export_dropped_total` (counter): Spans dropped due to queue overflow eviction or post-shutdown exports.
- `span_export_exported_total` (counter): Spans confirmed successfully exported to the collector (incremented on delivery receipt).
- `span_export_failed_total` (counter): Spans whose final export attempt failed (unlabelled, ADR-0063).
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
- **`SpanExporter` Seam**: `SpanExporter` defines `export(spans: readonly SpanData[]): void`. Export is best-effort and non-blocking — implementations contain their own errors and never throw into the request path. `SpanTransport.send` returns `Promise<SpanExportOutcome>` (`ok: true` or `ok: false, retryable, reason`) without blocking callers.
- **Exporters**:
  - `LoggingSpanExporter`: Default. Emits structured `info` log records (`msg: "span"`) with whitelisted attributes (`http.method`, `http.route`, `http.status_code`, `cmd.kind`, `cmd.outcome`, `cmd.error_code`, `forward.outcome`, `forward.timeout`).
  - `OtlpJsonSpanExporter`: Serializes spans into standard OTLP/JSON trace payloads (`OtlpTracesPayload`) with nanosecond BigInt timestamps, mapped enums, and typed attribute values (`stringValue`, `intValue`, `boolValue`, `doubleValue`), sending via an injectable `SpanTransport`. Implements `OutcomeReportingSpanExporter`, so `exportWithOutcome(spans)` returns the delivery outcome as a promise — the promise is what correlates a result with the batch that produced it, since several batches are in flight whenever a flush drains a full queue.
  - `MultiSpanExporter`: Composite exporter that fans out span batches to multiple child exporters, containing individual exporter failures so one failing transport does not block others.
- **OTLP Endpoint Gate**: Configured via `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used verbatim) or the generic `OTEL_EXPORTER_OTLP_ENDPOINT` (a base URL onto which `/v1/traces` is appended per the OTLP/HTTP spec). When either resolves, production bootstrap in both `api` and `gateway` combines `LoggingSpanExporter` and the (batched) `OtlpJsonSpanExporter` via `MultiSpanExporter`. When neither is set, `LoggingSpanExporter` is used exclusively.
- **Span Processor (`BatchSpanProcessor`)**: OTLP span export is batched by `BatchSpanProcessor` (decorating `OtlpJsonSpanExporter` in production `bootstrap.ts` and `serve.ts`). Defaults to `maxQueueSize = 2048`, `maxExportBatchSize = 512`, periodic flush delay `scheduledDelayMillis = 5000` via an unref'd `intervalScheduler`, and `maxExportRetries = 3`. Retryable failures (network errors, HTTP 408/429/5xx) are retried up to 3 times through the `Scheduler` seam while respecting `maxQueueSize`. Non-retryable 4xx errors fail immediately. Logging export stays direct and per-span. Queue overflow drops oldest spans (from retrying batches or fresh queue) and increments `droppedSpans`. `shutdown()` cancels pending retries, marks unsent retries as failed, drains remaining queue contents, and finishes synchronously without hanging. The processor emits unlabelled Prometheus counters (`span_export_received_total`, `span_export_dropped_total`, `span_export_exported_total`, `span_export_failed_total`, `span_export_batches_total`) at metrics endpoints.
- **Helm Configuration**: Helm values provide `tracing.enabled`, `tracing.otlpEndpoint`, `tracing.otlpTracesEndpoint`, and `tracing.samplerArg` to render OTEL variables onto API and Gateway Deployments.



---

## SLOs, alerting, dashboards (M13 inc 8, ADR-0064)

The consuming half of the observability stack. Signals without something watching them are the same
operational position as no instrumentation, only more expensive.

| Artefact | Location |
|---|---|
| SLO definitions and reasoning | `docs/SLO.md` |
| Recording rules + alerts | `deploy/observability/prometheus/rules/gambit.rules.yml` |
| Grafana dashboards | `deploy/observability/grafana/dashboards/*.json` |
| Runbook per alert | `docs/RUNBOOKS.md` |
| Drift guard | `scripts/check-observability-drift.mjs` (`npm run check:observability`) |

### Scraping — read this before configuring Prometheus

**`/v1/metrics` is blocked at the public web proxy** (SEC-1, `docs/SECURITY_AUDIT.md`). Prometheus
must scrape the API **Service** directly inside the cluster; scraping through the Ingress hostname
returns 404 by design. The gateway exposes its own registry on `GET /metrics` on the health port
(`PORT + 1`), which is not proxied publicly at all.

### Loading the configuration

```bash
# Alert + recording rules — validate first, then mount into your Prometheus.
# Pinned deliberately: CI runs the same command, and a floating tag would let a guardrail
# change behaviour with no commit to explain it.
docker run --rm -v "$PWD/deploy/observability:/o:ro" \
  --entrypoint promtool prom/prometheus:v3.13.2 check rules /o/prometheus/rules/gambit.rules.yml

# Dashboards: import the JSON, or point Grafana provisioning at the directory.
```

Both files are plain configuration; no Prometheus or Grafana is bundled in the Helm chart, so an
operator loads them into an existing stack.

### One selector you must adjust

`GambitTargetDown` is scoped to `up{job=~"gambit.*"}`, because a bare `up == 0` fires for every
target in the Prometheus that loads this file — including ones unrelated to Gambit — and then points
the responder at a Gambit-specific runbook.

**If your scrape jobs are not named `gambit-…`, change that matcher** to whatever label your scrape
config applies. A selector that matches nothing means the alert never fires, which is worse than a
noisy one.

### A note on aggregation

Gateway counters are emitted per process and the chart ships `gateway.replicas: 2`, so Prometheus
sees one series per pod. Service-wide conditions are therefore summed —
`GambitGatewayAuthFailureSpike` uses `sum(rate(...))`, since two replicas each below a per-series
threshold can exceed it together and never alert. `GambitSpanQueueOverflowing` is deliberately *not*
summed: any single replica dropping spans is worth knowing, and summing would let one sick pod hide
behind healthy ones.

### Why the drift guard exists

Alerts and dashboards fail silently. Rename a metric and the alert stops matching anything — it does
not error, it just never fires again, and nobody finds out until the incident it was supposed to
catch. Nothing else in the test suite covers this, because the rules are YAML and the metrics are
TypeScript and neither imports the other.

`npm run check:observability` cross-checks every metric referenced in `deploy/observability/**`
against the names the source actually emits, and fails the build on a reference nothing satisfies.
It runs in CI in the `helm` job.
