/**
 * `@chess-platform/ai-orchestrator` — provider-agnostic AI orchestration layer.
 *
 * Public surface, layered top-down: {@link AiOrchestrator} (what callers
 * depend on) → {@link AiProvider} (the provider contract) →
 * {@link ProviderRegistry} + {@link RoutingStrategyImpl} + {@link ResponseCache}
 * + {@link RateLimiter} + {@link HealthTracker} + {@link BenchmarkRunner}.
 */

// Value types & enums
export type {
  TaskClass,
  Modality,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  Message,
  EngineGrounding,
  EnginePvLine,
  CompletionRequest,
  CompletionResponse,
  TokenUsage,
  FinishReason,
  StreamChunk,
  EmbedRequest,
  EmbedResponse,
  ProviderCapabilities,
  ModelInfo,
  HealthState,
  ProviderHealth,
  OrchestratorHealth,
  JsonSchema,
  ReadonlyRecord,
} from './types.js';

// Errors
export {
  AiError,
  ProviderUnavailableError,
  ProviderTimeoutError,
  ProviderError,
  RateLimitedError,
  AuthFailedError,
  InvalidResponseError,
  ContextTooLongError,
  ContentFilteredError,
  NoProviderError,
  CircuitOpenError,
  CancelledError,
  BudgetExceededError,
  SchemaValidationError,
  ConfigError,
} from './errors.js';
export type { AiErrorCode } from './errors.js';

// Provider contract
export type { AiProvider, CompletionPort } from './provider.js';

// Configuration
export type {
  ProviderConfig,
  RoutingConfig,
  RoutingStrategy,
  CacheConfig,
  RateLimitConfig,
  CircuitBreakerConfig,
  HealthConfig,
  BenchmarkConfig,
  OrchestratorConfig,
} from './config.js';
export { DEFAULTS } from './config.js';

// Cache
export type { ResponseCache, CacheKey, CacheEntry } from './cache.js';
export { NullCache, InMemoryLruCache, buildCacheKey, hashString, isExpired } from './cache.js';

// Health
export { HealthTracker } from './health.js';

// Registry
export { ProviderRegistry } from './registry.js';
export type { RegisteredProvider } from './registry.js';

// Routing
export type { RoutingDecision, RoutingContext, RoutingStrategyImpl } from './router.js';
export { PriorityStrategy, WeightedStrategy, RoundRobinStrategy, createStrategy } from './router.js';

// Rate limiter
export { RateLimiter } from './rate-limiter.js';

// Grounding
export { buildGroundedMessages, formatGrounding, positionHash } from './grounding.js';

// Benchmark
export type { BenchmarkTask, TaskResult, BenchmarkReport, ProviderSummary } from './benchmark.js';
export { BenchmarkRunner, CHESS_BENCHMARK_TASKS } from './benchmark.js';

// Orchestrator
export { AiOrchestrator } from './orchestrator.js';
export type { OrchestratorOptions } from './orchestrator.js';

// Fake provider (for testing)
export { FakeProvider } from './fake-provider.js';
export type { FakeProviderOptions } from './fake-provider.js';

// OpenAI-compatible HTTP adapter (covers OpenAI, DeepSeek, OpenRouter, Ollama)
export { OpenAiCompatibleAdapter } from './openai-adapter.js';
export type { OpenAiCompatibleOptions } from './openai-adapter.js';

// Anthropic HTTP adapter
export { AnthropicAdapter } from './anthropic-adapter.js';
export type { AnthropicAdapterOptions } from './anthropic-adapter.js';

// Engine grounding integration (bridge to @chess-platform/engine)
export { engineResultsToGrounding, evalToString } from './engine-grounding.js';
