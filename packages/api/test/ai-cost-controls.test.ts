/**
 * The ceilings that bound what one HTTP request may cost.
 *
 * `move-explanation-route.test.ts` covers the endpoint's behaviour; this file covers the budget.
 * Move Explanation is the first surface in this system where a single request spends CPU *and*
 * third-party money, so the properties worth pinning are the ones that decide how much of each: how
 * many engine searches, how many provider calls, how long each may take, how many tokens it may
 * generate, and whether one user's answer can be served to another.
 *
 * These are driven through the real `AiOrchestrator` rather than a bare provider, because the
 * orchestrator is what enforces the timeout, the failover cap and the cache — a `FakeProvider` alone
 * would let all three assertions pass while proving nothing about production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AnalysisProvider,
  AnalysisRequest,
  EngineCapabilities,
  EngineResult,
  PlayRequest,
  PlayResult,
} from '@chess-platform/engine';
import type { CompletionRequest, ProviderCapabilities } from '@chess-platform/ai-orchestrator';
import { AiError, AiOrchestrator, FakeProvider } from '@chess-platform/ai-orchestrator';
import { MoveExplainer } from '@chess-platform/ai-features';
import { AnalysisService } from '../src/analysis/service';
import { MoveExplanationService } from '../src/ai/move-explanation-service';
import { DEFAULT_AI_SETTINGS } from '../src/ai/composition';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One engine line, with the fields a test cares about overridable and the rest fixed. */
function line(overrides: Partial<EngineResult> = {}): EngineResult {
  return {
    multipv: 1,
    evaluation: { type: 'cp', value: 35 },
    principalVariation: ['e2e4', 'e7e5'],
    depth: 16,
    selDepth: 20,
    nodes: 1000,
    nps: 5000,
    timeMs: 900,
    ...overrides,
  };
}

class CountingAnalysisProvider implements AnalysisProvider {
  callCount = 0;
  readonly requests: AnalysisRequest[] = [];
  /** Per-position answers, for the tests that need the two searches to differ. */
  responder: ((fen: string) => readonly EngineResult[]) | undefined;

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.callCount += 1;
    this.requests.push(request);
    return this.responder ? this.responder(request.fen) : [line()];
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not implemented in stub');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

function capabilitiesFor(id: string): ProviderCapabilities {
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
        maxOutputTokens: DEFAULT_AI_SETTINGS.maxOutputTokens,
      },
    ],
    maxContextTokens: 128_000,
    local: false,
  };
}

/** Composes the production shape: an orchestrator behind the explainer, and no engine of its own. */
function buildService(
  providers: readonly FakeProvider[],
  options?: {
    maxFailoverAttempts?: number;
    latencyBudgetMs?: number;
    supportsVariant?: (variant: string) => boolean;
  },
): { service: MoveExplanationService; engine: CountingAnalysisProvider } {
  const engine = new CountingAnalysisProvider();
  const analysis = new AnalysisService({
    provider: engine,
    ...(options?.supportsVariant ? { supportsVariant: options.supportsVariant } : {}),
  });
  const orchestrator = new AiOrchestrator({
    config: {
      providers: [],
      routing: {
        strategy: 'priority',
        failoverEnabled: providers.length > 1,
        maxFailoverAttempts:
          options?.maxFailoverAttempts ?? DEFAULT_AI_SETTINGS.maxFailoverAttempts,
        defaultLatencyBudgetMs: options?.latencyBudgetMs ?? DEFAULT_AI_SETTINGS.latencyBudgetMs,
        defaultCostCeiling: 0,
      },
      cache: { enabled: true, maxEntries: 100, ttlMs: 300_000 },
    },
  });
  providers.forEach((provider, index) => {
    orchestrator.registry.register(provider, capabilitiesFor(provider.id), { priority: index });
  });
  const explainer = new MoveExplainer({
    ai: orchestrator,
    defaultVariant: 'standard',
    temperature: DEFAULT_AI_SETTINGS.temperature,
    maxTokens: DEFAULT_AI_SETTINGS.maxOutputTokens,
  });
  return { service: new MoveExplanationService({ analysis, explainer }), engine };
}

/** A service over a specific engine stub, for the tests that script per-position answers. */
function serviceOver(
  engine: CountingAnalysisProvider,
  provider: FakeProvider,
): MoveExplanationService {
  const orchestrator = new AiOrchestrator();
  orchestrator.registry.register(provider, capabilitiesFor(provider.id));
  return new MoveExplanationService({
    analysis: new AnalysisService({ provider: engine }),
    explainer: new MoveExplainer({ ai: orchestrator, defaultVariant: 'standard' }),
  });
}

/**
 * One request buys exactly two searches: the position before the move, and the position after it.
 *
 * Two rather than one, and the count is the point in both directions. It must not be *one*, because
 * a single search of the original position yields the engine's own preferred move — so explaining
 * any other move would cite facts about a different move (the defect Qodo found in the first cut of
 * this PR). And it must not be *more*: the explainer has its own path to an engine when
 * `ExplainRequest.analysis` is omitted, and production composes it without one precisely so that
 * path is unreachable.
 */
test('one HTTP request performs exactly two engine searches: before and after the move', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const { service, engine } = buildService([provider]);

  await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });

  assert.equal(engine.callCount, 2);
  const analysed = engine.requests.map((request) => request.fen);
  assert.ok(analysed.includes(START_FEN), 'the position as the player found it');
  assert.ok(
    analysed.some((fen) => fen.startsWith('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b')),
    'and the position the move created',
  );
  for (const request of engine.requests) {
    assert.equal(request.multiPv, 1, 'a single line from each is all an explanation needs');
  }
});

/**
 * The evaluation reported for the move is the move's own, not the engine's preference.
 *
 * This is the defect in full: the service validated the requested move and then analysed the
 * unchanged position, so `citation` described whatever the engine would have played. Explaining a
 * quiet move would show the eval of a tactic the player did not make, and explaining a blunder would
 * show the eval of the best reply — the prose grounded, and grounded in the wrong facts. Raised in
 * the Qodo review of PR #134.
 *
 * The stub answers each position differently so the two numbers cannot be confused, and both are
 * asserted in the mover's frame.
 */
test('the citation evaluates the requested move, not the engine preference', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const engine = new CountingAnalysisProvider();
  // Before the move: white to move, +0.35, engine prefers d2d4.
  // After e2e4: black to move, +0.80 for black — so -0.80 from white's perspective.
  engine.responder = (fen) =>
    fen === START_FEN
      ? [line({ evaluation: { type: 'cp', value: 35 }, principalVariation: ['d2d4', 'd7d5'] })]
      : [line({ evaluation: { type: 'cp', value: 80 }, principalVariation: ['e7e5'] })];

  const service = serviceOver(engine, provider);
  const outcome = await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });

  assert.equal(outcome.citation.moveEvalValue, -80, 'negated into the mover’s frame');
  assert.equal(outcome.citation.moveEvalLabel, '-0.80');
  assert.equal(outcome.citation.evalValue, 35, 'what the engine would have achieved instead');
  assert.equal(outcome.citation.bestMove, 'd2d4');

  // And the model is told both, so its judgement is not its own.
  const grounded = provider.calls[0]!.messages.find(
    (m) => m.role === 'system' && m.content.includes('Engine evaluation'),
  );
  assert.ok(grounded!.content.includes('Evaluation after e2e4: -0.80'));
});

/** Mate scores flip sign with everything else, or a forced win reads as a forced loss. */
test('a mate delivered by the requested move is reported as mate for the mover', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const engine = new CountingAnalysisProvider();
  engine.responder = (fen) =>
    fen === START_FEN
      ? [line({ evaluation: { type: 'cp', value: 35 } })]
      : // The opponent is to move and is getting mated in 2, which the engine reports as -2.
        [line({ evaluation: { type: 'mate', value: -2 } })];

  const service = serviceOver(engine, provider);
  const outcome = await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });

  assert.equal(outcome.citation.moveEvalKind, 'mate');
  assert.equal(outcome.citation.moveEvalValue, 2, 'the mover mates in 2, not gets mated in 2');
});

/**
 * An engine that produced no evaluation yields no explanation, and costs no completion.
 *
 * A search can end without an `info` line, and empty analysis is the one input that could reach the
 * model with nothing to defer to: `MoveExplainer` reads empty pre-computed analysis as "none
 * supplied", and its no-results citation reports `+0.00` at depth 0 — a number no engine produced.
 * Found reviewing this service rather than by a failing test, which is why the assertion on
 * `provider.calls` is here too: refusing has to happen before anything is paid for.
 */
test('an engine that returns no lines produces no explanation and no provider call', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const silent: AnalysisProvider = {
    analyze: async () => [],
    play: async () => {
      throw new Error('not implemented in stub');
    },
    capabilitiesFor: () => undefined,
  };
  const orchestrator = new AiOrchestrator();
  orchestrator.registry.register(provider, capabilitiesFor('p1'));
  const service = new MoveExplanationService({
    analysis: new AnalysisService({ provider: silent }),
    explainer: new MoveExplainer({ ai: orchestrator, defaultVariant: 'standard' }),
  });

  await assert.rejects(
    () => service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' }),
    (err: unknown) => {
      const httpError = err as { status?: number; message?: string };
      assert.equal(httpError.status, 503);
      assert.equal(httpError.message, 'the engine returned no evaluation to explain');
      return true;
    },
  );
  assert.equal(provider.calls.length, 0, 'nothing is generated without engine evidence');
});

/**
 * A request that is never going to run costs the caller none of their quota.
 *
 * The per-user ceiling is deliberately low (10/min) because each accepted request buys two engine
 * searches and a paid completion. Charging on arrival — as the route did until the Qodo review of
 * PR #134 — let a stream of malformed FENs, illegal moves or unsupported variants empty that budget
 * without touching an engine, and through the shared per-IP bucket it emptied co-located users'
 * budgets too.
 *
 * `onAccepted` is the seam that fixes the ordering, so this asserts on the seam: it fires for the
 * request that runs and for none of the ones that are refused.
 */
test('a rejected request never spends rate-limit quota', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  // A Stockfish-only deployment, so the unsupported-variant refusal below is a real one.
  const { service } = buildService([provider], { supportsVariant: (v) => v === 'standard' });
  let charged = 0;
  const charge = async (): Promise<void> => {
    charged += 1;
  };

  const rejected = [
    { fen: START_FEN, variant: 'crazyhouse' as const, move: 'e2e4', why: 'unsupported variant' },
    { fen: START_FEN, variant: 'standard' as const, move: 'not-a-move', why: 'malformed UCI' },
    { fen: START_FEN, variant: 'standard' as const, move: 'e2e5', why: 'illegal move' },
    { fen: 'total nonsense', variant: 'standard' as const, move: 'e2e4', why: 'malformed FEN' },
    { fen: `${START_FEN}\nquit`, variant: 'standard' as const, move: 'e2e4', why: 'injected FEN' },
  ];
  for (const { why, ...input } of rejected) {
    await assert.rejects(() => service.explain(input, charge), `${why} should be refused`);
  }
  assert.equal(charged, 0, 'nothing refused may cost the caller a slot');

  await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' }, charge);
  assert.equal(charged, 1, 'and a request that does run is charged exactly once');
});

/**
 * Failover is capped, so a bad day cannot become an unbounded walk over every provider.
 *
 * With three registered providers all failing retryably and a cap of two, exactly two are attempted.
 * Without the cap this is three paid calls for one request; with more providers configured it is
 * however many exist.
 */
test('provider failover stops at the configured attempt cap', async () => {
  const failure = new AiError('provider_error', 'transient', { retryable: true });
  const providers = ['p1', 'p2', 'p3'].map(
    (id) => new FakeProvider({ id, model: `${id}-model`, failOnAttempt: 0, failWithError: failure }),
  );
  const { service } = buildService(providers, { maxFailoverAttempts: 2 });

  await assert.rejects(() =>
    service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' }),
  );

  const attempted = providers.filter((p) => p.calls.length > 0).length;
  assert.equal(attempted, 2, 'exactly maxFailoverAttempts providers may be charged for one request');
  assert.equal(providers[2]!.calls.length, 0, 'the third provider is never reached');
});

/**
 * A slow provider is abandoned on the server's schedule, not the vendor's.
 *
 * `completeWithTimeout` aborts at the latency budget. Without it a provider that accepts a request
 * and never answers holds the HTTP request open indefinitely, and the deployment's own timeouts
 * decide the outcome instead.
 */
test('a provider that exceeds the latency budget is abandoned and surfaces as 503', async () => {
  const slow = new FakeProvider({
    id: 'slow',
    model: 'slow-model',
    latencyMs: 5_000,
    content: 'too late',
  });
  const { service } = buildService([slow], { latencyBudgetMs: 50 });

  const started = Date.now();
  await assert.rejects(
    () => service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' }),
    (err: unknown) => {
      const httpError = err as { status?: number; message?: string };
      assert.equal(httpError.status, 503);
      assert.equal(httpError.message, 'move explanation timed out');
      return true;
    },
  );
  assert.ok(Date.now() - started < 4_000, 'the budget, not the provider, ended the request');
});

/**
 * The token ceiling reaches the provider on every call.
 *
 * It is the direct lever on per-request spend and it is set once at composition. The request body has
 * no field that reaches it (`move-explanation-route.test.ts` covers the rejection), so what remains
 * to prove is that the value is actually *sent* rather than merely stored.
 */
test('the server-owned token ceiling is sent to the provider', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const { service } = buildService([provider]);

  await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });

  const sent: CompletionRequest = provider.calls[0]!;
  assert.equal(sent.maxTokens, DEFAULT_AI_SETTINGS.maxOutputTokens);
  assert.equal(sent.temperature, DEFAULT_AI_SETTINGS.temperature);
  assert.equal(sent.model, undefined, 'no model is pinned by the feature; routing chooses');
});

/**
 * Two variants sharing a position, a move and an evaluation are not one cached explanation.
 *
 * `buildCacheKey` hashes the grounding, and the grounding carried no variant — so a Crazyhouse
 * request could be served the answer written about the standard-chess position, in which the same
 * move can be sound rather than losing. Adding `variant` to `EngineGrounding` separates them.
 *
 * The stub engine returns identical output for both calls on purpose: identical engine facts are
 * exactly the case where the variant is the only thing keeping the two apart.
 */
test('an explanation cached for one variant is not served for another', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const { service } = buildService([provider]);

  await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });
  await service.explain({ fen: START_FEN, variant: 'crazyhouse', move: 'e2e4' });

  assert.equal(provider.calls.length, 2, 'the second variant must not hit the first variant’s entry');
  assert.equal(provider.calls[0]!.grounding!.variant, 'standard');
  assert.equal(provider.calls[1]!.grounding!.variant, 'crazyhouse');

  // And the repeat of an identical request *is* cached, so the test above is showing a real
  // separation rather than a cache that never worked.
  await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });
  assert.equal(provider.calls.length, 2, 'an identical request is served from cache');
});

/**
 * Different moves in the same position are different explanations.
 *
 * The engine facts here are identical by construction, so this fails if cache identity ever narrows
 * to the position alone — which would let a request about a blunder be answered with the prose
 * written about the best move.
 */
test('an explanation cached for one move is not served for another', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const { service } = buildService([provider]);

  await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });
  await service.explain({ fen: START_FEN, variant: 'standard', move: 'd2d4' });

  assert.equal(provider.calls.length, 2);
  assert.equal(provider.calls[0]!.grounding!.moveUci, 'e2e4');
  assert.equal(provider.calls[1]!.grounding!.moveUci, 'd2d4');
});

/**
 * Move Explanation carries no per-user context, so sharing a cached answer between users leaks
 * nothing — the response is a function of position, move and variant alone.
 *
 * This is recorded as a deliberate assumption rather than left implicit, because it is the premise
 * that makes the shared cache safe. `userId` is part of `buildCacheKey`'s `optionsHash` and this
 * feature never sets it, so entries are shared; the day a request gains a user-specific field —
 * a rating, a playing history, a language preference — that field must reach the cache key, and this
 * test is the place that stops being true.
 */
test('the completion request carries no user identity, which is what makes the shared cache safe', async () => {
  const provider = new FakeProvider({ id: 'p1', model: 'p1-model', content: 'Explanation.' });
  const { service } = buildService([provider]);

  await service.explain({ fen: START_FEN, variant: 'standard', move: 'e2e4' });

  const sent: CompletionRequest = provider.calls[0]!;
  assert.equal(sent.userId, undefined);
  assert.equal(sent.metadata, undefined);
  const serialized = JSON.stringify(sent.messages);
  assert.equal(serialized.includes('user_'), false, 'no identifier reaches the prompt');
});
