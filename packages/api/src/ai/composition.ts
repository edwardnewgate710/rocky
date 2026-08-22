/**
 * @packageDocumentation
 * Composition helpers for the AI subsystem behind Move Explanation (ADR-0115).
 *
 * Mirrors `analysis/composition.ts`: read the environment, build the subsystem only when this
 * deployment is actually configured for it, and return `undefined` otherwise so the capability
 * reports off and the route answers 503 rather than failing at request time.
 */

import type {
  AiProvider,
  ModelInfo,
  OrchestratorConfig,
  ProviderCapabilities,
} from '@chess-platform/ai-orchestrator';
import {
  AiOrchestrator,
  AnthropicAdapter,
  OpenAiCompatibleAdapter,
} from '@chess-platform/ai-orchestrator';
import { MoveExplainer } from '@chess-platform/ai-features';
import type { AnalysisPort } from '../analysis/service.js';
import { MoveExplanationService } from './move-explanation-service.js';

/**
 * Ceilings and budgets the server owns. None of these is reachable from a request body: the route
 * accepts a position and a move, and nothing else that could widen them.
 */
export interface AiSettings {
  /** Hard ceiling on generated tokens — the direct lever on per-request spend. */
  readonly maxOutputTokens: number;
  /** Per-provider wall-clock budget. The orchestrator aborts the provider call at this point. */
  readonly latencyBudgetMs: number;
  /**
   * Total provider attempts per HTTP request, including the first.
   *
   * The amplification bound. One request already costs two engine searches; without a cap here a
   * single request could also become an unbounded walk over every registered provider.
   */
  readonly maxFailoverAttempts: number;
  /** Sampling temperature. Low, because an explanation of a fixed engine fact is not creative work. */
  readonly temperature: number;
  /** Response-cache entry ceiling. */
  readonly cacheEntries: number;
  /** Response-cache TTL in ms. */
  readonly cacheTtlMs: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  maxOutputTokens: 512,
  latencyBudgetMs: 15_000,
  maxFailoverAttempts: 2,
  temperature: 0.3,
  cacheEntries: 500,
  cacheTtlMs: 300_000,
};

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') return defaultValue;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) return defaultValue;
  return num;
}

/**
 * Settings from the environment, each clamped to the compiled default as a ceiling.
 *
 * Env is configuration, not an escape hatch: `AI_MAX_OUTPUT_TOKENS=1000000` must not be able to
 * raise the ceiling this file publishes, only lower it. Same shape as `analysisLimitsPolicyFromEnv`.
 */
export function aiSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AiSettings {
  return {
    maxOutputTokens: Math.min(
      parsePositiveInt(env['AI_MAX_OUTPUT_TOKENS'], DEFAULT_AI_SETTINGS.maxOutputTokens),
      DEFAULT_AI_SETTINGS.maxOutputTokens,
    ),
    latencyBudgetMs: Math.min(
      parsePositiveInt(env['AI_LATENCY_BUDGET_MS'], DEFAULT_AI_SETTINGS.latencyBudgetMs),
      DEFAULT_AI_SETTINGS.latencyBudgetMs,
    ),
    maxFailoverAttempts: Math.min(
      parsePositiveInt(env['AI_MAX_FAILOVER_ATTEMPTS'], DEFAULT_AI_SETTINGS.maxFailoverAttempts),
      DEFAULT_AI_SETTINGS.maxFailoverAttempts,
    ),
    temperature: DEFAULT_AI_SETTINGS.temperature,
    // Clamped like the rest, and for the same reason the others are: this file documents every
    // setting as capped at its compiled default, and two that were not made the claim false. An
    // oversized `AI_CACHE_ENTRIES` is unbounded memory held by an in-process LRU, and an oversized
    // `AI_CACHE_TTL_MS` serves an explanation long after the engine that grounded it was replaced.
    // Raised in the Qodo review of PR #134.
    cacheEntries: Math.min(
      parsePositiveInt(env['AI_CACHE_ENTRIES'], DEFAULT_AI_SETTINGS.cacheEntries),
      DEFAULT_AI_SETTINGS.cacheEntries,
    ),
    cacheTtlMs: Math.min(
      parsePositiveInt(env['AI_CACHE_TTL_MS'], DEFAULT_AI_SETTINGS.cacheTtlMs),
      DEFAULT_AI_SETTINGS.cacheTtlMs,
    ),
  };
}

/**
 * Capabilities as *configuration*, never as discovery.
 *
 * `AiOrchestrator.registerProvider` calls `provider.discoverCapabilities()`, and the OpenAI-
 * compatible adapter implements that by listing models over HTTP when no static list is supplied.
 * Registering that way would make process start-up depend on a third-party API being reachable, and
 * would make `createPgDependencies` async for the sake of a network round-trip whose answer we
 * already know. `ProviderRegistry.register` takes the capabilities directly and is synchronous, so
 * composition stays a pure function of the environment and boot does no I/O at all.
 *
 * Costs are declared as zero because this file has no trustworthy price list, and a made-up one
 * would silently drive the router's cost ceiling. See ADR-0115 on why the cost ceiling is left off
 * rather than given a fictional basis.
 */
function staticCapabilities(
  provider: AiProvider,
  displayName: string,
  model: string,
  local: boolean,
): ProviderCapabilities {
  const models: readonly ModelInfo[] = [
    {
      id: model,
      displayName: model,
      contextWindow: 128_000,
      inputCostPerMtMicroUsd: 0,
      outputCostPerMtMicroUsd: 0,
      maxOutputTokens: DEFAULT_AI_SETTINGS.maxOutputTokens,
    },
  ];
  return {
    providerId: provider.id,
    displayName,
    modalities: ['text'],
    // Empty means "every task class", which is what the registry documents and what a general
    // text model actually is. Narrowing it here would only be a second place to keep in sync.
    taskClasses: [],
    supportsStreaming: true,
    supportsStructured: true,
    supportsEmbeddings: false,
    supportsCancellation: true,
    models,
    maxContextTokens: 128_000,
    local,
  };
}

interface ConfiguredProvider {
  readonly provider: AiProvider;
  readonly capabilities: ProviderCapabilities;
  readonly priority: number;
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  return text === '' ? undefined : text;
}

/**
 * The providers this deployment has credentials for, in priority order.
 *
 * A missing key means the provider is not registered at all — not registered-and-failing. The
 * difference matters: an unregistered provider cannot be routed to, so a deployment with no AI
 * configuration composes no subsystem and advertises no capability, instead of advertising one that
 * answers 401 from a vendor on every call.
 *
 * One adapter covers OpenAI, DeepSeek, OpenRouter and a local Ollama, because they share a wire
 * format and differ only by `baseUrl` — so `AI_OPENAI_BASE_URL` is the whole of that support and no
 * per-vendor code exists to drift.
 */
export function configuredAiProviders(env: NodeJS.ProcessEnv): readonly ConfiguredProvider[] {
  const configured: ConfiguredProvider[] = [];

  const openAiKey = trimmed(env['AI_OPENAI_API_KEY']);
  const openAiBaseUrl = trimmed(env['AI_OPENAI_BASE_URL']);
  // A local Ollama needs a base URL but no key, so either one is enough to mean "configured".
  if (openAiKey !== undefined || openAiBaseUrl !== undefined) {
    const model = trimmed(env['AI_OPENAI_MODEL']) ?? 'gpt-4o-mini';
    const provider = new OpenAiCompatibleAdapter({
      id: 'openai',
      ...(openAiKey !== undefined ? { apiKey: openAiKey } : {}),
      ...(openAiBaseUrl !== undefined ? { baseUrl: openAiBaseUrl } : {}),
      defaultModel: model,
      local: openAiKey === undefined,
    });
    configured.push({
      provider,
      capabilities: staticCapabilities(provider, 'OpenAI-compatible', model, openAiKey === undefined),
      priority: 0,
    });
  }

  const anthropicKey = trimmed(env['AI_ANTHROPIC_API_KEY']);
  if (anthropicKey !== undefined) {
    const model = trimmed(env['AI_ANTHROPIC_MODEL']) ?? 'claude-sonnet-4-5';
    const provider = new AnthropicAdapter({
      apiKey: anthropicKey,
      defaultModel: model,
    });
    configured.push({
      provider,
      capabilities: staticCapabilities(provider, 'Anthropic', model, false),
      priority: 1,
    });
  }

  return configured;
}

/**
 * The AI subsystem as the composition root holds it.
 *
 * There is no `shutdown` here, and that is a finding rather than an omission: nothing in
 * `@chess-platform/ai-orchestrator` owns a resource that outlives a request. It starts no interval
 * (`HealthTracker` compares timestamps instead of holding a timer), keeps no pool, and the one
 * `setTimeout` in `AiOrchestrator.completeWithTimeout` is cleared in a `finally`. The adapters use
 * global `fetch`. Adding a shutdown handle would create an unreachable one and imply a lifecycle
 * that does not exist; if an adapter ever acquires persistent state, this is the type that grows a
 * handle and `bootstrap.ts` is where it gets called.
 */
export interface AiComposition {
  readonly orchestrator: AiOrchestrator;
  readonly settings: AiSettings;
}

/**
 * Build the AI subsystem, or `undefined` when no provider is configured.
 *
 * `undefined` is the load-bearing case: it leaves `deps.moveExplanation` unset, which makes
 * `GET /v1/capabilities` report `moveExplanation: false` and the route answer 503. There is no
 * fallback to a default vendor — a deployment that did not ask for an external AI provider must not
 * acquire one by starting up.
 */
export function createAiFromEnv(env: NodeJS.ProcessEnv = process.env): AiComposition | undefined {
  const providers = configuredAiProviders(env);
  if (providers.length === 0) return undefined;

  const settings = aiSettingsFromEnv(env);
  const config: OrchestratorConfig = {
    // The orchestrator does not construct providers from this list — `ProviderConfig` describes
    // them for callers that build their own. We register constructed adapters directly below, so
    // duplicating their settings here would be a second source of truth that nothing reads.
    providers: [],
    routing: {
      strategy: 'priority',
      failoverEnabled: providers.length > 1,
      maxFailoverAttempts: settings.maxFailoverAttempts,
      defaultLatencyBudgetMs: settings.latencyBudgetMs,
      defaultCostCeiling: 0,
    },
    cache: {
      enabled: true,
      maxEntries: settings.cacheEntries,
      ttlMs: settings.cacheTtlMs,
    },
  };

  const orchestrator = new AiOrchestrator({ config });
  for (const entry of providers) {
    orchestrator.registry.register(entry.provider, entry.capabilities, {
      priority: entry.priority,
    });
  }

  return { orchestrator, settings };
}

/**
 * Assemble Move Explanation from the two subsystems it borrows.
 *
 * Note what is *not* passed to `MoveExplainer`: an engine. It is composed against the orchestrator
 * for completions and against nothing at all for analysis, so the only path to a chess engine in
 * this process remains the one `AnalysisService` owns. A second pool is not prevented here by
 * convention or by review — there is no parameter through which one could arrive.
 *
 * `temperature` and `maxTokens` are fixed at composition time for the same reason: the request body
 * has no field that reaches them, so no caller can raise the token ceiling that bounds per-request
 * spend.
 */
export function createMoveExplanation(
  ai: AiComposition,
  analysis: AnalysisPort,
): MoveExplanationService {
  const explainer = new MoveExplainer({
    ai: ai.orchestrator,
    defaultVariant: 'standard',
    temperature: ai.settings.temperature,
    maxTokens: ai.settings.maxOutputTokens,
  });
  return new MoveExplanationService({ analysis, explainer });
}
