# ADR 0002 — Engine Bridge decisions (Milestone 5)

- **Status:** Proposed
- **Date:** 2026-07-04
- **Context milestone:** M5 (Engine Bridge)
- **Supersedes:** none
- **Related:** [`docs/ENGINE_BRIDGE.md`](../ENGINE_BRIDGE.md)

## Context

Milestone 5 introduces the Engine Bridge, integrating Stockfish and Fairy-Stockfish for analysis and bot play. This introduces the first native, stateful dependencies to the platform. We must decide how these are provisioned, scaled, and isolated, without breaking our dependency-free domain rules or our reproducible test suites.

## Decisions

### 1. Process model: Node `child_process` pool vs. WASM

**Decision:** Use `child_process` wrapping native OS binaries (Stockfish / Fairy-Stockfish) managed by a strict pool, rather than WASM engines in V8.

**Why:** WASM engines inside Node.js suffer a 30-50% performance penalty and complex memory limits compared to native binaries. For a scalable chess server, raw node-per-second throughput is paramount. The pool manages timeouts, `stop` commands, and crash recovery.

### 2. Binary provisioning: Docker + Postinstall (Not committed)

**Decision:** Do not commit engine binaries to the repository. 
- In development: use a `postinstall` script to download precompiled binaries for the host OS.
- In production: bake the binaries into the `Dockerfile`.

**Why:** Committing binaries bloats the repo and breaks cross-platform (Mac/Linux/Windows) development. 

### 3. Testability: `DeterministicFakeEngine`

**Decision:** The domain tests will run against a `DeterministicFakeEngine` that returns hardcoded, immediate results for known FENs.

**Why:** Native engines are non-deterministic (thread timing affects search trees) and slow. The acceptance criterion "analysis matches expected best moves" requires deterministic outputs in CI to avoid flaky tests.

### 4. Engine Analysis Caching

**Decision (PROPOSED):** Engine analysis caches are **Durable (Postgres)**, written via an `AnalysisRepository` in `@chess-platform/persistence`, with an ephemeral Redis read-through layer.

**Why:** Re-analyzing deep positions (e.g., depth 24+) is CPU-expensive. If the cache is Redis-only, restarting the cache layer loses thousands of hours of compute. A Postgres table `engine_analysis_cache(fen, engine, depth, result jsonb)` preserves this value. *Note: this amends the approved DATABASE.md schema and requires a migration.*

### 5. Task Prioritization

**Decision:** The bridge implements priority queuing at the `acquire()` level:
1. Interactive bot play (needs immediate response)
2. Live game analysis (user waiting)
3. Background tournament/cheat-detection analysis (can wait)

**Why:** If a massive tournament ends and queues 500 games for anti-cheat analysis, it should not cause interactive bot players to experience lag.

## Status of impact

- Requires a new package `@chess-platform/engine`.
- Requires an addendum to `DATABASE.md` and a new migration for the durable analysis cache.
- Requires updating the CI workflow to run the engine downloader script.
