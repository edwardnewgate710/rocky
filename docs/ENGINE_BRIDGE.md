# Gambit — Engine Bridge Architecture

> **Status:** ACCEPTED & IMPLEMENTED (Milestone 5). This is the contract that
> `@chess-platform/engine` implements and that the AI orchestrator (M7), `api`, and the
> deployable analysis/bot service (M14) consume. Decisions are recorded in
> [`docs/adr/0002-engine-bridge.md`](adr/0002-engine-bridge.md) (Accepted). The package is
> shipped and green (51 tests); items marked "deferred to M14" below are the only parts not
> yet wired. Refines [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §3 & §6.

This document defines the architecture of the `@chess-platform/engine` package and
the Engine Bridge service: how compute providers (native UCI engines today; neural
/ cloud / LLM providers tomorrow) are abstracted, discovered, pooled, health-checked,
scaled, and exposed — while keeping the core domain pure and dependency-free.

---

## 1. Goals & non-goals

**Goals**
1. Provide a reliable, **provider-agnostic** compute layer for analysis, hints, and
   bot play.
2. Preserve the "dependency-free domain" rule: native binaries and any third-party
   client live strictly behind adapter seams; domain code never imports
   `child_process`.
3. Support **multiple engines** (Stockfish for standard, Fairy-Stockfish for
   variants) and **future engines** with no changes to callers.
4. Isolate failures per worker; recover automatically; shut down gracefully.
5. Scale horizontally by queue depth; leave a seam for distributed workers (M14).
6. Be **deterministically testable** in CI with no native binaries.

**Non-goals (this milestone)**
- High-level AI features (Coach, Move Explanation) — those are tasks over the AI
  Orchestrator (M7), which consumes this bridge's raw facts.
- A distributed worker fleet — M5 ships a robust single-node pool; the remote-worker
  adapter is a documented seam bound in M14.
- Durable, cross-restart analysis storage — see §7 (cache is behind a port; the
  durable backend is deferred, not designed-in now).

## 2. Layered architecture (as designed)

Five layers, each an injectable seam (mirroring M3's `Transport`/`PubSub` and M4's
`PasswordHasher`). The dependency arrow always points **down**; higher layers never
know the concrete engine.

```
AnalysisProvider          ← what callers depend on (UCI-agnostic, AI-agnostic)
   ▲
EngineManager             ← top-level orchestrator: registry + routing + scheduling
   ▲                        + graceful lifecycle across ALL pools
EnginePool (per plugin)   ← warm workers of ONE engine kind; queue, health, scaling
   ▲
EngineInstance            ← one live worker (one native process); isolated
   ▲
EngineTransport           ← the raw I/O seam (UCI-over-stdio today; test fake)
```

### 2.1 `AnalysisProvider` — the top abstraction (item: AnalysisProvider)

**Adopted.** Callers (hints, eval bars, bots, anti-cheat, AI orchestrator) depend on
`AnalysisProvider`, **not** on "UCI" or "Stockfish". A UCI engine pool is one
implementation; a future neural/cloud/LLM analyzer is another that satisfies the
same contract without touching callers.

```typescript
export interface AnalysisRequest {
  fen: string;
  variant: string;
  limits: AnalysisLimits;      // depth | nodes | timeMs (at least one)
  multiPv?: number;
  priority?: JobPriority;
  signal?: AbortSignal;        // cooperative cancellation
}

export interface AnalysisProvider {
  analyze(req: AnalysisRequest): Promise<EngineResult[]>;
  /** Pick a move at a target strength band (bots). */
  play(req: PlayRequest): Promise<{ move: string; result?: EngineResult }>;
  /** What this provider can do — drives routing, not string conditionals. */
  readonly capabilities: EngineCapabilities;
}
```

Why: this is the single most valuable extension point in the design. It lets M7+ add
non-UCI analyzers (NNUE-in-process, GPU services, an LLM-grounded evaluator) as
drop-in providers, and lets the manager route by capability rather than by name.

### 2.2 `EngineManager` — orchestrator (item: EngineManager abstraction)

**Adopted.** A single top-level object owns the plugin registry, all pools, routing,
the priority scheduler, health aggregation, and process-wide graceful shutdown. It is
the composition root, constructed with injected config + clock + transport factory
(no module-level singletons — same DI style as `createApiServer`).

```typescript
export interface EngineManager extends AnalysisProvider, AsyncDisposable {
  register(plugin: EnginePlugin): void;         // plugin-oriented (see §3)
  route(req: AnalysisRequest): EnginePool;      // capability-based selection
  health(): ManagerHealth;                       // aggregate of all pools
  shutdown(opts?: { deadlineMs: number }): Promise<void>;  // graceful drain
}
```

`EngineManager` implements `AnalysisProvider` itself, so callers hold one object and
never see pools.

## 3. Plugin-oriented, provider-agnostic engines (items: plugin architecture; capability discovery)

**Adopted.** Engines are **plugins**, registered at startup. A plugin is a small
descriptor + a factory for `EngineInstance`s. There is **no `if (engine === 'stockfish')`
conditional anywhere** — behaviour is driven by discovered capabilities.

```typescript
export interface EnginePlugin {
  id: string;                       // 'stockfish' | 'fairy-stockfish' | ...
  displayName: string;
  minVersion: SemVer;               // see §5 version negotiation
  /** Spawns one worker; the transport seam is injected for testability. */
  createInstance(transport: EngineTransport, cfg: EngineConfig): EngineInstance;
}

export interface EngineCapabilities {
  variants: ReadonlySet<string>;    // discovered, not hard-coded
  options: ReadonlyMap<string, UciOptionSpec>;   // from `uci` handshake
  supportsMultiPv: boolean;
  supportsLimitStrength: boolean;
  supportsPonder: boolean;
  maxThreads?: number;
  maxHashMb?: number;
}
```

### 3.1 Capability discovery (item: capability discovery, not conditionals)

**Adopted.** On first spawn, each worker runs the `uci` handshake; the wrapper parses
`id name/author`, every `option name ...` line, and (for Fairy-Stockfish) the
advertised variant list. This produces `EngineCapabilities`, cached per
`(pluginId, version)`. Routing and option-setting consult capabilities:
- variant support → routing (`route()` picks a pool whose caps include the variant);
- `UCI_LimitStrength`/`Skill Level` presence → bot strength strategy;
- `MultiPV`/`Threads`/`Hash` presence + bounds → validated `setoption`.

Built-in plugins may declare a conservative cold-start `guaranteedMultiPv` count so a stricter
feature can be capability-gated without spawning a process merely to answer discovery. Once the
first UCI handshake completes, the discovered option bounds replace that declaration. An exact
MultiPV request outside those bounds is rejected; it is never silently clamped to weaker evidence.
UCI `score ... lowerbound` and `score ... upperbound` markers are retained on structured engine
results so evidence consumers can distinguish aspiration-search bounds from exact evaluations.

Why: capability discovery is what makes "add a new engine" a config change, not a
code change, and prevents brittle name-based branching.

## 4. Engine instance, transport & the UCI adapter

`EngineInstance` wraps exactly one worker and exposes analyze/play; it owns the UCI
state machine (`uci`→`uciok`, `isready`→`readyok`, `position`, `go`, `stop`,
`bestmove`, `info`). The **`EngineTransport`** seam is the only thing that touches
I/O:

```typescript
export interface EngineTransport {           // the isolation boundary
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}
```

- Production: `ChildProcessTransport` (native binary over stdio).
- Tests: `FakeEngineTransport` (see §11) — deterministic, no process.
- Future: `WasmTransport` (browser/edge), `RemoteTransport` (distributed workers).

## 5. Engine version negotiation & compatibility (item: version negotiation)

**Adopted.**
1. **Pin & floor:** each plugin declares `minVersion`; a probed worker below the floor
   is refused (logged, health-degraded) rather than silently used.
2. **Probe:** the `uci` `id name` line yields the concrete version; combined with a
   binary hash it forms an **engine fingerprint** `sha256(id + version + buildFlags)`.
3. **Negotiate options against caps:** only options the worker actually advertises are
   set; unknown options are never sent (avoids version drift breakage).
4. **Fingerprint in every result & cache key** (§7) so analysis from different
   engine builds never silently mixes. Upgrading an engine invalidates its cache
   namespace by fingerprint, not by manual purge.

## 6. Reliability: isolation, hot replacement, graceful lifecycle, health

### 6.1 Failure isolation between workers (item: failure isolation)
**Adopted.** Every worker is a **separate OS process** (a natural bulkhead): a crash,
hang, or OOM in one cannot corrupt another or the Node host. Additionally:
- per-worker resource caps (§ resource limits) bound blast radius;
- a **circuit breaker per pool**: if replacements exceed a threshold within a window
  (e.g. crash-looping on a bad binary), the pool opens, fails fast with a typed
  error, and stops respawning until a cooldown — preventing a fork bomb.

### 6.2 Crash detection & hot worker replacement (item: hot replacement)
**Adopted.** A supervisor watches `onExit` and a per-job **watchdog** (no `info`/
`readyok` within a deadline ⇒ presumed hung ⇒ `kill`). On death: in-flight jobs are
rejected with a retryable error (the scheduler may requeue idempotent analysis),
and a **replacement is spawned without draining the pool** — healthy siblings keep
serving. The same rolling mechanism performs zero-downtime **version upgrades**
(spin up new-fingerprint workers, retire old ones as they go idle).

### 6.3 Graceful shutdown & recovery (item: graceful shutdown/recovery)
**Adopted.** `EngineManager.shutdown({ deadlineMs })` on SIGTERM/SIGINT:
1. stop accepting new jobs (queue rejects with `ShuttingDown`);
2. let in-flight analysis finish up to the deadline;
3. send UCI `quit`; then `kill` any process still alive past the deadline;
4. resolve once all processes are reaped. Recovery on restart is stateless — the
   pool simply re-warms; no worker state is persisted (game truth lives in M2/M4).

### 6.4 Health monitoring interfaces (item: health monitoring)
**Adopted.** A first-class health contract feeds liveness/readiness probes (M13/M14)
and the circuit breaker:

```typescript
export type Health = 'healthy' | 'degraded' | 'unhealthy';
export interface WorkerHealth { id: string; state: Health; lastReadyOkMs: number; jobs: number; }
export interface PoolHealth   { plugin: string; ready: number; target: number; breaker: 'closed'|'open'|'half'; workers: WorkerHealth[]; }
export interface ManagerHealth{ status: Health; pools: PoolHealth[]; queueDepth: number; }
```
Readiness = at least one healthy worker per registered plugin; liveness = event loop
responsive + supervisor running.

## 7. Analysis cache — behind a port, not a fixed backend (item: cache abstraction)

**Adopted, and this SUPERSEDES the earlier ADR-0002 decision to commit to durable
Postgres.** Analysis is deterministic for `(fingerprint, fen, variant, limits, multiPv)`,
so caching is valuable — but the *backend* is a decision we should not bake in now.

```typescript
export interface AnalysisCache {
  get(key: AnalysisKey): Promise<EngineResult[] | undefined>;
  set(key: AnalysisKey, value: EngineResult[], meta: CacheMeta): Promise<void>;
}
```
- **M5 default:** `InMemoryLruCache` (bounded) + a `NullCache` for tests. Ships with
  the package, zero external deps, **does not touch the approved persistence contract**.
- **Deferred implementations behind the same port:** `RedisAnalysisCache`
  (cross-instance, ephemeral) and `PostgresAnalysisCache` (durable). A durable backend
  **amends `DATABASE.md`** and therefore requires its own gate — tracked as **future
  ADR-0003**, written only if/when durable caching is justified.
- **Invalidation rules:** (a) engine-fingerprint change ⇒ new namespace (old entries
  are simply never read); (b) a cached entry may only satisfy a request whose
  `limits` are **≤** the cached search (deeper request ⇒ miss/recompute); (c) TTL only
  for the ephemeral tiers; the durable tier is append-mostly and pruned by policy.

Why the reversal: committing to Postgres now (my first draft) violated the same
"don't design durable storage without a gate" discipline that produced `DATABASE.md`,
and coupled M5 to a schema change it doesn't need. A port keeps M5 self-contained and
defers the durable decision to where the evidence will exist.

## 8. Scheduling & priority queue

Priority classes, highest first: **(1) interactive bot moves** (a human is on the
clock) → **(2) live game analysis / hints** (user waiting) → **(3) tournament &
anti-cheat batch** → **(4) background** (opening-book building, precompute). Anti-
starvation via aging; backpressure by bounded queues per class with typed
`QueueFull` rejection. Cancellation (`AbortSignal`) removes queued jobs and `stop`s
in-flight ones.

## 9. Resource limits, security, cross-OS

- **Resource limits:** per-worker `Threads`/`Hash` set via validated `setoption`;
  process-level memory/CPU caps via cgroups (Linux/containers) with `ulimit`/
  `--max-old-space-size` fallbacks; pool size derived from host cores minus headroom.
- **Security:** engines process **untrusted FENs** — every FEN is validated by
  `@chess-platform/core` before it reaches a worker; binaries are spawned with a fixed
  argv (no shell), a restricted cwd/env, no network, and (in containers) a read-only
  rootfs + dropped capabilities. Fingerprints are pinned to prevent binary swaps.
- **Cross-OS:** Linux is the production/CI target; macOS + Windows are supported for
  dev via per-OS binary resolution (§10). The domain + `FakeEngineTransport` run
  identically everywhere with no native dependency.

## 10. Delivery, deployment & testing

- **Binary provisioning:** engines are **not committed**. Dev uses a checksum-pinned
  `postinstall` downloader per host OS; production **bakes pinned binaries into the
  Docker image**. A `BinaryResolver` seam abstracts "where is the binary" (system
  path / downloaded / container path).
- **Deterministic testing (item: deterministic testing):** acceptance and unit tests
  run against `FakeEngineTransport`/`DeterministicFakeEngine` returning fixed
  `EngineResult`s for known FENs; the one native "golden" test (real engine, fixed
  `depth`+`threads=1`+`hash`) is **opt-in behind an env flag**, mirroring the
  `DATABASE_URL`-gated Postgres tests — so `npm test` stays hermetic and green
  without binaries.
- **Horizontal scaling & future distributed workers:** the pool is stateless; scale
  out = more instances behind the queue. A `RemoteTransport`/work-queue seam (NATS/
  gRPC, reusing the M3 pub/sub adapter shape) enables cross-node workers in **M14**.
- **Future GPU / NNUE:** NNUE runs inside Stockfish today (just a binary/eval-file
  choice, surfaced via capabilities); GPU or a dedicated NNUE service arrives as a new
  **`AnalysisProvider`/plugin**, no caller changes — the same extension point as §2.1.

## 11. Acceptance criteria (M5) & scope split

- Analysis of a known game matches expected best moves under a pinned build + fixed
  `(depth, threads=1, hash)` (golden vectors); deterministic tests use the fake.
- Pool scales workers by queue depth (simulated, injected clock); a killed worker is
  detected and **hot-replaced with no job loss**; the circuit breaker opens on crash
  loops; graceful shutdown drains within the deadline.
- A bot plays a full legal game via the M2 `Game` aggregate at a target strength band.
- **Deferred to M14:** live-infra autoscaling, container/binary provisioning at scale,
  distributed remote workers. **Deferred to future ADR-0003:** durable analysis cache.
