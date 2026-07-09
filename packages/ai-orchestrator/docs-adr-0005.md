# ADR-0005: AI Orchestration Layer

> **Status:** Accepted  
> **Date:** 2026-07-08  
> **Supersedes:** None  
> **Related:** ADR-0002 (Engine Bridge), ARCHITECTURE.md §6

## Context

Milestone 7 introduces the AI orchestration layer — the architectural
foundation for every AI capability (coach, move explanation, analysis,
puzzles, commentary, etc.). The layer must support multiple LLM
providers (OpenAI, Anthropic, Google, DeepSeek, OpenRouter, Ollama)
without coupling business logic to any single vendor.

The existing `@chess-platform/engine` package (M5) established the
pattern: a top-level `AnalysisProvider` abstraction, an `EngineManager`
orchestrator, plugin-oriented registration, capability-based routing,
and a cache port. M7 mirrors this pattern for LLM providers.

## Decision

### 1. Single `AiProvider` interface

Every provider adapter implements one `AiProvider` interface with
`complete()`, `stream()`, `embed()`, `discoverCapabilities()`, and
`healthCheck()`. Application code depends on the orchestrator, never
on a specific provider.

### 2. Capability-based routing

Providers advertise capabilities (modalities, task classes, streaming,
structured responses, embeddings, models). The routing engine selects
providers by capability, not by name. This mirrors the M5
`EngineCapabilities` pattern.

### 3. Plugin-oriented registration

Providers are registered at startup. The registry discovers
capabilities, creates health trackers, and exposes lookups. Adding a
new provider requires no changes to callers or the router.

### 4. Automatic failover

When a provider fails (timeout, error, rate limit), the orchestrator
automatically tries the next compatible provider. Non-retryable errors
(auth failures, content filters) abort immediately. The circuit breaker
opens after consecutive failures and resets after a cooldown.

### 5. Response cache port

Caching is behind a `ResponseCache` port with an in-process LRU default.
Redis and Postgres are future implementations of the same interface.
Cache keys are (task, model, messageHash, groundingHash, temperature).

### 6. Engine-grounded prompting

Chess-reasoning prompts are grounded with structured engine facts
(FEN, eval, best line, legal moves). The grounding module converts
`EngineGrounding` into provider-agnostic system messages. No
provider-specific prompt templates — every provider receives the same
grounded context.

### 7. Benchmark framework

A `BenchmarkRunner` executes curated chess tasks against providers and
produces a report with latency, success rate, token usage, cost, and
quality scores. Reports can inform routing weights.

### 8. Rate limiting

A sliding-window rate limiter enforces per-user and global limits.
The limiter is configurable and can be disabled.

## Consequences

- Adding a new LLM provider requires only implementing `AiProvider`
  and registering it — no changes to callers, router, or cache.
- The orchestrator is testable with `FakeProvider` (deterministic,
  no network calls).
- All secrets (API keys) are externalised in configuration — never
  hardcoded.
- The package is dependency-free (no `openai`, `@anthropic-ai/sdk`,
  etc. in the domain). Provider-specific HTTP clients live in adapter
  modules that import SDK packages only in their `devDependencies`.
- Future milestones (M8 AI features) build thin task definitions over
  this layer.
