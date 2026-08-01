# ADR-0065 — Load baseline, with the SLOs as its pass criteria

| Field      | Value                                   |
|------------|-----------------------------------------|
| **Status** | Accepted                                |
| **Date**   | 2026-08-01                              |
| **Scope**  | `deploy/load`, `scripts`, `docs/SLO.md` |

---

## Context

ADR-0064 shipped three SLOs and said, at the top of `docs/SLO.md`, that every number in it was an
unvalidated guess: Gambit has never carried production traffic and has never been load tested. That
is an honest disclosure, but it leaves the alerting configured against numbers nobody has checked
against a running system — the alerts could be unreachable, or trivially satisfiable, and there was
no way to tell which.

M14 defers "100k-user load testing + chaos validation" as a later increment. That work needs a
cluster, load generated from multiple hosts, and production-shaped data. None of it is a
prerequisite for the much smaller question this increment answers: **can the service meet its own
stated objectives at all?**

## Decision

### 1. The k6 thresholds ARE the SLOs

`deploy/load/scenarios/api-baseline.js` expresses the objectives from `docs/SLO.md` directly as k6
thresholds rather than restating them as separate numbers:

```js
http_req_failed: ['rate<0.005'],                       // availability 99.5%
'http_req_duration{scenario:read}': ['p(99)<250'],     // 99% under 250 ms
```

A load test that measures one thing while the SLO promises another is two sources of truth that
drift. Here a breached threshold means either the service regressed or the objective was never
achievable, and both need a human — so `scripts/load-test.mjs` exits non-zero rather than recording
a number nobody looks at.

### 2. Two scenarios, because they stress different resources

- **`read`** — public GETs against Postgres. This is the path the latency SLO actually describes.
- **`auth`** — registration, which runs scrypt on purpose (ADR-0012). A few concurrent registrations
  saturate a core in a way no volume of read traffic does.

`auth` is held to a separate, explicitly looser threshold and is **not** part of the latency SLO.
Folding an intentionally expensive password hash into a 250 ms objective would either make the SLO
meaningless or make correct security behaviour show up as a regression.

### 3. Report the series the threshold enforces, and check reads strictly

Two mistakes worth recording, because both made a broken measurement look healthy:

- The reporter printed the **aggregate** `http_req_duration` p99 while the threshold is scoped to
  `{scenario:read}`. Numerically close here (98.29 vs 98.64 ms), but it is the wrong series — it
  blends in the scrypt-bound registration path that the scenario split exists to separate.
- `readPath` checked only "not a 5xx". A 4xx therefore passed the check *and* contributed its
  latency to the baseline. That is precisely how the `/v1/leaderboard/blitz` mistake below survived
  a full run: 9,039 validation failures, all counted as healthy traffic.

Read checks now demand `200`, and `checks{scenario:read}` is itself a threshold, so a read URL that
stops succeeding fails the run instead of quietly changing what is being measured.

### 4. Only 5xx counts against availability

Consistent with the SLO and the alert rules: a 4xx is a valid HTTP response and the client's
problem. This is enforced by `http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }))`,
which makes k6's `http_req_failed` mean 5xx — separately from the per-request checks, which are
strict (see decision 3). Availability and correctness are different questions and are measured by
different mechanisms.

### 5. k6 from a pinned Docker image, not an npm dependency

Matching how helm, kubeconform and promtool are already used here. Load tooling is not something the
application should carry, and the domain packages stay dependency-free.

**Pinned to `grafana/k6:0.55.0`.** A baseline measured with a drifting tool is not a baseline — the
same argument that pinned `promtool` after the Qodo finding on PR #59.

### 6. Results are not committed

`deploy/load/results/` is gitignored. A summary JSON describes whatever machine happened to run it;
committing it would invite comparison between numbers that were never comparable. The measured
baseline that *is* meaningful — hardware, concurrency, and what it showed — is recorded in prose in
`docs/SLO.md`.

### 7. Two container-build defects found by trying to run the thing

Standing the stack up to measure it exposed that **`docker compose up --build` had been broken since
M11 inc 5** — the one-command local stack `docs/RUNNING.md` promises. Two separate hand-maintained
lists had gone stale in the same way:

1. **Build order.** `Dockerfile.api` and `Dockerfile.gateway` each repeated the package build chain,
   and neither gained `search`, `engine` or `anti-cheat` when `persistence` and `api` started
   depending on them. The image build failed outright.
2. **Runtime copy list.** With the order fixed the image built, then died at startup with
   `Cannot find module '@chess-platform/search'` — the runtime stage copies packages one by one and
   was missing the same three.

Neither was visible to any gate. CI builds from the root chain and never builds these images, so
every check stayed green while the documented developer entry point did not work.

The fix removes the duplication rather than patching the copies: both Dockerfiles now call the root
`build:server` script, and `scripts/check-docker-build-order.mjs` verifies, statically and in
seconds, that the chain covers every transitive dependency of `@chess-platform/api` in a valid order
**and** that each runtime stage ships them. It is wired into the `build-test` CI job.

The guard was verified by reproducing both real failures: removing `search` from the chain, and
removing its runtime `COPY`. Each produced a non-zero exit naming the package and the file.

## Consequences

- The SLO targets can now be checked rather than believed. `docs/SLO.md` records the measured
  baseline alongside each target, with the conditions it was measured under.
- A regression in the read path shows up as a failing threshold rather than as a feeling.
- **This is still not the 100k validation.** It is a single-machine baseline against a
  `docker compose` stack: one API replica, one Postgres, a small dataset, and load generated from
  the same host that runs the service — which means the generator competes with the service for CPU.
  Numbers from it are a floor, not a capacity figure, and `deploy/load/README.md` says so.
- Not wired into CI. A load test on a shared runner measures the runner's neighbours as much as the
  service, and a flaky performance gate teaches people to ignore gates. It is a deliberate,
  on-demand tool.
