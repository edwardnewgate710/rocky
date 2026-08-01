# 62. Realtime Gateway Tracing and Reachable OTLP Export

Date: 2026-08-01

## Status

Accepted

## Context

M13 increments 2–5 built a complete distributed tracing stack (`Tracer`/`Span` port in ADR-0045, `SpanExporter` + OTLP/JSON in ADR-0046, `BatchSpanProcessor` in ADR-0047, and API self-instrumentation in ADR-0048). However, two critical gaps remained:

1. **`services/gateway` emitted no traces at all.** The gateway service hosts all WebSocket client connections and processes every game command and cross-node forward. Despite having `JsonLogger` and `InMemoryMetrics`, it was dark to tracing.
2. **OTLP configuration was unreachable from the Helm chart.** Helm manifests (`deploy/helm/gambit/`) had no parameters or environment variables for `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, making it impossible to enable OpenTelemetry export in Kubernetes deployments for either the API or gateway. This defect follows the lineage of ADR-0057 (search indexer deployment reachability) and ADR-0060 (semantic search reachability).

## Decision

1. **Gateway Tracer Wiring in `services/gateway/src/serve.ts`.**
   - Initialize `RecordingTracer` mirroring `packages/api/src/bootstrap.ts`.
   - Set service name to `realtime-gateway` (matching `JsonLogger`).
   - If OTLP endpoints (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`) are set, export via `MultiSpanExporter` combining `LoggingSpanExporter` and `BatchSpanProcessor(OtlpJsonSpanExporter)`.
   - Wire `BatchSpanProcessor` to the existing `metrics` registry so span export counters appear at `GET /metrics`.
   - Configure sampling via `OTEL_TRACES_SAMPLER_ARG` using `probabilitySampler`, defaulting to `alwaysOnSampler`.
   - Log export target at startup (`traces export: OTLP (...)` vs `traces export: log-only`).

2. **Targeted Spans for Critical Gateway Work.**
   - Emit `gateway.command` spans around game commands (`move`, `resign`, `offerDraw`, `acceptDraw`, `declineDraw`, `claimFlag`, `abort`).
   - Emit `gateway.forward` spans around cross-node command forwarding in `command-forwarder.ts`.
   - Do NOT emit spans for health (`/health`), metrics (`/metrics`), or readiness (`/ready`) endpoints.
   - Do NOT emit spans for raw WebSocket frames or connection keep-alives.

3. **Strict Bounded-Attribute & PII Discipline.**
   - `gateway.command` spans carry bounded attributes only: `'cmd.kind'` (command type), `'cmd.outcome'` (`'ok'` | `'error'`), and `'cmd.error_code'` on failure.
   - `gateway.forward` spans carry `'forward.outcome'` (`'ok'` | `'error'`) and `'forward.timeout'` (`true` | `false`).
   - `BOUNDED_SPAN_ATTRS` in `@chess-platform/api` is updated to whitelist these keys for structured log export.
   - `gameId`, `userId`, move payload (UCI), tokens, and credentials are NEVER added to span attributes.

4. **Cross-Node Distributed Trace Context Propagation.**
   - Add optional `traceparent?: string` field to `ForwardedCommand` wire format.
   - Forwarding node formats the active span context using `formatTraceparent` and attaches it to the Redis queue payload.
   - Owning node parses `traceparent` using `parseTraceparent` and makes its `gateway.command` span a child of the forwarder's span.
   - Wire compatibility guarantee: if `traceparent` is missing or malformed, the receiving node starts a root span with a fresh trace id and never throws.

5. **Helm Chart Reachability.**
   - Add a `tracing` block to `deploy/helm/gambit/values.yaml` (defaulting to `enabled: false`).
   - Render `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, and `OTEL_TRACES_SAMPLER_ARG` onto both API and Gateway `Deployment` manifests when `tracing.enabled=true`.
   - Render nothing when `tracing.enabled=false`.
   - Fail chart rendering via `fail` if `tracing.enabled=true` with neither OTLP endpoint configured.
   - Guard invariants with 50 automated snapshot assertions in `scripts/helm-snapshot-test.sh`.

### Sampler resolution is shared, and validated

`OTEL_TRACES_SAMPLER_ARG` is parsed by `resolveTracesSampler` in
`packages/api/src/ports/tracer.ts`, used by **both** `bootstrap.ts` and the gateway.

Validation cannot live inside `probabilitySampler`: it clamps with `Math.max`/`Math.min`, and both
propagate `NaN`. An unvalidated `Number("abc")` therefore produces a sampler whose every comparison
is false — tracing silently switched off across a deployment with no error anywhere. Invalid input
now yields always-on sampling plus a warning the caller logs.

A first cut of this increment rendered `OTEL_TRACES_SAMPLER_ARG` onto the API Deployment while
`bootstrap.ts` ignored it entirely — reintroducing, inside the very increment meant to fix it, the
"documented, deployable, silently ignored" defect of ADR-0057. The API now honours it.

### The batch processor is drained on shutdown

The gateway holds its `BatchSpanProcessor` in a variable so the shutdown handler can call
`shutdown()` before `process.exit(0)`. That call cancels the periodic flush and force-flushes the
queue; without it the exit discards whatever is queued and aborts any OTLP request in flight —
losing precisely the spans describing what the pod was doing as it went down.

## Consequences

- The realtime gateway is fully observable via distributed traces.
- Forwarded commands form unified distributed trace trees across nodes (`gateway.command` [edge] → `gateway.forward` [edge] → `gateway.command` [owner]).
- Operators can enable OTLP tracing in Kubernetes via Helm values (`tracing.enabled=true`, `tracing.otlpEndpoint=...`).
- PII and unbounded attribute cardinallity remain strictly protected.
- Zero breaking changes to wire protocol or un-instrumented default behavior.
