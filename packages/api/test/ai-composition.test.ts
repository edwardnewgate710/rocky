/**
 * What `createAiFromEnv` and `createMoveExplanation` actually build.
 *
 * `bootstrap-move-explanation.test.ts` asserts the dependency *exists*; this asserts what it was
 * built *with*. The distinction is not academic — every server-owned ceiling in this feature is
 * applied here and nowhere else, so a composition that produces a working service with the wrong
 * limits passes every route test in the suite. Mutation-testing found exactly that gap: raising the
 * token ceiling to a million at this seam broke nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import type { ProviderCapabilities } from '@chess-platform/ai-orchestrator';
import { AiOrchestrator, FakeProvider } from '@chess-platform/ai-orchestrator';
import { AnalysisService } from '../src/analysis/service';
import {
  aiSettingsFromEnv,
  configuredAiProviders,
  createAiFromEnv,
  createMoveExplanation,
  DEFAULT_AI_SETTINGS,
} from '../src/ai/composition';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Tests execute from `dist-test/test`, so the two levels up land on the package root and the source
 * the assertions below read is the real `src/`, not its compiled output — the point is to inspect
 * the call site as written.
 */
const PACKAGE_ROOT = resolve(__dirname, '..', '..');

class StubAnalysisProvider implements AnalysisProvider {
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    return [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 35 },
        principalVariation: ['e2e4', 'e7e5'],
        depth: 16,
        selDepth: 20,
        nodes: 1000,
        nps: 5000,
        timeMs: 900,
      },
    ];
  }
  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not implemented in stub');
  }
  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

function fakeCapabilities(id: string): ProviderCapabilities {
  return {
    providerId: id,
    displayName: id,
    modalities: ['text'],
    taskClasses: [],
    supportsStreaming: true,
    supportsStructured: true,
    supportsEmbeddings: false,
    supportsCancellation: true,
    models: [
      {
        id: `${id}-model`,
        displayName: `${id}-model`,
        contextWindow: 128_000,
        inputCostPerMtMicroUsd: 0,
        outputCostPerMtMicroUsd: 0,
        maxOutputTokens: 4096,
      },
    ],
    maxContextTokens: 128_000,
    local: false,
  };
}

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

test('no AI environment configures no providers, so nothing is composed', () => {
  assert.deepEqual(configuredAiProviders({}), []);
  assert.equal(createAiFromEnv({}), undefined);
});

test('each provider is registered only when its own configuration is present', () => {
  assert.deepEqual(
    configuredAiProviders({ AI_OPENAI_API_KEY: 'k' }).map((p) => p.provider.id),
    ['openai'],
  );
  assert.deepEqual(
    configuredAiProviders({ AI_ANTHROPIC_API_KEY: 'k' }).map((p) => p.provider.id),
    ['anthropic'],
  );
  assert.deepEqual(
    configuredAiProviders({ AI_OPENAI_API_KEY: 'k', AI_ANTHROPIC_API_KEY: 'k' }).map(
      (p) => p.provider.id,
    ),
    ['openai', 'anthropic'],
  );
});

/** A local Ollama needs a base URL and no key, so a base URL alone is a real configuration. */
test('a base URL with no key configures a local provider', () => {
  const configured = configuredAiProviders({ AI_OPENAI_BASE_URL: 'http://localhost:11434/v1' });
  assert.equal(configured.length, 1);
  assert.equal(configured[0]!.capabilities.local, true);
});

/** Whitespace is not configuration; a blank variable must not look like a credential. */
test('a blank or whitespace-only key configures nothing', () => {
  assert.deepEqual(configuredAiProviders({ AI_OPENAI_API_KEY: '   ' }), []);
  assert.equal(createAiFromEnv({ AI_ANTHROPIC_API_KEY: '' }), undefined);
});

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/**
 * Environment configuration may lower a ceiling and may never raise one.
 *
 * The failure this prevents is a deployment believing it has capped per-request spend while an
 * `AI_MAX_OUTPUT_TOKENS` typo — or an attacker with environment access but not code access — has
 * quietly removed the cap. Same clamping shape as `analysisLimitsPolicyFromEnv`.
 */
test('environment settings are clamped to the compiled ceiling, never above it', () => {
  const raised = aiSettingsFromEnv({
    AI_MAX_OUTPUT_TOKENS: '1000000',
    AI_LATENCY_BUDGET_MS: '600000',
    AI_MAX_FAILOVER_ATTEMPTS: '99',
    // The cache pair was left unclamped while the doc comment above them claimed otherwise —
    // an oversized entry count is unbounded memory in an in-process LRU, and an oversized TTL keeps
    // serving an explanation long after the engine that grounded it changed. Raised in the Qodo
    // review of PR #134, and asserted here so "every setting is clamped" stays a fact.
    AI_CACHE_ENTRIES: '10000000',
    AI_CACHE_TTL_MS: '999999999',
  });
  assert.equal(raised.maxOutputTokens, DEFAULT_AI_SETTINGS.maxOutputTokens);
  assert.equal(raised.latencyBudgetMs, DEFAULT_AI_SETTINGS.latencyBudgetMs);
  assert.equal(raised.maxFailoverAttempts, DEFAULT_AI_SETTINGS.maxFailoverAttempts);
  assert.equal(raised.cacheEntries, DEFAULT_AI_SETTINGS.cacheEntries);
  assert.equal(raised.cacheTtlMs, DEFAULT_AI_SETTINGS.cacheTtlMs);

  const lowered = aiSettingsFromEnv({
    AI_MAX_OUTPUT_TOKENS: '128',
    AI_LATENCY_BUDGET_MS: '2000',
    AI_MAX_FAILOVER_ATTEMPTS: '1',
    AI_CACHE_ENTRIES: '10',
    AI_CACHE_TTL_MS: '1000',
  });
  assert.equal(lowered.maxOutputTokens, 128, 'lowering is the direction that must work');
  assert.equal(lowered.latencyBudgetMs, 2000);
  assert.equal(lowered.maxFailoverAttempts, 1);
  assert.equal(lowered.cacheEntries, 10);
  assert.equal(lowered.cacheTtlMs, 1000);
});

test('a malformed or negative setting falls back to the default rather than disabling the limit', () => {
  for (const bad of ['0', '-5', 'lots', '3.5', '']) {
    assert.equal(
      aiSettingsFromEnv({ AI_MAX_OUTPUT_TOKENS: bad }).maxOutputTokens,
      DEFAULT_AI_SETTINGS.maxOutputTokens,
      `"${bad}" must not remove the ceiling`,
    );
  }
});

/**
 * The ceilings reach the provider through the composition root, not merely through a test that
 * builds its own explainer.
 *
 * Mutation-tested: replacing `ai.settings.maxOutputTokens` with a million in `createMoveExplanation`
 * failed nothing until this existed, because every other test constructed `MoveExplainer` directly
 * and passed the ceiling itself.
 */
test('createMoveExplanation applies the settings ceiling to every completion it sends', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const orchestrator = new AiOrchestrator();
  orchestrator.registry.register(provider, fakeCapabilities('p1'));

  const service = createMoveExplanation(
    {
      orchestrator,
      settings: { ...DEFAULT_AI_SETTINGS, maxOutputTokens: 137, temperature: 0.11 },
    },
    new AnalysisService({ provider: new StubAnalysisProvider() }),
  );

  await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });

  assert.equal(provider.calls[0]!.maxTokens, 137);
  assert.equal(provider.calls[0]!.temperature, 0.11);
});

// ---------------------------------------------------------------------------
// No second engine pool
// ---------------------------------------------------------------------------

/**
 * The composition root hands the explainer no engine — asserted on the source, because that is what
 * the claim actually is.
 *
 * ADR-0115 Decision 1 says a second pool is *unrepresentable*, not merely absent. That is a
 * structural property of how `MoveExplainer` is constructed here, and no behavioural test can see
 * it: the service supplies `ExplainRequest.analysis` on every call, so an explainer holding a spare
 * engine would never touch it and every test would still pass. Mutation-testing confirmed that —
 * adding an `engine` to this call site broke nothing at runtime.
 *
 * So the assertion reads the call site. It fails the day someone passes an engine, which is the day
 * this deployment would quietly acquire a second CPU ceiling on top of the one ADR-0113 published.
 * Same technique, and the same reason, as the e2e backend-guard meta-test.
 */
test('createMoveExplanation constructs MoveExplainer without an engine', () => {
  const file = resolve(PACKAGE_ROOT, 'src/ai/composition.ts');
  const source = readFileSync(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

  const constructions: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'MoveExplainer'
    ) {
      constructions.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  assert.equal(constructions.length, 1, 'exactly one MoveExplainer is built here');
  const [options] = constructions[0]!.arguments ?? [];
  assert.ok(options && ts.isObjectLiteralExpression(options));

  const names = options.properties.map((property) =>
    property.name && ts.isIdentifier(property.name) ? property.name.text : '<computed>',
  );
  assert.equal(
    names.includes('engine'),
    false,
    'passing an engine here gives the process a second route to a chess engine (ADR-0115 Decision 1)',
  );
  assert.ok(names.includes('ai'), 'the completion port is still supplied');
});

/**
 * Nothing in the AI subsystem builds engine infrastructure.
 *
 * Broader than the call site above: it also catches a future helper in these files constructing a
 * pool for some other purpose. The analysis subsystem is the one place allowed to do this.
 */
test('the AI subsystem never constructs engine infrastructure', () => {
  for (const name of ['composition.ts', 'move-explanation-service.ts', 'index.ts']) {
    const source = readFileSync(resolve(PACKAGE_ROOT, 'src/ai', name), 'utf8');
    for (const forbidden of ['createEngineManager', 'new EngineManager', 'new EnginePool']) {
      assert.equal(
        source.includes(forbidden),
        false,
        `src/ai/${name} must not build engine infrastructure (found "${forbidden}")`,
      );
    }
  }
});
