# Gambit — load baseline

A repeatable load harness whose pass/fail criteria **are** the SLOs in `docs/SLO.md`. If a target is
unachievable, this run fails and the SLO is wrong; the objective and the thing that validates it
cannot drift apart.

## What this is not

**This is not the 100k-user validation.** That remains deferred in `docs/ROADMAP.md` and needs real
infrastructure — a cluster, generated load from multiple hosts, and production-shaped data. What
this gives you is a baseline you can run on one machine, so a regression shows up as a number rather
than as a feeling, and so the SLO targets stop being pure guesses.

Treat the numbers in `results/` as *this hardware, this dataset, this concurrency* — not as the
service's capacity.

## Running it

```bash
docker compose up -d --build     # the stack under test
node scripts/load-test.mjs
```

Tunables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `READ_VUS` | 20 | concurrent virtual users on the read path |
| `AUTH_VUS` | 3 | concurrent users registering; scrypt-bound, so keep this low |
| `DURATION` | 30s | per-scenario duration |
| `BASE_URL` | `http://host.docker.internal:8080` | API as seen **from inside the k6 container** |
| `HEALTH_URL` | `http://localhost:8080` | API as seen from the runner process |

k6 runs from a pinned Docker image (`grafana/k6:0.55.0`), like helm, kubeconform and promtool
elsewhere in this repo — load tooling is not something the application should carry as a dependency.
The version is pinned because a baseline measured with a drifting tool is not a baseline.

## Why two scenarios

They stress different resources, and mixing them would hide which one moved:

- **`read`** — public GETs against Postgres (`/v1/health`, `/v1/leaderboard/:variant`, `/v1/search`,
  `/v1/tournaments`, `/v1/seeks`). This is the path the API latency SLO describes.
- **`auth`** — registration, which runs scrypt on purpose (ADR-0012). A handful of concurrent
  registrations saturates a core in a way no volume of read traffic does, so it is held to a
  separate, explicitly looser threshold. Folding it into the API latency SLO would either make that
  SLO meaningless or make password hashing look like a regression.

## Thresholds

Taken directly from `docs/SLO.md`:

| k6 threshold | SLO |
|---|---|
| `http_req_failed: rate<0.005` | availability 99.5% — only 5xx counts, a 4xx is a valid response |
| `http_req_duration{scenario:read}: p(99)<250` | 99% of requests under 250 ms |
| `http_req_duration{scenario:auth}: p(95)<2000` | not an SLO — a guard on the deliberately expensive path |
| `auth_failures: rate<0.01` | registration must succeed **or** be cleanly rate-limited; anything else is a real failure |
| `checks{scenario:read}: rate>0.999` | every read URL must return 200 — a 4xx would otherwise pass silently while still entering the latency baseline |

Availability and correctness are measured by different mechanisms on purpose:
`http_req_failed` is relaxed to 5xx-only via `setResponseCallback`, because a 429 from the rate
limiter is the service working; the per-request **checks** are strict, because a scenario pointed at
a wrong URL must fail loudly rather than quietly measure the wrong thing.
