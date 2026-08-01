# ADR-0064 — SLOs, burn-rate alerting, dashboards, and a drift guard

| Field      | Value                                          |
|------------|------------------------------------------------|
| **Status** | Accepted                                       |
| **Date**   | 2026-08-01                                     |
| **Scope**  | `deploy/observability`, `docs`, `scripts`, CI  |

---

## Context

M13 increments 1–7 built the signals: structured logs, a Prometheus registry, distributed tracing,
OTLP export, and — after ADR-0063 — export counters that mean what they say. **Nothing looked at any
of it.** An incident was invisible until a user complained, which is the same operational position
as having no instrumentation at all, only more expensive.

This increment closes M13 by adding the consuming half: objectives, alerts, dashboards, runbooks,
and a guard that stops all of it rotting.

## Decision

### 1. Three SLOs, bounded by what is actually emitted

API availability (99.5%), API latency (99% under 250 ms), and span-export delivery (99%). Full
definitions and reasoning in `docs/SLO.md`.

The platform emits ten series, and that bounds what an SLO can honestly claim. In particular **there
is no gateway latency or gateway error metric** — the WebSocket path has connection, message and
auth-failure counters only. A "realtime responsiveness" SLO would therefore have to be invented
rather than measured, so it is not defined. Adding one would mean shipping a number with no data
behind it.

### 2. Latency thresholds sit on histogram bucket edges

`http_request_duration_seconds` has fixed buckets: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1,
2.5, 5, 10`. `histogram_quantile` interpolates *within* a bucket, so a threshold at, say, 300 ms
returns an estimate that presents as a measurement.

250 ms is a real edge. It is also the honest choice among the available edges: 100 ms is aggressive
for a request making a Postgres round trip, and 500 ms is slow enough for a user to notice.

The SLI is expressed as a threshold ratio (`..._bucket{le="0.25"} / ..._count`) rather than a
percentile, because that is directly countable from the bucket counters and does not move when the
traffic mix shifts between buckets.

### 3. Multi-window, multi-burn-rate alerts

Each alert pairs a long window — is the budget genuinely burning? — with a short one — is it still
burning *now*? Without the short window an alert keeps paging for hours after the incident is over.
Without the long one a thirty-second blip wakes someone.

| Burn | Windows | Severity |
|---|---|---|
| 14.4x | 1h + 5m | page |
| 6x | 6h + 30m | page |
| 3x | 1d + 2h | ticket |

Thresholds are `burn x (1 - target)`, so they follow from the SLO rather than being tuned by feel.

**4xx never counts against availability.** A 422 from a malformed body or a 401 from a wrong password
is the client erring; counting it would let a credential-stuffing attack "consume" availability the
service never lost.

**No traffic means no alert.** With a zero denominator the ratio is NaN and the series does not
exist. An idle service has no measured availability, and manufacturing one produces only noise.

### 4. Recording rules as the single definition

Every SLI is a recording rule. Dashboards and alerts reference those rules instead of re-deriving
PromQL, so a panel and the alert beside it cannot disagree — the same reasoning that put
`search-helpers.ts` between the two Postgres search adapters.

### 5. `scripts/check-observability-drift.mjs` — the piece that matters most

Dashboards and alerts fail *silently*. Rename a counter and the alert stops matching anything; it
does not error, it simply never fires again, and nobody finds out until the incident it was meant to
catch. No existing test covers this, because the rules are YAML and the metrics are TypeScript and
neither imports the other.

The script discovers emitted metrics from `.counter(...)`/`.histogram(...)` calls in the source,
extracts every metric referenced across `deploy/observability/**`, and exits non-zero on any
reference the code cannot satisfy. Metrics that exist but nothing observes are reported as
information rather than treated as errors — an unused metric is a hint, not a defect. It uses only
Node built-ins; this repo has no dependency for such things and must not gain one.

It runs in CI in the `helm` job, which needs no services and already hosts
`scripts/helm-snapshot-test.sh`.

**Two extraction bugs found while building it, both worth recording** because they are the failure
mode of "looks right, therefore is right":

- A greedy `(\s{2,}.*\n?)+` capture for YAML block scalars swallowed the following `labels:` and
  `annotations:` blocks, so prose from an alert description was parsed as PromQL. Block scalars are
  now delimited by indentation relative to the `expr:` key.
- A negative lookahead used to reject function calls let the regex engine backtrack to a shorter
  identifier: `sum(` matched as `su`, because `m` is not `(`. The check now matches whole
  identifiers and inspects the following character separately.

The checker was verified by **making it fail**: renaming `gateway_auth_failures_total` to
`gateway_auth_failure_total` in the rules produced exit 1 naming both the metric and the file. A
checker that has only ever passed has not been tested.

### 6. Rules validated with the real `promtool`

`docker run --rm --entrypoint promtool prom/prometheus:latest check rules ...` — `SUCCESS: 21 rules
found`. Also wired into CI, so a syntactically broken rule file cannot merge.

## Consequences

- M13 is complete: signals, and something that consumes them.
- Every alert links to a runbook naming specific queries and commands; `docs/RUNBOOKS.md` has an
  entry per alert and all nine anchors were verified to resolve.
- Prometheus must scrape the API Service **directly in-cluster** — SEC-1 blocks `/v1/metrics` at the
  public proxy. Documented in the rules file, `docs/OBSERVABILITY.md` and the runbooks.
- **The SLO targets are unvalidated.** Gambit has never carried production traffic and has never been
  load tested; M14's 100k-user validation is still deferred. These are considered starting points so
  the alerting has something to fire on, and `docs/SLO.md` says so at the top rather than in a
  footnote. They must be revised against real data.
- No Prometheus or Grafana is bundled in the Helm chart, so these are configuration files an operator
  loads into an existing stack. Packaging them as chart resources is deferred until there is a
  deployment that wants it.
