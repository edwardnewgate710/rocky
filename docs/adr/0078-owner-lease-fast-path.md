# ADR-0078 — Local owner lease tracking & fail-closed fast path

| Field      | Value                                                                    |
|------------|--------------------------------------------------------------------------|
| **Status** | Accepted                                                                 |
| **Date**   | 2026-08-03                                                               |
| **Scope**  | `services/gateway`, `deploy`, `scripts`, `docs`                          |

---

## Context

In Milestone 14 Increment 5, single-owner game authority with Redis-backed command forwarding was introduced ([ADR-0010](0010-game-authority-ownership.md)).
ADR-0010 §6 claimed:
> *"If Redis is down, non-owner nodes cannot forward commands. The owner node can still process local commands."*

However, when Milestone 14 Increment 11 created the automated multi-node chaos suite (`scripts/chaos-test.mjs`, [ADR-0077](0077-chaos-failover-validation.md)), execution of Scenario D revealed that this claim was untrue. In `RedisCommandRouter.route()`, `OwnershipRegistry.claim()` was called on *every* single command attempt to check or acquire ownership in Redis (`SET EX NX` or `GET`). Consequently, any transient Redis outage or network blip caused `claim()` to throw a Redis connection error, instantly halting ALL gameplay across the platform — even for games running locally on their respective owner nodes.

One Redis blip stopped every active game on the platform.

## Decision

We eliminate the Redis round-trip on owner command routing by introducing local owner lease tracking in `OwnershipRegistry` and a fail-closed fast path in `RedisCommandRouter`.

### 1. Local Lease Tracking (`OwnershipRegistry`)

- Per owned game, `OwnershipRegistry` records the monotonic expiry instant (`performance.now() + leaseTtlSec * 1000`) when `claim()` succeeds and on every successful lease renewal in `renewAll()`.
- Failed lease renewals (e.g. during a Redis outage) log an error and increment `gateway_ownership_renewal_failures_total`, but do **NOT** extend or update the local lease expiry timestamp.
- Monotonic time (`performance.now()`) is used exclusively for expiry arithmetic to ensure immunity against NTP clock jumps or system time shifts.
- Exposes a predicate `holdsValidLease(gameId: string): boolean` that returns `true` only if this node tracks ownership of `gameId` AND `performance.now() < expiresAt - safetyMarginMs`.

### 2. Derived Safety Margin & Split-Brain Prevention

Serving commands on a lease that has expired in Redis creates a catastrophic split-brain state: Redis drops the key, another gateway node claims ownership of the game, and both nodes operate concurrently as authorities, generating conflicting events and corrupting the event log.

To guarantee split-brain prevention, the fast path must be conservative and fail closed:

- **Derived Safety Margin**: The safety margin is derived from `leaseTtlSec` ($L$) and `renewalIntervalSec` ($R$):
  - `slackMs = (leaseTtlSec - renewalIntervalSec) * 1000`
  - `driftMarginMs = Math.min(1000, Math.max(200, Math.floor(renewalIntervalSec * 200)))`
  - `safetyMarginMs = Math.floor(slackMs / 2) + driftMarginMs`
- **Why Derived**: Hardcoding a static millisecond value would break when lease TTLs or renewal intervals are adjusted in different environments (e.g. production defaults $L=30\text{s}, R=15\text{s}$ vs chaos test defaults $L=6\text{s}, R=2\text{s}$).
- **Fail-Closed Mechanics**: While Redis is down, renewals fail, the recorded expiry stops advancing, and the fast path closes on its own as time passes `expiresAt - safetyMarginMs`. Subsequent commands fall back to the Redis `claim()` path, which fails — rejecting commands. The node fails closed rather than serving past its valid lease.

### 3. Fast Path in `RedisCommandRouter.route()`

When a command arrives:
1. `route()` checks `this.registry.holdsValidLease(gameId)`.
2. If `true`:
   - Increments `gateway_fast_path_commands_total`.
   - Preserves takeover rehydration: awaits `rehydrateIfStale(gameId)` to ensure any game recently taken over is rehydrated from the durable event log before applying.
   - Applies the command locally within a `gateway.command` span without touching Redis.
3. If `false`:
   - Falls back to the existing Redis path (`claim()`, then apply locally or forward).

### 4. Gateway Observability Metrics

Added two new Prometheus counters registered in `services/gateway/src/serve.ts`:
- `gateway_ownership_renewal_failures_total`: Incremented whenever a lease renewal attempt fails (e.g. during a Redis outage).
- `gateway_fast_path_commands_total`: Incremented whenever an owner node processes a local command via the fast path without touching Redis.

Verified with `scripts/check-observability-drift.mjs`.

### 5. Chaos Test Suite Integration (`scripts/chaos-test.mjs`) & Compose Overrides

- **Adjusted Chaos Lease Parameters (`docker-compose.chaos.yml`)**: Set `OWNERSHIP_LEASE_TTL_SEC=6` and `OWNERSHIP_RENEWAL_INTERVAL_SEC=2` across gateway nodes. This gives a fast-path lease window of ~3.6s, providing a robust, non-flaky window to test both in-window local execution and post-expiry fail-closed behavior.
- **Scenario D Real Assertions**:
  - Validates non-owner commands fail when Redis is stopped.
  - Validates owner commands executed on Node 1 inside the lease window **succeed** via the fast path without Redis.
  - Validates owner commands executed after waiting 5s (past the lease window) **fail closed** as expected.
  - Validates full recovery of cross-node play once Redis container is restarted.
- **Cleared Known Open Defects**: Removed the `CONTRA-ADR FINDING` entry from `KNOWN_OPEN_DEFECTS`. The chaos suite now completes cleanly with exit code 0.

## Consequences

- **Platform Availability**: A transient Redis blip or outage no longer halts ongoing games. Owner nodes continue serving local moves seamlessly for the duration of their valid lease window.
- **Strict Split-Brain Protection**: Games fail closed safely before the Redis key TTL elapses in Redis. Two nodes can never act as concurrent authorities for the same game.
- **ADR-0010 §6 Alignment**: Corrected the aspirational ADR-0010 §6 claim: owner local execution during a Redis outage is now fully implemented and empirically proven against the real multi-node stack.
