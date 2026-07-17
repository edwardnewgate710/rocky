/**
 * The AI orchestrator — the top-level object callers depend on.
 *
 * It owns the provider registry, routing engine, cache, rate limiter,
 * and health monitoring.  Callers call `complete()`, `stream()`, or
 * `embed()` and the orchestrator handles routing, failover, caching,
 * rate limiting, and health tracking transparently.
 *
 * This mirrors the M5 `EngineManager` pattern: one object, capability-
 * based routing, automatic failover, health-aware scheduling.
 */

import type { AiProvider } from './provider.js';
import type {
  CompletionRequest,
  CompletionResponse,
  EmbedRequest,
  EmbedResponse,
  OrchestratorHealth,
  StreamChunk,
} from './types.js';
import type { OrchestratorConfig, RoutingConfig, CircuitBreakerConfig } from './config.js';
import { DEFAULTS } from './config.js';
import { ProviderRegistry } from './registry.js';
import { createStrategy, type RoutingStrategyImpl } from './router.js';
import {
  InMemoryLruCache,
  NullCache,
  buildCacheKey,
  isExpired,
  type ResponseCache,
} from './cache.js';
import { RateLimiter } from './rate-limiter.js';
import { buildGroundedMessages } from './grounding.js';
import {
  AiError,
  CancelledError,
  NoProviderError,
  ProviderTimeoutError,
} from './errors.js';

export interface OrchestratorOptions {
  readonly config?: OrchestratorConfig;
  readonly cache?: ResponseCache;
  readonly clock?: () => number;
}

/**
 * The orchestrator.  Created once at the composition root and injected
 * wherever AI capabilities are needed.
 */
export class AiOrchestrator {
  readonly registry: ProviderRegistry;
  private readonly routingConfig: {
    readonly strategy: NonNullable<RoutingConfig['strategy']>;
    readonly failoverEnabled: boolean;
    readonly maxFailoverAttempts: number;
    readonly defaultLatencyBudgetMs: number;
    readonly defaultCostCeiling: number;
  };
  private readonly strategy: RoutingStrategyImpl;
  private readonly cache: ResponseCache;
  private readonly rateLimiter: RateLimiter;
  private readonly clock: () => number;
  private readonly breakerConfig?: CircuitBreakerConfig;
  private totalRequests = 0;
  private totalCacheHits = 0;
  private totalFailovers = 0;

  constructor(options?: OrchestratorOptions) {
    const config = options?.config;
    this.routingConfig = {
      strategy: config?.routing?.strategy ?? DEFAULTS.routing.strategy,
      failoverEnabled: config?.routing?.failoverEnabled ?? DEFAULTS.routing.failoverEnabled,
      maxFailoverAttempts: config?.routing?.maxFailoverAttempts ?? DEFAULTS.routing.maxFailoverAttempts,
      defaultLatencyBudgetMs: config?.routing?.defaultLatencyBudgetMs ?? DEFAULTS.routing.defaultLatencyBudgetMs,
      defaultCostCeiling: config?.routing?.defaultCostCeiling ?? DEFAULTS.routing.defaultCostCeiling,
    };
    this.strategy = createStrategy(this.routingConfig.strategy);
    this.registry = new ProviderRegistry();
    this.breakerConfig = config?.circuitBreaker;

    const cacheConfig = config?.cache;
    if (cacheConfig?.enabled === false) {
      this.cache = new NullCache();
    } else {
      this.cache = options?.cache ?? new InMemoryLruCache(
        cacheConfig?.maxEntries ?? DEFAULTS.cache.maxEntries,
        cacheConfig?.ttlMs ?? DEFAULTS.cache.ttlMs,
      );
    }

    this.rateLimiter = new RateLimiter(config?.rateLimit);
    this.clock = options?.clock ?? (() => Date.now());
  }

  /**
   * Register a provider.  Capabilities are discovered automatically.
   */
  async registerProvider(
    provider: AiProvider,
    options?: { priority?: number; enabled?: boolean },
  ): Promise<void> {
    const capabilities = await provider.discoverCapabilities();
    this.registry.register(provider, capabilities, {
      priority: options?.priority,
      enabled: options?.enabled,
      breakerConfig: this.breakerConfig,
    });
  }

  /**
   * Generate a completion.  Handles routing, failover, caching, rate
   * limiting, and health tracking.
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (request.signal?.aborted) throw new CancelledError();

    this.rateLimiter.check(request.userId);
    this.totalRequests++;

    // Build grounded messages if grounding is provided.
    const effectiveRequest: CompletionRequest = request.grounding
      ? { ...request, messages: buildGroundedMessages(request.messages, request.grounding) }
      : request;

    // Check cache.
    const cacheKey = buildCacheKey(effectiveRequest);
    const cached = await this.cache.get(cacheKey);
    if (cached && !isExpired(cached, this.clock())) {
      this.totalCacheHits++;
      return { ...cached.response, cached: true };
    }

    // Route + execute with failover.
    const response = await this.executeWithFailover(effectiveRequest);

    // Cache the response (skip streaming requests).
    if (!request.stream) {
      await this.cache.set(cacheKey, response);
    }

    return response;
  }

  /**
   * Stream a completion.  Handles routing and failover (on initial
   * connection only — mid-stream failover is not supported).
   */
  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    if (request.signal?.aborted) {
      yield { type: 'error', error: new CancelledError() };
      return;
    }

    this.rateLimiter.check(request.userId);
    this.totalRequests++;

    const effectiveRequest: CompletionRequest = {
      ...request,
      stream: true,
      ...(request.grounding
        ? { messages: buildGroundedMessages(request.messages, request.grounding) }
        : {}),
    };

    const decision = this.route(effectiveRequest, []);
    try {
      for await (const chunk of decision.provider.provider.stream(effectiveRequest)) {
        yield chunk;
        if (chunk.type === 'done') {
          this.registry.recordSuccess(decision.provider.provider.id, chunk.response.latencyMs);
        }
      }
    } catch (err) {
      this.registry.recordFailure(decision.provider.provider.id, (err as Error).message);
      throw err;
    }
  }

  /**
   * Generate an embedding.  Routes to an embedding-capable provider.
   */
  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    if (request.signal?.aborted) throw new CancelledError();
    this.rateLimiter.check(request.userId);

    const providers = this.registry.embeddingCapable();
    if (providers.length === 0) {
      throw new NoProviderError('No embedding-capable provider registered.');
    }
    for (const entry of providers) {
      if (this.registry.isCircuitOpen(entry.provider.id)) continue;
      try {
        const response = await entry.provider.embed(request);
        this.registry.recordSuccess(entry.provider.id, response.latencyMs);
        return response;
      } catch (err) {
        this.registry.recordFailure(entry.provider.id, (err as Error).message);
        if (err instanceof AiError && !err.retryable) throw err;
        // Try next provider.
      }
    }
    throw new NoProviderError('All embedding-capable providers failed.');
  }

  /** Get orchestrator health. */
  health(): OrchestratorHealth {
    return {
      providers: this.registry.healthSnapshots(),
      totalRequests: this.totalRequests,
      totalCacheHits: this.totalCacheHits,
      totalFailovers: this.totalFailovers,
    };
  }

  /** Clear the response cache. */
  clearCache(): void {
    this.cache.clear();
  }

  // -----------------------------------------------------------------------
  // Internal: routing + failover
  // -----------------------------------------------------------------------

  private route(
    request: CompletionRequest,
    tried: readonly string[],
  ): ReturnType<RoutingStrategyImpl['route']> {
    return this.strategy.route({
      request,
      registry: this.registry,
      triedProviderIds: tried,
      config: this.routingConfig,
    });
  }

  private async executeWithFailover(
    request: CompletionRequest,
  ): Promise<CompletionResponse> {
    const tried: string[] = [];
    const maxAttempts = this.routingConfig.failoverEnabled
      ? this.routingConfig.maxFailoverAttempts
      : 1;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (request.signal?.aborted) throw new CancelledError();

      let decision;
      try {
        decision = this.route(request, tried);
      } catch (err) {
        // No more providers to try.
        if (lastError) throw lastError;
        if (err instanceof AiError && err.code === 'no_provider') throw new NoProviderError(err.message);
        throw err;
      }

      const providerId = decision.provider.provider.id;
      const timeoutMs = request.latencyBudgetMs ?? this.routingConfig.defaultLatencyBudgetMs;

      try {
        const response = await this.completeWithTimeout(
          decision.provider.provider,
          request,
          timeoutMs,
          providerId,
        );
        this.registry.recordSuccess(providerId, response.latencyMs);
        return { ...response, cached: false };
      } catch (err) {
        const aiErr = err as AiError;
        this.registry.recordFailure(providerId, aiErr.message);
        lastError = aiErr;
        tried.push(providerId);
        if (attempt < maxAttempts - 1) {
          this.totalFailovers++;
        }
        // Non-retryable errors abort immediately.
        if (aiErr instanceof AiError && !aiErr.retryable) {
          throw aiErr;
        }
        // Continue to next provider.
      }
    }

    throw lastError ?? new NoProviderError('All providers exhausted.');
  }

  private async completeWithTimeout(
    provider: AiProvider,
    request: CompletionRequest,
    ms: number,
    providerId: string,
  ): Promise<CompletionResponse> {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', forwardAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const providerPromise = provider.complete({ ...request, signal: controller.signal });
      return await Promise.race([
        providerPromise,
        new Promise<CompletionResponse>((_, reject) => {
          timer = setTimeout(
            () => {
              controller.abort(new ProviderTimeoutError(providerId, ms));
              reject(new ProviderTimeoutError(providerId, ms));
            },
            ms,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
