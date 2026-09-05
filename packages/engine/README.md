# @chess-platform/engine

Provider-agnostic chess **engine bridge** for Gambit: a pool of UCI engine workers
(Stockfish, Fairy-Stockfish, and future engines) behind clean, injectable seams, driving
analysis, hints, eval bars, and rating-calibrated bots. It is **never** in the gameplay
legality hot path — the rules engine (`@chess-platform/core`) and the game authority
(`@chess-platform/game`) remain the source of truth.

Design contract: [`docs/ENGINE_BRIDGE.md`](../../docs/ENGINE_BRIDGE.md);
decisions: [`docs/adr/0002-engine-bridge.md`](../../docs/adr/0002-engine-bridge.md).

## Architecture (layered, top-down)

```
AnalysisProvider      what callers depend on (UCI-agnostic, AI-agnostic)
  ▲
EngineManager         registry + capability routing + cache + FEN boundary + shutdown
  ▲
EnginePool            warm workers of one engine kind; queue, autoscale, breaker, health
  ▲
EngineInstance        one worker: UCI state machine, watchdog, cancellation, crash detect
  ▲
EngineTransport       the only I/O seam (native subprocess in prod, fake in tests)
```

Pluggable seams: `EnginePlugin` (register engines), `AnalysisCache` (in-process LRU by
default; persistent backends like PostgreSQL implement this interface), `EngineTransport`, `FenValidator`, `Clock`.

## Key properties

- **Dependency-free domain.** No runtime dependencies; native processes and any client
  live strictly behind seams.
- **Provider-agnostic, capability-driven.** Routing and option-setting are driven by the
  capabilities discovered from the `uci` handshake — never by engine-name conditionals.
- **Reliable.** Per-process failure isolation, per-search watchdog, crash detection with
  **hot worker replacement** (no pool drain), a per-pool **circuit breaker**, and graceful
  shutdown (`quit` → drain → kill).
- **Fair.** Priority scheduler — bot moves > live analysis > batch > background — with
  aging (anti-starvation) and per-class backpressure.
- **Safe.** Untrusted FENs are validated before reaching a worker; binaries are spawned
  with a fixed argv, no shell, and an empty environment by default.
- **Deterministically testable.** A shipped `FakeEngineTransport` + injectable `Clock` make
  the whole stack testable with no native binary.

## Usage

Production composition (native engines):

```ts
import { createEngineManager } from '@chess-platform/engine';

// Resolves binaries from STOCKFISH_PATH / FAIRY_STOCKFISH_PATH (or an override map).
const engine = createEngineManager({ minWorkers: 2, maxWorkers: 8 });
await engine.warmup();

const lines = await engine.analyze({ fen, variant: 'chess', limits: { depth: 22 }, multiPv: 3 });
const { move } = await engine.play({ fen, variant: 'chess', limits: { timeMs: 1000 }, strength: { elo: 1600 } });

await engine.shutdown({ deadlineMs: 10_000 });
```

Deterministic tests (no binary): construct an `EngineManager` with a `transportFactory`
that returns `FakeEngineTransport`, and drive time with a manual `Clock`.

## Build & test

```bash
npm install
npm run build     # tsc -> dist/
npm test          # tsc -p tsconfig.test.json && node --test dist-test/test/
npm run lint      # tsc --noEmit
```

The package test suite is hermetic, exercising the full stack using `FakeEngineTransport`
and injectable clocks without requiring native engine binaries.

Real-engine integration is tested via environment-gated smoke tests in CI (under
`@chess-platform/api` with pinned Stockfish and Fairy-Stockfish binaries against a real database).
In production runtime wiring, the engine bridge powers bot play in the gateway and analysis
endpoints in the API. Distributed remote engine workers remain deferred.
