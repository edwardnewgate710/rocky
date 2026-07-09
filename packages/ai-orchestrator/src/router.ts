/**
 * Routing engine.  Selects a provider for a given request based on:
 * - availability (circuit breaker, health state)
 * - configured priority
 * - supported capabilities (task class, modality, streaming, structured)
 * - latency budget
 * - cost ceiling
 * - user preference (soft hint)
 * - retry state (which providers have already been tried)
 *
 * The routing strategy is replaceable without changing callers.
 */

import type { ProviderRegistry, RegisteredProvider } from './registry.js';
import type { CompletionRequest, ModelInfo } from './types.js';
import type { RoutingConfig, RoutingStrategy } from './config.js';
import { AiError } from './errors.js';

/** Result of a routing decision. */
export interface RoutingDecision {
  readonly provider: RegisteredProvider;
  readonly model: ModelInfo | undefined;
  readonly attempt: number;
  readonly triedProviderIds: readonly string[];
}

/** Context passed to a routing strategy. */
export interface RoutingContext {
  readonly request: CompletionRequest;
  readonly registry: ProviderRegistry;
  readonly triedProviderIds: readonly string[];
  readonly config: RoutingConfig;
}

/**
 * A routing strategy.  Implementations select the best provider from
 * the available candidates.  The orchestrator calls the strategy; the
 * strategy returns a decision or throws `AiError('no_provider', ...)`.
 */
export interface RoutingStrategyImpl {
  route(ctx: RoutingContext): RoutingDecision;
}

// ---------------------------------------------------------------------------
// Shared candidate filtering + model selection (used by all strategies)
// ---------------------------------------------------------------------------

/** Filter providers by capability, circuit breaker, and cost ceiling. */
function filterCandidates(ctx: RoutingContext): readonly RegisteredProvider[] {
  const all = ctx.registry.byTaskClass(ctx.request.task);
  return all.filter((p) => {
    if (ctx.triedProviderIds.includes(p.provider.id)) return false;
    if (p.healthTracker.isCircuitOpen()) return false;
    if (ctx.request.modality && !p.capabilities.modalities.includes(ctx.request.modality)) {
      return false;
    }
    if (ctx.request.stream && !p.capabilities.supportsStreaming) return false;
    if (ctx.request.structured && !p.capabilities.supportsStructured) return false;
    if (ctx.request.costCeiling && ctx.request.costCeiling > 0) {
      const model = selectModel(p, ctx.request);
      if (model) {
        const estCost = model.inputCostPerMtMicroUsd + model.outputCostPerMtMicroUsd;
        if (estCost > ctx.request.costCeiling) return false;
      }
    }
    return true;
  });
}

/** Select the best model for a request from a provider's capabilities. */
function selectModel(
  provider: RegisteredProvider,
  request: CompletionRequest,
): ModelInfo | undefined {
  if (request.model) {
    const match = provider.capabilities.models.find((m) => m.id === request.model);
    if (match) return match;
  }
  return provider.capabilities.models[0];
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/** Priority-based routing: try providers in configured order. */
export class PriorityStrategy implements RoutingStrategyImpl {
  route(ctx: RoutingContext): RoutingDecision {
    const candidates = filterCandidates(ctx);
    if (candidates.length === 0) {
      throw new AiError(
        'no_provider',
        `No available provider for task "${ctx.request.task}" ` +
          `(tried: [${ctx.triedProviderIds.join(', ')}]).`,
      );
    }
    const provider = candidates[0];
    return {
      provider,
      model: selectModel(provider, ctx.request),
      attempt: ctx.triedProviderIds.length + 1,
      triedProviderIds: ctx.triedProviderIds,
    };
  }
}

/** Weighted routing: score providers by latency, success rate, and cost. */
export class WeightedStrategy implements RoutingStrategyImpl {
  route(ctx: RoutingContext): RoutingDecision {
    const candidates = filterCandidates(ctx);
    if (candidates.length === 0) {
      throw new AiError(
        'no_provider',
        `No available provider for task "${ctx.request.task}".`,
      );
    }
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      const score = this.score(candidate, ctx.request);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return {
      provider: best,
      model: selectModel(best, ctx.request),
      attempt: ctx.triedProviderIds.length + 1,
      triedProviderIds: ctx.triedProviderIds,
    };
  }

  private score(provider: RegisteredProvider, request: CompletionRequest): number {
    const health = provider.healthTracker.snapshot(provider.provider.id);
    let score = 100;
    score -= health.avgLatencyMs / 100;
    score *= health.successRate;
    const model = selectModel(provider, request);
    if (model) {
      score -= (model.inputCostPerMtMicroUsd + model.outputCostPerMtMicroUsd) / 1_000;
    }
    score -= provider.priority * 0.5;
    if (request.providerPreference === provider.provider.id) {
      score += 50;
    }
    return score;
  }
}

/** Round-robin routing: cycle through available providers. */
export class RoundRobinStrategy implements RoutingStrategyImpl {
  private index = 0;

  route(ctx: RoutingContext): RoutingDecision {
    const candidates = filterCandidates(ctx);
    if (candidates.length === 0) {
      throw new AiError('no_provider', `No available provider for task "${ctx.request.task}".`);
    }
    const provider = candidates[this.index % candidates.length];
    this.index = (this.index + 1) % candidates.length;
    return {
      provider,
      model: selectModel(provider, ctx.request),
      attempt: ctx.triedProviderIds.length + 1,
      triedProviderIds: ctx.triedProviderIds,
    };
  }
}

/** Create a strategy from config. */
export function createStrategy(strategy: RoutingStrategy): RoutingStrategyImpl {
  switch (strategy) {
    case 'priority': return new PriorityStrategy();
    case 'weighted': return new WeightedStrategy();
    case 'round_robin': return new RoundRobinStrategy();
  }
}
