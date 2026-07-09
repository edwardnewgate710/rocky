/**
 * Provider registry.  Holds registered providers, their discovered
 * capabilities, and health trackers.  The registry is the single source
 * of truth for "which providers exist and what can they do?"
 */

import type { AiProvider } from './provider.js';
import type { ProviderCapabilities, ProviderHealth } from './types.js';
import type { CircuitBreakerConfig } from './config.js';
import { HealthTracker } from './health.js';

export interface RegisteredProvider {
  readonly provider: AiProvider;
  readonly capabilities: ProviderCapabilities;
  readonly healthTracker: HealthTracker;
  readonly priority: number;
  readonly enabled: boolean;
}

/**
 * The provider registry.  Providers are registered at startup with their
 * discovered capabilities.  The registry exposes lookups by id, by
 * capability, and by task class.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();

  /** Register a provider with pre-discovered capabilities. */
  register(
    provider: AiProvider,
    capabilities: ProviderCapabilities,
    options?: { priority?: number; enabled?: boolean; breakerConfig?: CircuitBreakerConfig },
  ): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered.`);
    }
    this.providers.set(provider.id, {
      provider,
      capabilities,
      healthTracker: new HealthTracker(undefined, options?.breakerConfig),
      priority: options?.priority ?? 100,
      enabled: options?.enabled ?? true,
    });
  }

  /** Unregister a provider. */
  unregister(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  /** Get a registered provider by id. */
  get(providerId: string): RegisteredProvider | undefined {
    return this.providers.get(providerId);
  }

  /** Get all registered providers (enabled first, then by priority). */
  all(): readonly RegisteredProvider[] {
    return [...this.providers.values()]
      .filter((p) => p.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  /** Get providers that support a given task class. */
  byTaskClass(taskClass: string): readonly RegisteredProvider[] {
    return this.all().filter((p) =>
      p.capabilities.taskClasses.length === 0 ||
      p.capabilities.taskClasses.includes(taskClass as never),
    );
  }

  /** Get providers that support a given modality. */
  byModality(modality: string): readonly RegisteredProvider[] {
    return this.all().filter((p) =>
      p.capabilities.modalities.includes(modality as never),
    );
  }

  /** Get providers that support streaming. */
  streamingCapable(): readonly RegisteredProvider[] {
    return this.all().filter((p) => p.capabilities.supportsStreaming);
  }

  /** Get providers that support structured responses. */
  structuredCapable(): readonly RegisteredProvider[] {
    return this.all().filter((p) => p.capabilities.supportsStructured);
  }

  /** Get providers that support embeddings. */
  embeddingCapable(): readonly RegisteredProvider[] {
    return this.all().filter((p) => p.capabilities.supportsEmbeddings);
  }

  /** Get health snapshots for all providers. */
  healthSnapshots(): readonly ProviderHealth[] {
    return this.all().map((p) => p.healthTracker.snapshot(p.provider.id));
  }

  /** Check if a provider's circuit breaker is open. */
  isCircuitOpen(providerId: string): boolean {
    const entry = this.providers.get(providerId);
    return entry ? entry.healthTracker.isCircuitOpen() : true;
  }

  /** Record a successful request for a provider. */
  recordSuccess(providerId: string, latencyMs: number): void {
    this.providers.get(providerId)?.healthTracker.recordSuccess(latencyMs);
  }

  /** Record a failed request for a provider. */
  recordFailure(providerId: string, errorMessage?: string): void {
    this.providers.get(providerId)?.healthTracker.recordFailure(errorMessage);
  }

  /** Number of registered providers. */
  get size(): number {
    return this.providers.size;
  }
}
