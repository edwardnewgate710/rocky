/**
 * The top-level abstraction every caller depends on.  Callers ask for a
 * completion, stream, or embedding by *intent* — they never know whether
 * OpenAI, Anthropic, Google, DeepSeek, OpenRouter, or Ollama served it.
 *
 * This mirrors the M5 `AnalysisProvider` pattern: a single interface,
 * multiple implementations behind it, capability-based routing above.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  EmbedRequest,
  EmbedResponse,
  ProviderCapabilities,
  StreamChunk,
} from './types.js';

/**
 * The provider contract.  Every adapter (OpenAI, Anthropic, etc.) implements
 * this.  The orchestrator routes to providers, never calling them directly
 * from application code.
 */
export interface AiProvider {
  /** Stable, unique identifier (e.g. `"openai"`, `"anthropic"`). */
  readonly id: string;

  /**
   * Generate a completion.  Throws {@link AiError} on failure.
   * The orchestrator handles retry/failover — providers should fail fast.
   */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Stream a completion.  Yields chunks in order, ending with a `done` or
   * `error` chunk.  If the provider does not support streaming, throw
   * `AiError('provider_error', ...)`.
   */
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;

  /**
   * Generate an embedding.  Throws if the provider does not support embeddings.
   */
  embed(request: EmbedRequest): Promise<EmbedResponse>;

  /**
   * Discover capabilities.  Called once at registration and then cached
   * by the registry.  May involve an API call (e.g. listing models).
   */
  discoverCapabilities(): Promise<ProviderCapabilities>;

  /**
   * Lightweight health check.  Returns true if the provider is reachable.
   * Called periodically by the health monitor.
   */
  healthCheck(): Promise<boolean>;
}
