# 28. Observability foundation (logging, metrics, trace correlation)

Date: 2026-07-22

## Status

Accepted

## Context

The platform is deployable (M14: Compose + Helm) but was operationally blind:
`console.log` strings, no metrics, no request/trace correlation, and shallow
readiness. You cannot run an alpha you cannot observe.

## Decision

**Ports & adapters, in `@chess-platform/api`; domain packages stay dependency-free.**

1. **No third-party runtime dependencies.** Consistent with the repo ethos
   (scrypt over argon2, hand-rolled CBOR), we implement the minimal formats
   ourselves rather than pulling OpenTelemetry / pino / prom-client:
   - **`Logger`** (`JsonLogger` / `NullLogger`): one JSON object per line to
     stdout — `ts, level, msg` plus merged bindings. `child(bindings)` returns a
     logger carrying `{ requestId, traceId, method, path }` on every record.
   - **`Metrics`** (`InMemoryMetrics` / `NullMetrics`): counters + histograms
     with a `render()` that emits valid Prometheus text exposition
     (`# HELP`/`# TYPE`, `_bucket`/`_sum`/`_count`). The registry is itself the
     scrape target.
   - **Trace correlation**: hand-rolled W3C `traceparent` parse
     (`version-traceid-spanid-flags`, strict hex/length, all-zero rejected). An
     inbound valid trace-id is adopted; otherwise a fresh 128-bit id is minted.
     **Span export and sampling are out of scope** for this increment — ids are
     propagated (and echoed on the `trace-id` response header), not exported.

2. **Wiring.** The API composition root shares ONE `InMemoryMetrics` instance
   between the per-request recorder (router runtime) and the `GET /v1/metrics`
   render route. `bootstrap.ts` injects a `JsonLogger` (level via `LOG_LEVEL`)
   in production; tests default to `NullLogger`. The gateway swaps its
   `console.*` calls for `JsonLogger` and exposes `/metrics` on the health port.

3. **PII & cardinality rules (enforced, not just documented).**
   - **Never logged**: access/refresh tokens, passwords, emails, `Authorization`
     headers, cookies, or raw request/response bodies. The request logger records
     only `{ status, durationMs, code, err.message|stack }`.
   - **Metric labels are bounded**: HTTP metrics use the route **pattern**
     (`/v1/users/:handle`), never the raw path, and the client-controlled
     `req.method` is normalized to a known verb or `OTHER` on the failure path.
     Never label by userId, gameId, handle, or IP.

4. **Readiness** (`/v1/ready`, gateway `/ready`) runs the injected dependency
   check (Postgres, and Redis on the gateway) and returns 503 on failure;
   `/health` stays a pure liveness 200.

## Consequences

- The deployed stack emits structured logs correlated by request/trace id and a
  Prometheus scrape endpoint per service, with readiness that reflects real
  dependency health — enough to operate an alpha.
- `InMemoryMetrics` is per-process; multi-process aggregation (a push gateway or
  a shared store) and real distributed-trace export are later increments.
- Gateway auth failures are counted by wrapping the `TokenVerifier` at the
  composition root (a null verify result on a supplied token), so no hook was
  added to the dependency-free `realtime-gateway` domain package.
