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
import { EngineError } from '@chess-platform/engine';
import { AnalysisService } from '../src/analysis/service.js';
import { createMistakePrediction } from '../src/analysis/composition.js';
import type { MistakePredictionService } from '../src/analysis/mistake-prediction-service.js';
import { DEFAULT_RATE_LIMIT } from '../src/config.js';
import { startHarness } from './helpers.js';

class StubAnalysisProvider implements AnalysisProvider {
  response: readonly EngineResult[] | ((request: AnalysisRequest) => readonly EngineResult[]) = [];
  errorToThrow?: Error;
  lastRequest?: AnalysisRequest;
  callCount = 0;

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.callCount++;
    this.lastRequest = request;
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    if (typeof this.response === 'function') {
      return this.response(request);
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
const MATE_IN_ONE_FEN = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
/**
 * Terminal **and still has legal moves** — the only fixture that can tell the two guards apart.
 *
 * A checkmate position has zero legal moves, so rejecting a move played from one proves nothing:
 * `Position.play` would refuse it as illegal even with the terminal check deleted. K-vs-K is drawn
 * by insufficient material under standard rules while the white king still has eight legal moves, so
 * a 422 here can only have come from the terminal adjudication.
 */
const ALREADY_TERMINAL_FEN = '8/8/8/3K4/8/8/8/7k w - - 0 1';
const ALREADY_TERMINAL_LEGAL_MOVE = 'd5d6';

/**
 * One position and one move whose *outcome* differs by variant — the divergence that proves the
 * requested variant reaches the rules engine and not only the engine router.
 *
 * Under King of the Hill `d3d4` puts the king on a centre square and wins on the spot; under Atomic
 * the game simply continues; under standard the position is already drawn by insufficient material
 * before a move is even considered. Three different answers, three different search counts.
 */
const VARIANT_DIVERGENCE_FEN = '8/8/8/8/8/3K4/8/7k w - - 0 1';
const VARIANT_DIVERGENCE_MOVE = 'd3d4';

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

function buildMistakePredictionService(options?: {
  provider?: StubAnalysisProvider;
  supportsVariant?: (v: string) => boolean;
  /**
   * Keep an empty `response` instead of defaulting it to one scored line.
   *
   * The convenience default below exists so most tests need no engine script at all, but it also
   * made "the search returned no lines" inexpressible — and that is a real branch of
   * `MistakePredictionService.predict`, the one that answers 503 rather than letting a verdict be
   * computed against a number no engine produced. Raised in the CodeRabbit review of PR #136.
   */
  keepEmptyResponse?: boolean;
}): {
  service: MistakePredictionService;
  stubEngine: StubAnalysisProvider;
} {
  const stubEngine = options?.provider ?? new StubAnalysisProvider();
  if (
    !options?.keepEmptyResponse &&
    Array.isArray(stubEngine.response) &&
    stubEngine.response.length === 0
  ) {
    stubEngine.response = createMockEngineLines();
  }
  const analysis = new AnalysisService({
    provider: stubEngine,
    ...(options?.supportsVariant ? { supportsVariant: options.supportsVariant } : {}),
  });
  const service = createMistakePrediction(analysis);
  return { service, stubEngine };
}

// 1. Authenticated success on an ordinary move returns 200 with classification, before, after (kind 'evaluation'), and a numeric centipawnLoss
test('POST /v1/analysis/mistake-prediction: authenticated success returns 200 with classification, before, after evaluation, and numeric centipawnLoss', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = (req) => {
    if (req.fen === START_FEN) {
      return createMockEngineLines({ evaluation: { type: 'cp', value: 35 } });
    }
    // After e2e4 (Black to move), Black is -35 => mover White is +35 (0 cp loss => classification 'ok')
    return createMockEngineLines({
      evaluation: { type: 'cp', value: -35 },
      principalVariation: ['e7e5', 'g1f3'],
    });
  };
  const { service } = buildMistakePredictionService({ provider: stubEngine });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
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
      classification: 'ok',
      before: {
        evalKind: 'cp',
        evalValue: 35,
        evalLabel: '+0.35',
      },
      after: {
        kind: 'evaluation',
        evalKind: 'cp',
        evalValue: 35,
        evalLabel: '+0.35',
      },
      centipawnLoss: 0,
      bestMove: 'e2e4',
      bestLine: ['e2e4', 'e7e5', 'g1f3'],
      depth: 16,
    });

    const bodyObj = res.body as Record<string, unknown>;
    assert.equal(bodyObj['tokens'], undefined);
    assert.equal(bodyObj['cost'], undefined);
    assert.equal(bodyObj['latencyMs'], undefined);
    assert.equal(bodyObj['provider'], undefined);
    assert.equal(bodyObj['model'], undefined);
    assert.equal(bodyObj['thresholds'], undefined);
  } finally {
    await h.close();
  }
});

// 2. Unauthenticated request returns 401
test('POST /v1/analysis/mistake-prediction: unauthenticated request returns 401', async () => {
  const { service } = buildMistakePredictionService();
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthorized');
  } finally {
    await h.close();
  }
});

// 3. Unsupported variant returns 422
test('POST /v1/analysis/mistake-prediction: unsupported variant returns 422', async () => {
  const { service } = buildMistakePredictionService({
    supportsVariant: (v) => v === 'standard',
  });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'crazyhouse', move: 'e2e4' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

// 4. Legacy variant vocabulary "chess" returns 422
test('POST /v1/analysis/mistake-prediction: legacy variant vocabulary "chess" returns 422', async () => {
  const { service } = buildMistakePredictionService();
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'chess', move: 'e2e4' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

// 5. Malformed FEN returns 422
test('POST /v1/analysis/mistake-prediction: malformed FEN returns 422', async () => {
  const { service } = buildMistakePredictionService();
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: 'not a valid fen', variant: 'standard', move: 'e2e4' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

// 6. FEN carrying a newline + UCI command returns 422 and NEVER reaches the engine
test('POST /v1/analysis/mistake-prediction: FEN carrying newline command injection returns 422 and never reaches the engine', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines();
  const { service } = buildMistakePredictionService({ provider: stubEngine });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const maliciousFen = `${START_FEN}\nsetoption name Threads value 128`;
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: maliciousFen, variant: 'standard', move: 'e2e4' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.equal(stubEngine.callCount, 0, 'malicious FEN must be rejected before calling engine');
  } finally {
    await h.close();
  }
});

// 7. Malformed UCI move returns 422
test('POST /v1/analysis/mistake-prediction: syntactically malformed UCI move returns 422', async () => {
  const { service } = buildMistakePredictionService();
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'invalid-move!' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

// 8. Illegal-but-well-formed move returns 422
test('POST /v1/analysis/mistake-prediction: illegal-but-well-formed move returns 422', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines();
  const { service } = buildMistakePredictionService({ provider: stubEngine });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e5' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.equal(stubEngine.callCount, 0, 'illegal move must be rejected before engine search');
  } finally {
    await h.close();
  }
});

// 9. A position that is ALREADY terminal (before the move) returns 422 and runs 0 engine searches
test('POST /v1/analysis/mistake-prediction: already-terminal position returns 422 and runs 0 searches', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines();
  const { service } = buildMistakePredictionService({ provider: stubEngine });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: ALREADY_TERMINAL_FEN, variant: 'standard', move: ALREADY_TERMINAL_LEGAL_MOVE },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.equal(stubEngine.callCount, 0, 'already-terminal position must run 0 searches');
  } finally {
    await h.close();
  }
});

// 9b. The same position and move, adjudicated under three variants, gives three different answers.
test('POST /v1/analysis/mistake-prediction: the requested variant reaches the rules engine, not only the router', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines({
    evaluation: { type: 'cp', value: 120 },
    principalVariation: ['d3d4'],
  });
  const { service } = buildMistakePredictionService({ provider: stubEngine });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');

    // King of the Hill: the move reaches a centre square and wins on the spot.
    const koth = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: VARIANT_DIVERGENCE_FEN, variant: 'kingofthehill', move: VARIANT_DIVERGENCE_MOVE },
    });
    assert.equal(koth.status, 200);
    assert.deepEqual(koth.body.after, {
      kind: 'terminal',
      reason: 'variant_win',
      result: '1-0',
      label: 'variant win — White wins',
    });
    assert.equal(koth.body.classification, 'ok', 'winning the game is not a mistake');
    assert.equal(koth.body.centipawnLoss, null, 'a won game has no centipawn measure');
    assert.equal(stubEngine.callCount, 1, 'a move that ends the game costs one search');

    // Atomic: the identical move on the identical position simply continues the game.
    stubEngine.callCount = 0;
    const atomic = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: VARIANT_DIVERGENCE_FEN, variant: 'atomic', move: VARIANT_DIVERGENCE_MOVE },
    });
    assert.equal(atomic.status, 200);
    assert.equal(
      (atomic.body.after as { kind: string }).kind,
      'evaluation',
      'the same move under a different rule set has no result to report',
    );
    assert.equal(stubEngine.callCount, 2, 'a continuing move costs two searches');

    // Standard: the position is already drawn by insufficient material, so there is nothing to assess.
    stubEngine.callCount = 0;
    const standard = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: VARIANT_DIVERGENCE_FEN, variant: 'standard', move: VARIANT_DIVERGENCE_MOVE },
    });
    assert.equal(standard.status, 422);
    assert.equal(stubEngine.callCount, 0, 'a decided position costs nothing');
  } finally {
    await h.close();
  }
});
// 10. Engine search counts pinned exactly: rejected -> 0, checkmate -> 1, ordinary -> 2
test('POST /v1/analysis/mistake-prediction: engine search counts are pinned exactly (0 for rejected, 1 for checkmate, 2 for ordinary)', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines();
  const { service } = buildMistakePredictionService({ provider: stubEngine });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');

    // Rejected request -> 0 searches
    const resRejected = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e5' },
    });
    assert.equal(resRejected.status, 422);
    assert.equal(stubEngine.callCount, 0, 'rejected request must execute 0 searches');

    // Move delivering checkmate -> exactly 1 search
    const resMate = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: MATE_IN_ONE_FEN, variant: 'standard', move: 'a1a8' },
    });
    assert.equal(resMate.status, 200);
    assert.equal(stubEngine.callCount, 1, 'move delivering checkmate must execute exactly 1 search');

    // Ordinary continuing move -> exactly 2 searches (total calls becomes 1 + 2 = 3)
    const resOrdinary = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });
    assert.equal(resOrdinary.status, 200);
    assert.equal(stubEngine.callCount, 3, 'ordinary continuing move must execute exactly 2 searches');
  } finally {
    await h.close();
  }
});

// 11. Move delivering checkmate returns after.kind === 'terminal' with reason 'checkmate', result '1-0', centipawnLoss === null, and classification 'ok'
test('POST /v1/analysis/mistake-prediction: move delivering checkmate returns after.kind terminal, correct result, null centipawnLoss and ok classification', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.response = createMockEngineLines({
    evaluation: { type: 'mate', value: 1 },
    principalVariation: ['a1a8'],
    depth: 16,
  });
  const { service } = buildMistakePredictionService({ provider: stubEngine });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: MATE_IN_ONE_FEN, variant: 'standard', move: 'a1a8' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.classification, 'ok');
    assert.equal(res.body.centipawnLoss, null);
    assert.equal(res.body.bestMove, 'a1a8');
    assert.deepEqual(res.body.after, {
      kind: 'terminal',
      reason: 'checkmate',
      result: '1-0',
      label: 'checkmate — White wins',
    });
  } finally {
    await h.close();
  }
});

// 12. Caller cannot override policy: request body with extra fields is rejected (strictObject)
test('POST /v1/analysis/mistake-prediction: request body carrying forbidden policy or AI override fields is rejected with 422', async () => {
  const { service } = buildMistakePredictionService();
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const forbiddenOverrides = [
      { blunderThreshold: 200 },
      { depth: 25 },
      { movetimeMs: 1000 },
      { multiPv: 3 },
      { provider: 'anthropic' },
      { model: 'claude-3-opus' },
      { maxTokens: 500 },
      { mistakeThreshold: 100 },
      { inaccuracyThreshold: 50 },
      { temperature: 0.7 },
      { prompt: 'custom prompt' },
    ];

    for (const forbidden of forbiddenOverrides) {
      const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
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

// 13. Rate limiting is charged AFTER validation: invalid requests do not consume quota
test('POST /v1/analysis/mistake-prediction: invalid requests do not consume rate-limit quota and subsequent valid requests succeed', async () => {
  const { service } = buildMistakePredictionService();
  const h = await startHarness(
    {
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        enabled: true,
        mistakePrediction: {
          perUser: { maxRequests: 2, windowMs: 60 * 1000 },
          perIp: { maxRequests: 60, windowMs: 60 * 1000 },
        },
      },
    },
    { mistakePrediction: service },
  );
  try {
    const user = await h.makeUser('alice');

    // Send 5 invalid requests (malformed FEN, illegal move, extra field)
    for (let i = 0; i < 5; i++) {
      const resInvalid = await h.json('POST', '/v1/analysis/mistake-prediction', {
        token: user.token,
        body: { fen: START_FEN, variant: 'standard', move: 'e2e5' },
      });
      assert.equal(resInvalid.status, 422);
    }

    // Now send 2 valid requests — both must succeed (quota has not been consumed)
    for (let i = 0; i < 2; i++) {
      const resValid = await h.json('POST', '/v1/analysis/mistake-prediction', {
        token: user.token,
        body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
      });
      assert.equal(resValid.status, 200);
    }

    // 3rd valid request exceeds the quota of 2
    const resBlocked = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });
    assert.equal(resBlocked.status, 429);
    assert.equal(resBlocked.body.error.code, 'rate_limited');
  } finally {
    await h.close();
  }
});

// 14. Capabilities: mistakePrediction is true when the analysis dep is present and false when absent
test('GET /v1/capabilities reports mistakePrediction: true when dependency is present and false when absent', async () => {
  const { service } = buildMistakePredictionService();
  const hWith = await startHarness({}, { mistakePrediction: service });
  try {
    const res = await hWith.json('GET', '/v1/capabilities');
    assert.equal(res.status, 200);
    assert.equal(res.body.capabilities.mistakePrediction, true);
  } finally {
    await hWith.close();
  }

  const hWithout = await startHarness();
  try {
    const res = await hWithout.json('GET', '/v1/capabilities');
    assert.equal(res.status, 200);
    assert.equal(res.body.capabilities.mistakePrediction, false);
  } finally {
    await hWithout.close();
  }
});

// 14b. A search that produced no scored line is refused, not guessed at.
test('POST /v1/analysis/mistake-prediction: a search that returns no lines answers 503 rather than inventing a verdict', async () => {
  const stubEngine = new StubAnalysisProvider();
  // A real condition, not a contrived one: a position with a single legal reply, a budget consumed
  // before the first iteration completes, or an engine stopped early can all end with no scored
  // `info` line. The only verdict available without one would be computed against a number no engine
  // produced — the exact fabrication this feature was built to remove.
  stubEngine.response = [];
  const { service } = buildMistakePredictionService({
    provider: stubEngine,
    keepEmptyResponse: true,
  });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.body.error.message, 'the engine returned no evaluation to assess');
    assert.equal(res.headers.get('retry-after'), '1', 'and says the condition is transient');
  } finally {
    await h.close();
  }
});

// 15. No internal error leakage: when the analysis provider throws an engine error, binary path, stack trace, and version are not in response body
test('POST /v1/analysis/mistake-prediction: analysis engine error returns 503 and redacts internal engine details, stack traces, and binary paths', async () => {
  const stubEngine = new StubAnalysisProvider();
  stubEngine.errorToThrow = new EngineError(
    'engine_crashed',
    'Engine process /usr/local/bin/stockfish-16 crashed with SIGSEGV at Stockfish::search() line 1234 on Linux 6.1 x86_64',
  );
  const { service } = buildMistakePredictionService({ provider: stubEngine });
  const h = await startHarness({}, { mistakePrediction: service });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis/mistake-prediction', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard', move: 'e2e4' },
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.body.error.message, 'analysis engine failed');

    const serialized = JSON.stringify(res.body);
    assert.equal(serialized.includes('/usr/local/bin/stockfish'), false, 'must not leak binary path');
    assert.equal(serialized.includes('SIGSEGV'), false, 'must not leak crash signal');
    assert.equal(serialized.includes('Stockfish::search'), false, 'must not leak internal function names');
    assert.equal(serialized.includes('line 1234'), false, 'must not leak source lines');
    assert.equal(serialized.includes('Linux 6.1'), false, 'must not leak kernel details');
    assert.equal(serialized.includes('stack'), false, 'must not leak stack trace');
  } finally {
    await h.close();
  }
});

// Bonus coupling test: MistakePredictionResponse matches served openapi schema
test('MistakePredictionResponse: the served schema describes exactly what the presenter emits', async () => {
  const h = await startHarness();
  try {
    const doc = h.server.openapiDocument();
    const components = doc['components'] as { schemas: Record<string, any> };
    const schema = components.schemas['MistakePredictionResponse'];
    assert.ok(schema && schema.properties && schema.required);

    const { mistakePredictionView } = await import('../src/presenters.js');
    const view = mistakePredictionView({
      fen: START_FEN,
      variant: 'standard',
      move: 'e2e4',
      classification: 'ok',
      before: { evalKind: 'cp', evalValue: 35, evalLabel: '+0.35' },
      after: { kind: 'evaluation', evalKind: 'cp', evalValue: -35, evalLabel: '-0.35' },
      centipawnLoss: 0,
      bestMove: 'e2e4',
      bestLine: ['e2e4', 'e7e5', 'g1f3'],
      depth: 16,
    });

    const presenterKeys = Object.keys(view).sort();
    assert.deepEqual(presenterKeys, Object.keys(schema.properties).sort());
    assert.deepEqual(presenterKeys, [...schema.required].sort());
  } finally {
    await h.close();
  }
});
