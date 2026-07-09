/**
 * Configuration types for the AI orchestrator.  All secrets and URLs are
 * externalised — never hardcoded.  Configuration is injected at the
 * composition root.
 */

import type { TaskClass, ReadonlyRecord } from './types.js';

/** Configuration for a single provider. */
export interface ProviderConfig {
  /** Provider id (e.g. `"openai"`, `"anthropic"`). */
  readonly id: string;
  /** API key (injected from environment, never hardcoded). */
  readonly apiKey?: string;
  /** Base URL override (e.g. for OpenRouter or self-hosted endpoints). */
  readonly baseUrl?: string;
  /** Default model to use for this provider. */
  readonly defaultModel?: string;
  /** Priority (lower = higher priority, 0 = highest). */
  readonly priority?: number;
  /** Whether the provider is enabled. */
  readonly enabled?: boolean;
  /** Per-provider timeout in ms. */
  readonly timeoutMs?: number;
  /** Max retries within this provider before failover. */
  readonly maxRetries?: number;
  /** Extra provider-specific options. */
  readonly options?: ReadonlyRecord<string, string | number | boolean>;
}

/** Routing configuration. */
export interface RoutingConfig {
  /** Default strategy: `"priority"` (try in order) or `"weighted"` (by score). */
  readonly strategy?: RoutingStrategy;
  /** Whether failover is enabled. */
  readonly failoverEnabled?: boolean;
  /** Max failover attempts before giving up. */
  readonly maxFailoverAttempts?: number;
  /** Default latency budget in ms (applies when request doesn't specify one). */
  readonly defaultLatencyBudgetMs?: number;
  /** Default cost ceiling in micro-dollars (0 = no ceiling). */
  readonly defaultCostCeiling?: number;
  /** Per-task-class priority overrides (task → ordered provider ids). */
  readonly taskPriorities?: ReadonlyRecord<TaskClass, readonly string[]>;
}

export type RoutingStrategy = 'priority' | 'weighted' | 'round_robin';

/** Cache configuration. */
export interface CacheConfig {
  /** Whether caching is enabled. */
  readonly enabled?: boolean;
  /** Max entries in the LRU cache. */
  readonly maxEntries?: number;
  /** TTL in ms (0 = no expiry). */
  readonly ttlMs?: number;
}

/** Rate-limit configuration. */
export interface RateLimitConfig {
  /** Whether rate limiting is enabled. */
  readonly enabled?: boolean;
  /** Max requests per user per minute. */
  readonly perUserPerMinute?: number;
  /** Max requests globally per minute. */
  readonly globalPerMinute?: number;
}

/** Circuit-breaker configuration. */
export interface CircuitBreakerConfig {
  /** Failure threshold to open the circuit. */
  readonly failureThreshold?: number;
  /** Time to wait before trying again (ms). */
  readonly resetTimeoutMs?: number;
  /** Successes needed to close the circuit. */
  readonly successThreshold?: number;
}

/** Health-monitor configuration. */
export interface HealthConfig {
  /** Interval between health checks in ms. */
  readonly checkIntervalMs?: number;
  /** Window size for rolling stats. */
  readonly windowSize?: number;
}

/** Benchmark configuration. */
export interface BenchmarkConfig {
  /** Number of warmup iterations (not measured). */
  readonly warmupIterations?: number;
  /** Number of measured iterations. */
  readonly measuredIterations?: number;
  /** Timeout per iteration in ms. */
  readonly timeoutMs?: number;
}

/** Top-level orchestrator configuration. */
export interface OrchestratorConfig {
  readonly providers: readonly ProviderConfig[];
  readonly routing?: RoutingConfig;
  readonly cache?: CacheConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly circuitBreaker?: CircuitBreakerConfig;
  readonly health?: HealthConfig;
  readonly benchmark?: BenchmarkConfig;
}

/** Default configuration values. */
export const DEFAULTS = {
  routing: {
    strategy: 'priority' as const,
    failoverEnabled: true,
    maxFailoverAttempts: 3,
    defaultLatencyBudgetMs: 30_000,
    defaultCostCeiling: 0,
  },
  cache: {
    enabled: true,
    maxEntries: 1_000,
    ttlMs: 300_000, // 5 minutes
  },
  rateLimit: {
    enabled: true,
    perUserPerMinute: 20,
    globalPerMinute: 500,
  },
  circuitBreaker: {
    failureThreshold: 5,
    resetTimeoutMs: 60_000,
    successThreshold: 2,
  },
  health: {
    checkIntervalMs: 60_000,
    windowSize: 50,
  },
  benchmark: {
    warmupIterations: 1,
    measuredIterations: 3,
    timeoutMs: 60_000,
  },
} as const;


