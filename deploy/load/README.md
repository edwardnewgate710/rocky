# Gambit — load baselines

Two on-demand harnesses, both k6 from the same pinned image, measuring two different things:

| Harness | Runs | Measures | Pass criteria |
|---|---|---|---|
| **HTTP** (ADR-0065) | `npm run load-test` | the REST API | the SLOs in `docs/SLO.md` |
| **WebSocket** (ADR-0111) | `npm run load-test:ws` | real sockets against two gateway nodes | coverage and correctness only |

## What this is not

**Neither is the 100k-user validation.** That remains deferred in `docs/ROADMAP.md` and needs real
infrastructure — a cluster, generated load from multiple hosts, and production-shaped data. What
these give you is a baseline you can run on one machine, so a regression shows up as a number rather
than as a feeling, and so the SLO targets stop being pure guesses.

Treat the numbers in `results/` as *this hardware, this dataset, this concurrency* — not as the
service's capacity.

---

# HTTP baseline

Pass/fail criteria **are** the SLOs in `docs/SLO.md`. If a target is unachievable, this run fails
and the SLO is wrong; the objective and the thing that validates it cannot drift apart.

## Running it

```bash
docker compose up -d --build     # the stack under test
npm run load-test
```

Tunables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `READ_VUS` | 20 | concurrent virtual users on the read path |
| `AUTH_VUS` | 3 | concurrent users registering; scrypt-bound, so keep this low |
| `DURATION` | 30s | per-scenario duration |
| `BASE_URL` | `http://host.docker.internal:8080` | API as seen **from inside the k6 container** |
| `HEALTH_URL` | `http://localhost:8080` | API as seen from the runner process |

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

---

# WebSocket baseline

Real sockets against the two-gateway stack: a WebSocket upgrade per connection, JSON frames crossing
a container boundary, and command forwarding between two independent gateway processes over Redis.
It closes the gap between `packages/realtime-gateway/test/load.test.ts` (fanout cost measured
in-process, no sockets) and `scripts/chaos-test.mjs` (real sockets, but two or three of them).

## Running it

The two-gateway stack, not the single-gateway one:

```bash
docker compose -f docker-compose.yml -f docker-compose.chaos.yml up -d --build
npm run load-test:ws
```

Run it against an otherwise idle stack: the exact forwarding-counter check intentionally fails if
unrelated game traffic shares the two gateway nodes during the measurement.

Tunables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `SPECTATORS_PER_NODE` | 16 | anonymous spectator sockets per gateway node |
| `MOVE_PLIES` | 32 | plies of the planned line to play (32 is the whole line) |
| `MOVE_INTERVAL_MS` | 250 | pause between plies |
| `API_URL` | `http://host.docker.internal:8080` | API as seen **from inside the k6 container** |
| `NODE1_WS_URL` | `ws://host.docker.internal:4175` | node1 WebSocket, from inside the container |
| `NODE2_WS_URL` | `ws://host.docker.internal:4177` | node2 WebSocket, from inside the container |
| `NODE1_HEALTH_URL`, `NODE2_HEALTH_URL` | `http://localhost:417{6,8}/health` | as seen from the runner process |
| `NODE1_METRICS_URL`, `NODE2_METRICS_URL` | `http://localhost:417{6,8}/metrics` | as seen from the runner process |

**A run costs two registrations, and `/v1/auth/register` allows five per IP per hour** (ADR-0013).
That is about two runs an hour from one host; the third fails in `setup()` with a 429 and says so.
It is the abuse control working as designed, not something to work around.

## What it does

1. Registers two players and opens one real game through `POST /v1/seeks` and
   `POST /v1/seeks/:id/accept`. No test-only endpoint exists or is needed.
2. Opens `1 + SPECTATORS_PER_NODE` sockets on each node — white plays through node1, black through
   node2, spectators join anonymously (no token, per ADR-0004).
3. Plays a deterministic legal line. White's first move claims ownership for node1, so **every black
   move after it is forwarded to node1 over Redis** — that alternation is what makes this a
   multi-node measurement rather than a single-node one.
4. Checks every frame every socket receives, and compares the `fenHash` all of them were given for
   each ply.

## What is enforced, and what is only reported

| k6 threshold | Why |
|---|---|
| `ws_joins_observed: count==<sockets>` | every socket must be seated; a socket that never joined would otherwise just be absent from the averages |
| `ws_broadcasts_observed: count==<sockets × plies>` | every socket must see every ply, exactly once — an exact count, because a delivery *rate* of 1.0 says nothing about deliveries that never arrived |
| `ws_protocol_errors: count==0` | a reject, an unexpected frame type, a ply out of order, a position two nodes disagree on, or a socket that closed early |

`scripts/ws-load-test.mjs` adds two checks k6 cannot make from inside a socket: both nodes must
report `commandRouting: redis` on `/health`, and `gateway_forwarded_commands_total` must grow by
exactly the number of commands the isolated plan sends to the non-owning node. Two gateways each routing
locally would answer every health check and serve every socket, and the run would look identical.

**The latency trends — `ws_connect_duration`, `ws_join_duration`, `ws_move_ack_duration`,
`ws_move_same_node_duration`, `ws_move_other_node_duration` — carry no thresholds.** `docs/SLO.md` has no
end-to-end WebSocket objective, and one run on one workstation is not the evidence needed to write
one. They are printed, labelled informational, and recorded in `docs/SLO.md` as an observation.

Note also that they are an **upper bound**: one k6 VU drives every socket on one event loop,
so a measurement includes whatever client-side queueing that loop added.

## Limits this stays under

The gateway allows 20 connections per source IP per node (`WS_MAX_CONNECTIONS_PER_IP`) and 60 client
frames per connection per 10 seconds (`WS_MAX_MESSAGES_PER_WINDOW`). k6 generates all its load from
one container, so the gateway sees every socket as one IP — the per-IP ceiling, not the hardware, is
what bounds this baseline. The default sits at 17 sockets per node. The finite 32-ply plan sends at
most 17 client frames on either player socket (one join plus 16 moves), so it also stays below the
60-frame message window even at the fastest accepted pacing.

Those limits are **not relaxed**, and no load-only Compose override ships: raising an abuse control
to make a number look better produces a number describing a service nobody deploys. A configuration
that would cross the connection limit is refused before the run starts. The plan also computes its
finite per-connection frame count against the message limit rather than projecting an unbounded stream.

## The move plan

Every pawn advances one square, file by file, colours alternating: `a2a3 a7a6 b2b3 b7b6 … h3h4 h6h5`.
Both properties it needs are provable by inspection rather than by having run it once — every move
is a single step into an empty square with neither king ever attacked, and a pawn advance is
irreversible, so no position can repeat. That second one matters: the engine ends a game on
threefold repetition, so a piece shuffle would end the game mid-run, and a famous opening line could
end it in mate. Either would fail the run for a reason that has nothing to do with the gateway.

## Its own tests

`npm run test:load-harness` exercises the planning and frame-verification logic in
`deploy/load/scenarios/lib/ws-baseline-plan.mjs` directly — the k6 scenario cannot be run by
`node --test` because it imports `k6/*`. It runs in CI even though the load test does not: the load
run needs a stack, its correctness guards are pure functions.

The WebSocket scenario deliberately does not use k6's built-in `--summary-export`: k6 includes
`setup_data` there, which contains the two short-lived access tokens. Its `handleSummary` writes a
metrics-only `results/ws-summary.json`, and the contract test proves representative setup data and
tokens cannot enter that serialization. Results remain gitignored.

---

Both harnesses run k6 from a pinned Docker image (`grafana/k6:0.55.0`), like helm, kubeconform and
promtool elsewhere in this repo — load tooling is not something the application should carry as a
dependency. The version is pinned, in one place (`scripts/lib/k6-docker.mjs`), because a baseline
measured with a drifting tool is not a baseline.

The WebSocket scenario uses `k6/experimental/websockets`, whose global event loop is what lets one
VU own the bounded room. Revalidate that runtime behavior before changing the pinned k6 version.
