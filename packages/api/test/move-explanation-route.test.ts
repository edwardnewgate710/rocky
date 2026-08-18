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
import { FakeProvider, AiError } from '@chess-platform/ai-orchestrator';
import { MoveExplainer } from '@chess-platform/ai-features';
import { AnalysisService } from '../src/analysis/service';
import { MoveExplanationService } from '../src/ai/move-explanation-service';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { startHarness } from './helpers';

class StubAnalysisProvider implements AnalysisProvider {
  response: readonly EngineResult[] = [];
  errorToThrow?: Error;
  lastRequest?: AnalysisRequest;
  callCount = 0;

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.callCount++;
    this.lastRequest = request;
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    return this.response;
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not implemented in stub');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function createMockEngineLines(overrides?: Partial<EngineResult>): readonly EngineResult[] {
  return [
    {
      multipv: 1,
      evaluation: { type: 'cp', value: 35 },
      principalVariation: ['e2e4', 'e7e5', 'g1f3'],
      depth: 16,
      selDepth: 20,
      nodes: 123456,
      nps: 500000,
      timeMs: 900,
      ...overrides,
    },
  ];
}

function buildMoveExplanationService(options?: {
  provider?: StubAnalysisProvider;
  supportsVariant?: (v: string) => boolean;
  fakeAi?: FakeProvider;
}): {
  service: MoveExplanationService;
  stubEngine: StubAnalysisProvider;
  fakeAi: FakeProvider;
} {
  const stubEngine = options?.provider ?? new StubAnalysisProvider();
  if (stubEngine.response.length === 0) {
    stubEngine.response = createMockEngineLines();
  }
  const analysis = new AnalysisService({
    provider: stubEngine,
    ...(options?.supportsVariant ? { supportsVariant: options.supportsVariant } : {}),
  });
  const fakeAi =
    options?.fakeAi ??
    new FakeProvider({
      id: 'mock-llm',
      model: 'mock-model',
      content: 'e4 stakes a claim in the center and frees lines for the queen and bishop.',
    });
  const explainer = new MoveExplainer({
    ai: fakeAi,
    defaultVariant: 'standard',
    temperature: 0.3,
    maxTokens: 512,
  });
  const service = new MoveExplanationService({ analysis, explainer });
  return { service, stubEngine, fakeAi };
}

test('POST /v1/ai/move-explanation: authenticated request returns 200 with prose and a structured citation', async () => {
  const { service } = buildMoveExplanationService();
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: {
        fen: START_FEN,
        variant: 'standard',
        move: 'e2e4',
      },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      fen: START_FEN,
      variant: 'standard',
      move: 'e2e4',
      explanation: 'e4 stakes a claim in the center and frees lines for the queen and bishop.',
      citation: {
        // The stub answers both searches identically, so the move's evaluation is the negation of
        // the position's. Real engines differ; `ai-cost-controls.test.ts` scripts that case.
        moveOutcome: { kind: 'evaluation', evalKind: 'cp', evalValue: -35, evalLabel: '-0.35' },
        evalKind: 'cp',
        evalValue: 35,
        evalLabel: '+0.35',
        bestMove: 'e2e4',
        bestLine: ['e2e4', 'e7e5', 'g1f3'],
        depth: 16,
      },
      providerId: 'mock-llm',
      model: 'mock-model',
    });
    assert.equal((res.body as Record<string, unknown>)['tokens'], undefined);
    assert.equal((res.body as Record<string, unknown>)['cost'], undefined);
    assert.equal((res.body as Record<string, unknown>)['latencyMs'], undefined);
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: unauthenticated request returns 401', async () => {
  const { service } = buildMoveExplanationService();
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthorized');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: deps.moveExplanation absent returns 503', async () => {
  const h = await startHarness();
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.body.error.message, 'move explanation is not configured');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: a variant the analysis subsystem does not support returns 422', async () => {
  const { service } = buildMoveExplanationService({
    supportsVariant: (v) => v === 'standard',
  });
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: START_FEN, variant: 'crazyhouse', move: 'e2e4' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: a malformed FEN returns 422', async () => {
  const { service } = buildMoveExplanationService();
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: 'not a valid fen', variant: 'standard', move: 'e2e4' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: a FEN containing a newline (UCI command injection attempt) returns 422 and never reaches the analysis provider', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines();
  const { service } = buildMoveExplanationService({ provider: stubEngine });
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const maliciousFen = `${START_FEN}\nquit`;
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: maliciousFen, variant: 'standard', move: 'e2e4' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.equal(stubEngine.callCount, 0, 'malicious FEN must be rejected before reaching the engine provider');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: a syntactically malformed UCI move returns 422', async () => {
  const { service } = buildMoveExplanationService();
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'invalid-move!' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: a well-formed but ILLEGAL move for the position returns 422', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines();
  const { service } = buildMoveExplanationService({ provider: stubEngine });
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e5' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.equal(stubEngine.callCount, 0, 'illegal move must be rejected by Position.play before engine analysis');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: an unknown body field is rejected (assert strictObject behaviour)', async () => {
  const { service } = buildMoveExplanationService();
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: {
        fen: START_FEN,
        variant: 'standard',
        move: 'e2e4',
        unrecognizedField: 'unexpected',
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: a body carrying model, provider, maxTokens or temperature is rejected', async () => {
  const { service } = buildMoveExplanationService();
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const forbiddenFields = [
      { model: 'gpt-4o' },
      { provider: 'anthropic' },
      { maxTokens: 1000 },
      { temperature: 0.9 },
      { depth: 25 },
      { side: 'white' },
      { prompt: 'custom prompt' },
    ];

    for (const forbidden of forbiddenFields) {
      const res = await h.json('POST', '/v1/ai/move-explanation', {
        token: user.token,
        body: {
          fen: START_FEN,
          variant: 'standard',
          move: 'e2e4',
          ...forbidden,
        },
      });
      assert.equal(
        res.status,
        422,
        `field ${Object.keys(forbidden)[0]} must be rejected with 422`,
      );
      assert.equal(res.body.error.code, 'validation_failed');
    }
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: per-user rate limit returns 429 after the configured number of requests', async () => {
  const { service } = buildMoveExplanationService();
  const h = await startHarness(
    {
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        enabled: true,
        moveExplanation: {
          perUser: { maxRequests: 2, windowMs: 60 * 1000 },
          perIp: { maxRequests: 60, windowMs: 60 * 1000 },
        },
      },
    },
    { moveExplanation: service },
  );
  try {
    const user = await h.makeUser('alice');

    for (let i = 0; i < 2; i++) {
      const res = await h.json('POST', '/v1/ai/move-explanation', {
        token: user.token,
        body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
      });
      assert.equal(res.status, 200);
    }

    const resBlocked = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });
    assert.equal(resBlocked.status, 429);
    assert.equal(resBlocked.body.error.code, 'rate_limited');
    const retryAfter = resBlocked.headers.get('retry-after');
    assert.ok(retryAfter !== null && Number(retryAfter) > 0);
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: the citation bestLine and depth equal stub engine output even if LLM prose contradicts it', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines({
    depth: 24,
    principalVariation: ['e2e4', 'c7c5', 'g1f3', 'd7d6'],
    evaluation: { type: 'cp', value: 45 },
  });
  const fakeAi = new FakeProvider({
    id: 'hallucinating-llm',
    model: 'hallucinating-model',
    content: 'Depth 99. The evaluation is +9.99 and the best move is a2a3 followed by h2h4. Mate in 3.',
  });
  const { service } = buildMoveExplanationService({ provider: stubEngine, fakeAi });
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });

    assert.equal(res.status, 200);
    assert.equal(
      res.body.explanation,
      'Depth 99. The evaluation is +9.99 and the best move is a2a3 followed by h2h4. Mate in 3.',
    );
    assert.equal(res.body.citation.depth, 24);
    assert.deepEqual(res.body.citation.bestLine, ['e2e4', 'c7c5', 'g1f3', 'd7d6']);
    assert.equal(res.body.citation.evalKind, 'cp');
    assert.equal(res.body.citation.evalValue, 45);
    assert.equal(res.body.citation.evalLabel, '+0.45');
  } finally {
    await h.close();
  }
});

test('POST /v1/ai/move-explanation: a provider failure surfaces as 503 and response body redacts sensitive vendor details', async () => {
  const fakeAi = new FakeProvider({
    id: 'openai',
    failOnAttempt: 0,
    failWithError: new AiError(
      'provider_error',
      'OpenAI error: invalid apiKey sk-proj-1234567890abcdef at https://api.openai.com/v1 with organization org-secret',
      { providerId: 'openai' },
    ),
  });
  const { service } = buildMoveExplanationService({ fakeAi });
  const h = await startHarness({}, { moveExplanation: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/ai/move-explanation', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.body.error.message, 'move explanation is unavailable');

    const serializedBody = JSON.stringify(res.body);
    assert.equal(serializedBody.includes('OpenAI error'), false, 'must not leak provider error text');
    assert.equal(serializedBody.includes('apiKey'), false, 'must not leak apiKey string');
    assert.equal(serializedBody.includes('sk-'), false, 'must not leak key prefix');
    assert.equal(serializedBody.includes('org-secret'), false, 'must not leak org details');
    assert.equal(serializedBody.includes('stack'), false, 'must not include stack trace');
  } finally {
    await h.close();
  }
});

test('GET /v1/capabilities reports moveExplanation: true when the dependency is present and false when absent', async () => {
  const { service } = buildMoveExplanationService();
  const hWith = await startHarness({}, { moveExplanation: service });
  try {
    const res = await hWith.json('GET', '/v1/capabilities');
    assert.equal(res.status, 200);
    assert.equal(res.body.capabilities.moveExplanation, true);
  } finally {
    await hWith.close();
  }

  const hWithout = await startHarness();
  try {
    const res = await hWithout.json('GET', '/v1/capabilities');
    assert.equal(res.status, 200);
    assert.equal(res.body.capabilities.moveExplanation, false);
  } finally {
    await hWithout.close();
  }
});
