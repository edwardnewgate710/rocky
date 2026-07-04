# ADR 0002 — Engine Bridge decisions (Milestone 5)

- **Status:** Proposed (refined after gate approval-in-principle)
- **Date:** 2026-07-04
- **Context milestone:** M5 (Engine Bridge)
- **Supersedes:** none
- **Superseded within this ADR:** Decision 4 (v1) — "durable Postgres cache" — is
  replaced by Decision 4 (v2), a cache **port** with an ephemeral default.
- **Related:** [`docs/ENGINE_BRIDGE.md`](../ENGINE_BRIDGE.md), [`docs/ADR-0001`](0001-persistence-data-modeling.md)

## Context

Milestone 5 introduces the Engine Bridge, integrating Stockfish and Fairy-Stockfish
for analysis and bot play — the platform's first **native, stateful** dependencies.
We must decide how these are abstracted, discovered, pooled, isolated, versioned,
scaled, and tested, without breaking the dependency-free domain rule or the
reproducible test suites. This revision incorporates a refinement pass (ten
prompts) after the gate was approved in principle.

## Decisions

### 1. Process model: Node `child_process` pool vs. WASM — ADOPTED
Use `child_process` wrapping native binaries behind an `EngineTransport` seam, not
WASM in V8. WASM in Node costs 30–50% NPS and complicates memory; native throughput
matters for a scaling server. WASM remains available later as an alternate transport
(browser/edge).

### 2. Binary provisioning: not committed — ADOPTED
Binaries are never committed. Dev = checksum-pinned `postinstall` download per OS;
prod = baked into the Docker image; a `BinaryResolver` seam abstracts location.
Keeps the repo lean and cross-platform (Linux prod/CI; macOS/Windows dev).

### 3. Deterministic testing: `FakeEngineTransport` — ADOPTED
Domain + acceptance tests run against a deterministic fake returning fixed results;
the single real-engine "golden" test is env-gated (mirrors the `DATABASE_URL`-gated
Postgres tests), so `npm test` stays hermetic and binary-free.

### 4. Analysis cache — **REVISED**: a port, not a fixed backend
**v1 (superseded):** commit to a durable Postgres analysis cache now.
**v2 (adopted):** define an `AnalysisCache` **port**; ship an in-process LRU (+ null
for tests) as the M5 default. `Redis` (ephemeral, cross-instance) and `Postgres`
(durable) are deferred implementations behind the same interface.
**Why revised:** baking in durable Postgres (a) coupled M5 to a schema change it does
not need, and (b) violated the very gate discipline that produced `DATABASE.md` — a
durable store deserves its own approval. Consequence: **M5 no longer amends the
approved persistence contract.** A durable cache, if justified later, is **future
ADR-0003 + a `DATABASE.md` addendum**. Invalidation: keyed by engine fingerprint;
a cache hit must have `limits ≤` the request; TTL only on ephemeral tiers.

### 5. Task prioritization — ADOPTED
Priority queue at admission: interactive bot play > live analysis/hints > tournament
& anti-cheat batch > background; aging prevents starvation; bounded queues give
backpressure; `AbortSignal` cancels queued and in-flight work.

### 6. Layered management: `EngineManager` over `EnginePool` over `EngineInstance` — ADOPTED (refinement)
A single top-level `EngineManager` (also an `AnalysisProvider`) owns the registry,
routing, scheduler, health aggregation, and process-wide graceful shutdown; pools own
warm workers of one engine kind; instances wrap one process. DI composition root, no
singletons. Rationale: callers hold one object; lifecycle and scaling live in one
place instead of leaking into handlers.

### 7. Plugin architecture + capability discovery — ADOPTED (refinement)
Engines register as **plugins** (descriptor + instance factory). Behaviour is driven
by **capabilities discovered from the `uci` handshake** (variants, options, strength
knobs, bounds), never by `engine === 'x'` conditionals. Rationale: adding an engine
becomes configuration, not code; eliminates brittle name-based branching; directly
serves the "multiple + future engines" requirement.

### 8. `AnalysisProvider` abstraction above UCI — ADOPTED (refinement)
Callers depend on `AnalysisProvider`, not on UCI/Stockfish. A UCI pool is one
implementation; future **non-UCI** analyzers (in-process NNUE, GPU service, LLM-
grounded evaluator for M7/M8) implement the same contract with no caller changes.
Rationale: this is the key long-horizon extension point and keeps the AI layer
(M7) cleanly decoupled from the engine transport.

### 9. Engine version negotiation — ADOPTED (refinement)
Per-plugin `minVersion` floor; version probed from `uci id`; an **engine fingerprint**
`sha256(id+version+buildFlags)` is attached to results and cache keys and namespaces
the cache; only advertised options are ever set. Rationale: prevents silent mixing of
analysis across engine builds and makes upgrades safe (fingerprint invalidation +
rolling replacement).

### 10. Reliability: isolation, hot replacement, graceful lifecycle, health — ADOPTED (refinement)
- **Failure isolation:** each worker is its own process (bulkhead) with resource caps;
  a **per-pool circuit breaker** stops respawn storms on a bad binary.
- **Hot replacement:** crashed/hung workers (watchdog on `readyok`/`info`) are replaced
  without draining the pool; same mechanism does rolling version upgrades.
- **Graceful shutdown:** SIGTERM ⇒ stop admitting, drain to a deadline, `quit`, then
  force-kill; restart re-warms statelessly.
- **Health interfaces:** `WorkerHealth`/`PoolHealth`/`ManagerHealth` feed liveness/
  readiness probes and the breaker.
Rationale: a compute tier that spawns native processes must assume they crash, hang,
and get upgraded; these make those events non-events.

## Additional ADRs — evaluation

- **ADR-0003 (durable analysis cache):** anticipated but intentionally **not written
  now** — M5's cache is ephemeral and does not touch the approved DB contract. Write it
  only when durable caching is justified; it must include a `DATABASE.md` addendum.
- No other new ADR is required for M5. All ten refinement items are covered by
  Decisions 6–10 above (as seams within the engine package), and none change the
  platform architecture, service map, or milestone plan.

## Status of impact

- New package `@chess-platform/engine` (dependency-free domain + native processes and
  any client strictly behind seams: `EngineTransport`, `AnalysisCache`, `BinaryResolver`).
- **No change** to the approved `persistence`/`DATABASE.md` contract (cache is a port;
  durable backend deferred to ADR-0003).
- CI gains an env-gated real-engine golden test + the engine downloader; the hermetic
  suite is unchanged.
- Consumers depend only on `AnalysisProvider`; the AI orchestrator (M7) and bot wiring
  into the M3 `GameAuthority` (M14) are unaffected by engine choice.
