# @chess-platform/ai-orchestrator

Provider-agnostic AI orchestration layer for the Gambit chess platform.

## Overview

This package provides the architectural foundation for every AI capability
(coach, move explanation, analysis, puzzles, commentary, etc.). It
abstracts multiple LLM providers (OpenAI, Anthropic, Google, DeepSeek,
OpenRouter, Ollama) behind a single `AiProvider` interface, with
capability-based routing, automatic failover, response caching, rate
limiting, health monitoring, and engine-grounded prompting.

## Architecture

```
AiOrchestrator          ← what callers depend on (complete/stream/embed)
   ▲
   ├── ProviderRegistry     ← registered providers + capabilities + health
   ├── RoutingStrategy      ← selects provider by capability/priority/cost
   ├── ResponseCache        ← LRU cache (port; Redis/Postgres future)
   ├── RateLimiter          ← per-user + global token bucket
   ├── HealthTracker        ← rolling window + circuit breaker
   └── BenchmarkRunner      ← curated chess tasks → report
```

## Key design decisions

- **Dependency-free domain.** No `openai`, `@anthropic-ai/sdk`, etc.
  in the core package. Provider adapters import SDKs only in their own
  modules.
- **Capability-based routing.** The router checks capabilities, not
  provider names. Adding a provider requires no router changes.
- **Automatic failover.** When a provider fails, the orchestrator tries
  the next compatible provider. Non-retryable errors abort immediately.
- **Engine grounding.** Chess-reasoning prompts are grounded with
  structured engine facts (FEN, eval, best line). No provider-specific
  prompt templates.
- **Cache port.** In-process LRU default; Redis/Postgres are future
  implementations of the same interface.

## Usage

```typescript
import { AiOrchestrator, FakeProvider } from '@chess-platform/ai-orchestrator';

const orch = new AiOrchestrator();
await orch.registerProvider(new FakeProvider({ id: 'test' }));

const response = await orch.complete({
  task: 'explanation',
  messages: [{ role: 'user', content: 'Why is e4 good?' }],
  grounding: { fen: '...', evalCp: 20, depth: 15, bestLine: ['e7e5'] },
});
```

## HTTP Adapters

### OpenAI-Compatible Adapter

Covers OpenAI, DeepSeek, OpenRouter, and Ollama via configurable `baseUrl`:

```typescript
import { OpenAiCompatibleAdapter } from '@chess-platform/ai-orchestrator';

const adapter = new OpenAiCompatibleAdapter({
  id: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  defaultModel: 'gpt-4o-mini',
});
```

### Anthropic Adapter

```typescript
import { AnthropicAdapter } from '@chess-platform/ai-orchestrator';

const adapter = new AnthropicAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultModel: 'claude-3-5-sonnet-20241022',
});
```

## Engine Grounding Integration

```typescript
import { engineResultsToGrounding } from '@chess-platform/ai-orchestrator';

// Convert engine analysis results to grounding context
const grounding = engineResultsToGrounding(fen, engineResults, moveUci);
```

## Testing

```bash
npm test   # runs all tests via node --test
```

Tests use `FakeProvider` for deterministic, hermetic testing — no
network calls, no API keys required.
