# Gambit — Service Level Objectives

> **Status: targets set by judgement, then checked against a single-machine baseline.**
>
> These numbers began as considered guesses, chosen so the alerting had something to fire on. ADR-0065
> added `deploy/load` and they have now been measured against a real `docker compose` stack — see
> **Measured baseline** below. They held, comfortably.
>
> That is a floor, not a capacity figure. Gambit still has not carried production traffic, and M14's
> 100k-user validation is still deferred. What the baseline rules out is targets that were never
> achievable; what it cannot tell you is how the service behaves at real scale, on real data, under
> real concurrency.

Defined in `deploy/observability/prometheus/rules/gambit.rules.yml`; see ADR-0064 for the reasoning
and `docs/RUNBOOKS.md` for what to do when one burns.

---

## What can actually be measured

The platform emits ten series, and that bounds what an SLO can honestly say:

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status` |
| `http_request_duration_seconds` | histogram | `route` |
| `gateway_connections_opened_total` | counter | — |
| `gateway_messages_received_total` | counter | — |
| `gateway_auth_failures_total` | counter | — |
| `span_export_{received,exported,failed,dropped,batches}_total` | counters | — |

`scripts/check-observability-drift.mjs` fails CI if any rule or dashboard references something
outside this set.

Two consequences worth stating plainly:

- **There is no gateway latency or gateway error metric.** The WebSocket path has connection,
  message and auth-failure counters only. A "realtime responsiveness" SLO cannot be defined today,
  and pretending otherwise would mean inventing an SLI with no data behind it.
- **`http_request_duration_seconds` has fixed buckets:** `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5,
  1, 2.5, 5, 10` seconds. A latency threshold that is *not* one of these edges forces
  `histogram_quantile` to interpolate inside a bucket, producing an estimate that reads like a
  measurement. Every threshold below sits on a real edge.

---

## SLO 1 — API availability

**SLI** — the proportion of API requests not answered with a 5xx.

```promql
1 - (sum(rate(http_requests_total{status=~"5.."}[30d])) / sum(rate(http_requests_total[30d])))
```

| | |
|---|---|
| **Target** | 99.5% |
| **Window** | 30 days, rolling |
| **Error budget** | 0.5% of requests — about 3.6 hours of total failure per 30 days |

**4xx is deliberately excluded.** A 422 from a malformed request or a 401 from a bad password is the
client getting it wrong; counting those against the service would mean a credential-stuffing attack
"consumes" availability the service never lost.

**Why 99.5% and not 99.9%** — 99.9% is a single-service default that assumes redundancy this
deployment does not yet have: one Postgres instance, no multi-region, no automated rollback (M14
blue/green is deferred). Committing to three nines on that topology would be a number chosen for how
it sounds.

---

## SLO 2 — API latency

**SLI** — the proportion of API requests completed within 250 ms.

```promql
sum(rate(http_request_duration_seconds_bucket{le="0.25"}[30d]))
/
sum(rate(http_request_duration_seconds_count[30d]))
```

| | |
|---|---|
| **Target** | 99% under 250 ms |
| **Window** | 30 days, rolling |
| **Error budget** | 1% of requests may exceed 250 ms |

**Why 250 ms** — it is an actual bucket edge, so the ratio is exact rather than interpolated. The
next edge down is 100 ms, which is aggressive for a request that makes a Postgres round trip; the
next up is 500 ms, which is slow enough that a user notices. 250 ms is the honest choice among the
edges available, not a round number picked first and justified after.

This is a *threshold* SLI rather than a percentile SLI on purpose: "99% of requests under 250 ms" is
directly countable from bucket counters, whereas "p99 under X" requires interpolation and moves
whenever the traffic mix shifts between buckets.

---

## SLO 3 — Span export delivery

**SLI** — the proportion of spans accepted by the processor that were confirmed delivered.

```promql
sum(rate(span_export_exported_total[30d]))
/
(
  sum(rate(span_export_exported_total[30d]))
  + sum(rate(span_export_failed_total[30d]))
  + sum(rate(span_export_dropped_total[30d]))
)
```

| | |
|---|---|
| **Target** | 99% |
| **Window** | 30 days, rolling |
| **Error budget** | 1% of spans may be lost |

This is the observability pipeline's own health, and it is only measurable because of ADR-0063:
before that increment `span_export_exported_total` counted *attempts*, and no failure counter
existed at all, so a collector rejecting every payload was indistinguishable from a healthy one.

The target is deliberately looser than the user-facing SLOs. Losing 1% of traces degrades diagnosis;
losing 1% of requests degrades the product.

---

## Measured baseline

Run `node scripts/load-test.mjs` against a `docker compose` stack. The k6 thresholds in
`deploy/load/scenarios/api-baseline.js` *are* the targets above, so the run fails if a target is
unachievable.

**Conditions — read these before quoting the numbers.** One Windows workstation under Docker
Desktop; a single API replica, single Postgres, near-empty dataset; 20 concurrent read users plus 3
registration users for 30 seconds; and the load generator running on the same host as the service,
so the two compete for CPU.

All latency figures below are the **read path only** (`http_req_duration{scenario:read}`) — the
series the SLO threshold enforces. The aggregate would blend in the scrypt-bound registration path,
which is the very thing splitting the scenarios was meant to prevent.

| | Measured | Target | |
|---|---|---|---|
| Availability | **100.000%** (0 of 50,800 requests 5xx) | 99.5% | ✅ |
| Read latency p99 | **98.9 ms** | 99% under 250 ms | ✅ |
| Read latency p95 | 66.4 ms | — | |
| Read latency max | 476.1 ms | — | a small tail exceeds the target; the SLO is stated at p99, not max |
| Throughput | 1,582 req/s sustained | — | |

The targets are therefore achievable, and conservative on this hardware. They are deliberately not
being tightened: a target tuned to an empty database on a developer laptop would be a promise about
the wrong system.

**The max is noisy and should not be read as a capacity signal.** An earlier run of the same
scenario recorded 213 ms; this one, with the web container also running and competing for CPU on the
same host, recorded 476 ms. That spread is the measurement environment, not the service — which is
exactly why the objective is stated at p99 rather than at the worst observed request.

### What the baseline cannot tell you

- **Registration throughput and scrypt cost are unmeasured.** `/v1/auth/register` allows 5 requests
  per IP per hour (ADR-0013), and all load originates from one container, so after five successes
  every request is a 429. That scenario verifies the limiter sheds load with a 429 rather than a
  5xx — worth knowing, but not a latency measurement. Measuring it properly needs distributed load
  generation.
- **The dataset is nearly empty.** `/v1/search` in particular is measured against almost no rows.
  ADR-0059 recorded that the `id` tie-break defeats the HNSW index, so semantic search is a
  sequential scan whose latency grows with corpus size — this baseline says nothing about that.
- **No WebSocket load.** The gateway path is not exercised at all.

## Burn-rate alerting

Alerts fire on how fast the budget is being consumed, not on a raw error rate, and each pairs a long
window (is the budget genuinely burning?) with a short one (is it still burning *now*?). Without the
short window an alert keeps paging for hours after the incident ends; without the long one a
thirty-second blip wakes someone.

| Burn rate | Meaning | Windows | Severity |
|---|---|---|---|
| 14.4x | 2% of the 30-day budget per hour | 1h + 5m | page |
| 6x | 5% per 6 hours | 6h + 30m | page |
| 3x | 10% per day | 1d + 2h | ticket |

Thresholds are `burn_rate x (1 - target)`. For 99.5% availability: 14.4 x 0.005 = 7.2%.
For 99% latency: 14.4 x 0.01 = 14.4%.

**When there is no traffic the SLI is undefined** — the denominator is zero, the ratio is NaN, and
the series does not exist, so nothing fires. That is intended: an idle service has no measured
availability, and manufacturing one would only generate noise.
