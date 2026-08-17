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
 * What a *feature* needs: somewhere to send a completion request.
 *
 * Narrower than {@link AiProvider} on purpose. `AiOrchestrator` is the thing application code is
 * meant to depend on — it owns routing, failover, caching, rate limiting and, critically, the
 * rendering of {@link CompletionRequest.grounding} into prompt messages — but it is not an
 * `AiProvider` and never should be: it has no `id`, no capabilities to discover, and no health of
 * its own to report. Typing features against `AiProvider` therefore forced them to hold a single
 * raw vendor adapter, bypassing every one of those controls.
 *
 * Both satisfy this port, so a feature can be composed against the orchestrator in production and
 * against a `FakeProvider` in a hermetic test.
 *
 * **Implementations own grounding.** A feature passes structured facts on `grounding`; whatever is
 * behind this port decides how they reach the model. A bare provider does not render them, which is
 * why production composes the orchestrator.
 */
export interface CompletionPort {
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/**
 * The provider contract.  Every adapter (OpenAI, Anthropic, etc.) implements
 * this.  The orchestrator routes to providers, never calling them directly
 * from application code.
 */
export interface AiProvider extends CompletionPort {
  /** Stable, unique identifier (e.g. `"openai"`, `"anthropic"`). */
  readonly id: string;

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
