# ADR-0006: M8 AI Feature Architecture

> **Status:** Accepted  
> **Date:** 2026-07-09  
> **Supersedes:** None  
> **Related:** ADR-0002 (Engine Bridge), ADR-0005 (AI Orchestration Layer)

## Context

Milestone 8 delivers nine AI features (Coach, Move Explanation, Opening/Endgame
Trainer, Puzzle Generator, Tournament Commentator, Voice Coach, Study Partner,
Opening Explorer, Mistake Predictor). Each is a task built on M5
(`@chess-platform/engine`) + M7 (`@chess-platform/ai-orchestrator`).

The ROADMAP requires M8 to ship as a sequence of small, independently
reviewable increments — one feature per PR. This ADR records the architecture
for the feature layer and explains why Move Explanation is the template every
later feature follows.

## Decision

### 1. New package: `@chess-platform/ai-features`

A dedicated package `packages/ai-features` houses all M8 feature
implementations. It depends on `@chess-platform/engine` and
`@chess-platform/ai-orchestrator` only — no networking, no UI, no
database. This keeps features isolated from infrastructure and
testable hermetically with fakes.

**Why a new package (not a module inside `ai-orchestrator`):** The
orchestrator is the *framework* — provider routing, failover, caching,
grounding. Features are *applications* of that framework. Mixing them
would couple the framework to specific use cases and bloat the
orchestrator's public surface. The dependency arrow stays clean:
`engine ← ai-orchestrator ← ai-features`.

### 2. Feature pattern (the template)

Every M8 feature follows the same structure:

1. **Inject ports:** `AnalysisProvider` (M5) + `AiProvider` (M7) are
   constructor-injected. Never hardcoded, never imported as concrete
   implementations in the domain.
2. **Run the engine:** Obtain engine analysis (use pre-computed results
   if supplied, else call `AnalysisProvider.analyze()`).
3. **Ground the prompt:** Convert engine results to `EngineGrounding`
   via `engineResultsToGrounding()`, then build provider-agnostic
   messages via `buildGroundedMessages()`.
4. **Call the AI:** Send the grounded completion request to
   `AiProvider.complete()`.
5. **Return structured output:** The response includes a distinct,
   testable `citation` field carrying the engine's eval, best line,
   and depth — not prose the test has to parse.

### 3. Move Explanation as the template

Move Explanation is the first M8 increment because:

- **Simplest:** One engine call, one LLM call, one structured response.
  No multi-turn conversation, no streaming, no state.
- **Exercises the grounding path directly:** The whole point of the
  feature is that the explanation cites real engine numbers. This
  validates the `engineResultsToGrounding → buildGroundedMessages →
  AiProvider.complete` pipeline end-to-end.
- **Sets the citation pattern:** The `EngineCitation` type (eval kind,
  eval value, eval label, best line, depth) is reusable by every
  later feature that needs to cite engine analysis.
- **Hermetically testable:** `FakeEngineTransport` + `FakeProvider`
  drive the full path with zero external dependencies.

### 4. Testing strategy

- **Hermetic `node --test` suite:** Drives `MoveExplainer` end-to-end
  with `FakeEngineTransport` (via a lightweight `AnalysisProvider`
  wrapper) + `FakeProvider`. Asserts the citation carries the correct
  grounded eval and best-line citation for a known position.
- **Env-gated integration test:** Skips without an API key (exactly
  like M7's adapter tests). Runs the real path against a real provider
  to prove the wiring works beyond fakes.

### 5. Build integration

The package is added to the root `build`, `test`, `lint`, and `clean`
script chains in dependency order (after `ai-orchestrator`). The CI
workflow's test matrix runs it automatically via the root scripts. The
`scripts/test-counts.mjs` script includes it in the per-package count.

## Consequences

- Adding a new M8 feature requires only creating a new module in
  `packages/ai-features/src/`, following the same inject → engine →
  ground → AI → structured-output pattern.
- The `EngineCitation` type is shared across features that cite engine
  analysis, ensuring consistent citation structure.
- The package is dependency-free in the domain (only depends on
  `@chess-platform/engine`, `@chess-platform/ai-orchestrator`, and
  `@chess-platform/core`).
- All features are testable hermetically with fakes — no keys, no
  binary, no network.
- The feature layer never imports concrete provider or engine
  implementations; everything flows through injected ports.

### Non-Engine Data Sources (M8 Increment 4: Opening Explorer)

The Opening Explorer (increment 4) introduces the first non-engine data
source in M8: an `OpeningDatabase` port backed by a small, curated,
original bundled dataset. This generalises the established pattern:

- **New port type:** `OpeningDatabase` — given a move sequence, returns
  the deepest matching opening entry (ECO code, name, continuations,
  optional stats). The default implementation (`BundledOpeningDatabase`)
  ships a compact original dataset covering common openings.
- **Bundled dataset decision:** the dataset is authored from common
  chess knowledge (ECO codes and opening names are public-domain chess
  terminology), not scraped or embedded from a third-party licensed
  database. It is intentionally compact and extensible — a larger or
  live adapter can implement the same port later (M14-era
  infrastructure) without touching the feature.
- **Pattern generalisation:** the established pattern (verifiable
  structured facts from a trusted source, LLM text additive only) now
  applies to any data source, not just engine evals. Future data-backed
  features (endgame tablebase, game archive search, etc.) follow the
  same approach: define a port, ship a default adapter, inject it.
- **Optional engine enrichment:** the Opening Explorer can optionally
  enrich its result with engine eval (M5 `AnalysisProvider`), but the
  primary facts come from the `OpeningDatabase` port. This demonstrates
  that a feature can combine multiple data sources — each behind its
  own port — without coupling.
