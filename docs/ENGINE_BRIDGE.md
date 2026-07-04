# Gambit — Engine Bridge Architecture

> **Status:** PROPOSED (Milestone 5 gate).

This document defines the architecture of the `@chess-platform/engine` package and the Engine Bridge service. It establishes how native UCI engines (Stockfish, Fairy-Stockfish) are provisioned, managed, and exposed to the AI orchestration layer and client applications, while keeping the core domain pure.

---

## 1. Goals & non-goals

**Goals**
1. Provide a reliable, provider-agnostic engine pool for analysis, hint generation, and bot play.
2. Maintain the "dependency-free domain" constraint: native engine binaries must remain behind an isolated adapter seam.
3. Support multiple engine variants (Stockfish for standard chess, Fairy-Stockfish for variants).
4. Scale horizontally based on analysis queue depth.
5. Provide deterministic, testable mocks for CI.

**Non-goals**
- High-level AI features (Coach, Move Explanations). The bridge provides raw engine facts (evals, principal variations) to the AI Orchestrator (M7), which powers those features.
- Distributed worker fleets. M5 implements a robust in-process worker pool. Distributed work queues are deferred to M14 (scale).

## 2. Abstraction seam

The engine bridge is exposed to the rest of the application through a clean interface, ensuring domain code never touches `child_process`.

```typescript
export interface EngineOptions {
  variant: string;
  threads?: number;
  hashSizeMb?: number;
  multiPv?: number;
}

export interface AnalysisLimits {
  depth?: number;
  nodes?: number;
  timeMs?: number;
}

export interface EngineResult {
  evaluation: {
    type: 'cp' | 'mate';
    value: number; // centipawns or mate-in-X
  };
  principalVariation: string[]; // array of SAN or UCI strings
  depth: number;
  nodes: number;
  timeMs: number;
  nps: number;
}

export interface EngineProvider {
  /**
   * Acquires an engine configured for the position, blocks until one is free.
   */
  acquire(options: EngineOptions): Promise<EngineInstance>;
}

export interface EngineInstance extends AsyncDisposable {
  analyze(fen: string, limits: AnalysisLimits): Promise<EngineResult[]>;
  play(fen: string, limits: AnalysisLimits, skillLevel?: number): Promise<string>;
}
```

## 3. Worker Lifecycle & Process Model

The bridge manages long-lived `child_process` instances speaking the UCI protocol over `stdio`.

1. **Warm Pool:** Engines are heavy to start. The provider maintains a configurable warm pool (e.g., 4 Stockfish, 2 Fairy-Stockfish).
2. **Checkout:** `acquire()` checks out an engine, configuring it via `uci` and `setoption` (hash, threads) if changed.
3. **Cancellation & Time Controls:** If a client drops or a timeout hits, the wrapper sends `stop` to the UCI process. It waits for `bestmove` to resynchronize state before returning the engine to the pool.
4. **Crash Detection:** If the `child_process` exits unexpectedly or stdout drops, the wrapper marks it dead, rejects pending promises, and spawns a replacement in the background.

## 4. Bot calibration

Bots use "rating-calibrated strength." This is mapped to the standard Stockfish `Skill Level` (0-20) combined with `UCI_LimitStrength` and node limits, rather than arbitrary move-time constraints, to provide more realistic human-like play rather than blundering randomly.

## 5. Caching & Persistence

Engine analysis is deterministic for a given `(fen, depth, engine_version)`. Recomputing deep analysis is expensive.

*Decision required via ADR-0002:* Where does this cache live? Ephemeral (Redis) or Durable (Postgres)?

## 6. Observability & Security

- **Metrics:** Track `engine.acquire_wait_time`, `engine.analysis_time`, `pool.active_workers`, `pool.crashes`.
- **Security:** Engine binaries process untrusted FENs. Input FENs must be strictly validated by `@chess-platform/core` *before* being sent to the engine to prevent potential buffer overflows in the native binary.

## 7. Delivery & Testing

- **Testing:** The CI environment uses a `DeterministicFakeEngine` that returns hardcoded `EngineResult` payloads for specific FENs. No native binaries run during `npm test`.
- **Provisioning:** Engines are *not* committed to the repo. They are downloaded during `npm ci` via a postinstall script for local dev, and baked into the Docker image via `apt-get` or direct download for production.
