# ADR-0077 — Chaos & failover validation of multi-node game authority

| Field      | Value                                                                    |
|------------|--------------------------------------------------------------------------|
| **Status** | Accepted                                                                 |
| **Date**   | 2026-08-03                                                               |
| **Scope**  | `services/gateway`, `deploy`, `scripts`, `docs`, `.github/workflows`      |

---

## Context

Milestone 14 Increment 5 introduced single-owner game authority with command forwarding ([ADR-0010](0010-game-authority-ownership.md)) to enable horizontal scaling of the WebSocket gateway (`replicas: 2+`). The design coordinates game ownership via a Redis key-based registry (`game:owner:{gameId}`) with lease renewal, compare-and-delete graceful release, and reliable list queues (`game:cmd:{gameId}` / `game:resp:{requestId}`) for non-owner command forwarding.

Prior to Milestone 14 Increment 11, the correctness of ADR-0010 was proven only by hermetic unit tests against an in-process `FakeRedis`. The multi-node stack was never exercised against a real Redis instance with multiple independent gateway processes running concurrently, and no chaos or failover test suite existed.

Furthermore, ADR-0010 §7 specified five Prometheus metrics and `/health` response fields (`ownedGames`, `ownershipRegistry`) that were never implemented in `services/gateway/src/serve.ts`. Without these metrics and health fields, test harnesses and operational dashboards could not determine game ownership or observe forwarding behavior without guessing.

A 100k-user cluster load test requires multi-node infrastructure, distributed load generators, and substantial resource expenditure, remaining out of scope for a single-machine local test suite. However, chaos and failover mechanics are fully reproducible on a local workstation using multi-container Docker Compose overrides.

## Decision

### 1. Gateway Observability Metrics & Health Endpoint Expansion

We implement the metrics specified in ADR-0010 §7 using the existing `Metrics` port (`@chess-platform/api`), bounded and label-free:

- `gateway_owned_games` — gauge, count of games currently owned by this gateway node.
- `gateway_forwarded_commands_total` — counter, total commands forwarded by this node to an owner node.
- `gateway_forward_timeouts_total` — counter, total forward command attempts that timed out.
- `gateway_ownership_claims_total` — counter, successful game ownership claims by this node.
- `gateway_ownership_releases_total` — counter, game ownership releases by this node.
- `gateway_forward_latency_seconds` — histogram (`[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]`), measuring command forwarding round-trip duration.

The gateway `/health` response is expanded to include:
- `ownedGames`: integer count of games currently owned.
- `ownershipRegistry`: `'redis' | 'local'`.

All added metrics are verified against `scripts/check-observability-drift.mjs` to ensure zero drift against rule and dashboard configurations.

### 2. Two-Node Stack Configuration (`docker-compose.chaos.yml`)

We define a Compose override (`docker-compose.chaos.yml`) applied alongside `docker-compose.yml`:

- **Secondary gateway node (`gateway-node2`)**: Published host WS port `4177` and health port `4178` alongside primary `gateway` (WS `4175`, health `4176`), sharing the same Postgres, Redis, and API containers.
- **Shortened Lease TTL for testability**: `OWNERSHIP_LEASE_TTL_SEC=3` and `OWNERSHIP_RENEWAL_INTERVAL_SEC=1` set on both nodes. The test validates the ownership lease and renewal *mechanisms*; shortening the TTL allows failover to be verified in seconds rather than waiting for the 30-second production default.
- **Single-instance worker pinning**: `TOURNAMENT_REPORTER: "0"` and `SEARCH_INDEXER: "0"` on `gateway-node2`, ensuring exactly one instance of each worker runs across the stack.

### 3. Executable Chaos Test Suite (`scripts/chaos-test.mjs`)

A plain Node ESM script (`scripts/chaos-test.mjs`) drives four explicit scenarios against the real two-node stack:

1. **Cross-node correctness**: Player White connects to Node 1 (`ws://localhost:4175`) and Player Black connects to Node 2 (`ws://localhost:4177`). They play an alternating sequence of legal moves. Ownership is determined from `/health` and `/metrics`. Non-owner commands are forwarded over Redis queues. Asserts zero move rejections, identical position FEN hashes on both clients, and an increase in `gateway_forwarded_commands_total` on the non-owning node.
2. **Ungraceful owner loss**: SIGKILL (`docker kill`) the owning node container. Asserts that after lease expiry (3s TTL + margin), the surviving node claims ownership, play continues, and no move is lost or duplicated.
3. **Graceful drain**: SIGTERM (`docker stop`) the owning node container. Asserts that `releaseAll()` executes compare-and-delete in Redis, allowing the successor node to claim ownership immediately (< 1.5s), measurably faster than waiting for lease TTL expiry.
4. **Redis loss & recovery**: Stop Redis (`docker stop redis`). Asserts non-owner forwarding fails. Restores Redis (`docker start redis`) and asserts full recovery of command routing and play.

### 4. Opt-in CI Workflow (`.github/workflows/chaos.yml`)

An opt-in GitHub Actions workflow (`.github/workflows/chaos.yml`) is introduced, triggered strictly via `workflow_dispatch`. It is deliberately excluded from `ci.yml` per-PR jobs to conserve CI minutes and avoid container build overhead.

## The defect this increment found and fixed

**On taking ownership, a node validated commands against a stale aggregate.** ADR-0010 promises that
when an owner dies, "another node acquires ownership on the next command, rehydrates from the durable
log, and continues. The client experiences a brief delay, not a rejection." The first real two-node
run produced a rejection.

The sequence, reproduced every time before the fix:

1. White (on node 1) and Black (on node 2) join. Both nodes load the game at ply 0.
2. White moves. Node 1 owns the game, applies the move, appends it to the Postgres event log, and
   broadcasts it. Node 2 receives that broadcast **as a room fanout** — pub/sub delivers to rooms, it
   does not feed the local authority. Node 2's aggregate is still at ply 0.
3. Node 1 is SIGKILLed. The lease expires and node 2 claims the game on Black's next command.
4. Node 2 applies that command against its ply-0 copy and answers `not_your_turn` — for a move the
   durable log proves is legal.

This is precisely the stale-authority failure ADR-0010 was written to eliminate, reappearing at the
one moment the design exists to handle. It was invisible to the existing tests because they use a
`FakeRedis` in a single process, where there is no second node holding a stale copy.

The fix is on the seam that already existed for it: `GameAuthority.evict()` drops a game from the hot
cache so the next access rehydrates from the log. `RedisCommandRouter` now records a game as stale
when `onClaimed` fires — that hook fires only on a genuine ownership transition — and settles the
debt on the async command path, evicting and reloading before applying. It cannot be done in the hook
itself, which is synchronous while rehydration is not; and evicting without reloading is worse than
doing nothing, because `apply()` does not hydrate on a cache miss — it answers `unknown_game`. Both of
those wrong turns were taken and caught by this suite before the fix landed.

## Scenario Findings & Behavioural Discrepancies with ADR-0010

### Scenario D Finding: Local Command Processing During Redis Outage

**ADR-0010 §6 Claim:**
> *"If Redis is down, non-owner nodes cannot forward commands. The owner node can still process local commands."*

**Observed Empirical Behavior:**
When Redis is stopped (`docker stop redis`), commands routed through `RedisCommandRouter` fail on **both** non-owner and owner nodes.

**Root Cause Analysis:**
`RedisCommandRouter.route()` in `services/gateway/src/command-forwarder.ts` executes `this.registry.claim(gameId)` on every routed command to verify or establish ownership before attempting local execution. Because `OwnershipRegistry.claim()` issues a Redis command (`SET key nodeId EX ttl NX` or `GET key`), stopping Redis causes `claim()` to throw an uncaught Redis connection error (`ioredis` connection closed / unreachable). Thus, even the owner node cannot process local commands while Redis is unreachable.

**Verdict:**
This finding is documented herein and in `chaos-test.mjs` logs without mutating ADR-0010 or adjusting test assertions to mask the reality. Redis remains a hard dependency for multi-node gateway command routing, consistent with its role in pub/sub broadcast fanout.

## Consequences

- **What is proven**: Single-owner authority, command forwarding, ungraceful crash failover, graceful drain handoff, metric observability, and post-Redis-outage recovery are empirically proven against a real multi-process stack.
- **What remains out of scope**: Synthetic 100k-user cluster load testing and dedicated out-of-process authority actor shards remain deferred.
- **Operational confidence**: The metric gap is closed, allowing Prometheus dashboards and alerts to monitor game ownership counts and forwarding latency in production.

### What writing the suite taught, which the suite now encodes

Three of its own early versions passed or failed for reasons unrelated to the system, and each is now
prevented by construction rather than by care:

- **Ownership is claimed by the first COMMAND, not by `join`.** The only callers of
  `OwnershipRegistry.claim()` are on the command path. A test that asks who owns a game straight
  after joining reads `ownedGames: 0` on both nodes — correct behaviour, mistaken for a failure. Note
  that ADR-0010's prose says ownership is "acquired on first `join`"; the implementation acquires on
  first command. The code is the truth here and the ADR sentence is loose.
- **`ownedGames` is a per-node count over all games, not a per-game flag.** Ownership outlives a
  scenario, so by scenario C both nodes legitimately reported 1 and the owner was undecidable. The
  suite now takes a baseline before each scenario's first command and attributes the game to the node
  whose count rises.
- **Registration is rate limited to 5/hour per IP.** Registering a fresh pair per scenario costs 12
  and cannot complete a run from any IP. The two players are now created once and only the game is
  recreated — and a CI runner's fresh IP would have hidden this, not fixed it.

The suite's exit codes distinguish these outcomes: `0` all scenarios held, `1` a regression in
validated behaviour, `2` only known open defects. That separation exists so the one open item above
cannot quietly become "the chaos test is always red, ignore it".
