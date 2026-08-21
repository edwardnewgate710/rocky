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
import { createPuzzleGeneration } from '../src/analysis/composition.js';
import { PuzzleGenerationService } from '../src/analysis/puzzle-generation-service.js';
import { DEFAULT_RATE_LIMIT } from '../src/config.js';
import { startHarness } from './helpers.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

class StubProvider implements AnalysisProvider {
  calls = 0;
  error?: Error;
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.calls += 1;
    if (this.error) throw this.error;
    return [
      line(1, 350, ['e2e4', 'e7e5']),
      line(2, 80, ['d2d4', 'd7d5']),
      line(3, 20, ['g1f3', 'g8f6']),
    ];
  }
  async play(_request: PlayRequest): Promise<PlayResult> { throw new Error('not used'); }
  capabilitiesFor(_variant: string): EngineCapabilities | undefined { return undefined; }
}

function service(options: { supportsVariant?: (variant: string) => boolean } = {}) {
  const provider = new StubProvider();
  const analysis = new AnalysisService({
    provider,
    ...(options.supportsVariant ? { supportsVariant: options.supportsVariant } : {}),
  });
  const puzzles = createPuzzleGeneration(analysis);
  assert.ok(puzzles !== undefined);
  return { provider, service: puzzles };
}

test('POST /v1/analysis/puzzle authenticates and returns the JSON-safe puzzle contract', async () => {
  const generated = service();
  const h = await startHarness({}, { puzzleGeneration: generated.service });
  try {
    const unauthenticated = await h.json('POST', '/v1/analysis/puzzle', {
      body: { fen: START_FEN, variant: 'standard' },
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(generated.provider.calls, 0);

    const user = await h.makeUser('puzzler');
    const response = await h.json('POST', '/v1/analysis/puzzle', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.kind, 'puzzle');
    assert.deepEqual(response.body.evidence, { kind: 'centipawn_gap', gapCp: 270 });
    assert.equal(generated.provider.calls, 1);
    assert.doesNotMatch(JSON.stringify(response.body), /Infinity|NaN|\(none\)/);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis/puzzle accepts no caller-owned engine or classification policy', async () => {
  const generated = service();
  const h = await startHarness({}, { puzzleGeneration: generated.service });
  try {
    const user = await h.makeUser('policyprobe');
    for (const field of ['depth', 'movetimeMs', 'multiPv', 'threshold', 'model']) {
      const response = await h.json('POST', '/v1/analysis/puzzle', {
        token: user.token,
        body: { fen: START_FEN, variant: 'standard', [field]: 1 },
      });
      assert.equal(response.status, 422, field);
    }
    assert.equal(generated.provider.calls, 0);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis/puzzle rejects unsupported variants before engine work', async () => {
  const generated = service({ supportsVariant: (variant) => variant === 'standard' });
  const h = await startHarness({}, { puzzleGeneration: generated.service });
  try {
    const user = await h.makeUser('variantprobe');
    const response = await h.json('POST', '/v1/analysis/puzzle', {
      token: user.token,
      body: { fen: START_FEN, variant: 'atomic' },
    });
    assert.equal(response.status, 422);
    assert.equal(generated.provider.calls, 0);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis/puzzle returns 503 when the production capability is absent', async () => {
  const h = await startHarness();
  try {
    const user = await h.makeUser('nopuzzles');
    const response = await h.json('POST', '/v1/analysis/puzzle', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard' },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'service_unavailable');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis/puzzle redacts engine failures', async () => {
  const generated = service();
  generated.provider.error = new EngineError(
    'engine_crashed',
    'Stockfish /usr/local/bin/private-engine crashed with SIGSEGV',
  );
  const h = await startHarness({}, { puzzleGeneration: generated.service });
  try {
    const user = await h.makeUser('brokenengine');
    const response = await h.json('POST', '/v1/analysis/puzzle', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard' },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'service_unavailable');
    assert.equal(response.body.error.message, 'analysis engine failed');
    assert.doesNotMatch(JSON.stringify(response.body), /private-engine|SIGSEGV/);
  } finally {
    await h.close();
  }
});

test('malformed positions do not consume puzzle-generation quota', async () => {
  const generated = service();
  const h = await startHarness({
    rateLimit: {
      ...DEFAULT_RATE_LIMIT,
      puzzleGeneration: {
        perUser: { maxRequests: 1, windowMs: 60_000 },
        perIp: { maxRequests: 10, windowMs: 60_000 },
      },
    },
  }, { puzzleGeneration: generated.service });
  try {
    const user = await h.makeUser('cheapinvalid');
    const malformed = await h.json('POST', '/v1/analysis/puzzle', {
      token: user.token,
      body: { fen: `${START_FEN}\nquit`, variant: 'standard' },
    });
    assert.equal(malformed.status, 422);
    const valid = await h.json('POST', '/v1/analysis/puzzle', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard' },
    });
    assert.equal(valid.status, 200);
    assert.equal(generated.provider.calls, 1);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis/puzzle has a separate per-user expensive-work quota', async () => {
  const generated = service();
  const h = await startHarness({
    rateLimit: {
      ...DEFAULT_RATE_LIMIT,
      puzzleGeneration: {
        perUser: { maxRequests: 1, windowMs: 60_000 },
        perIp: { maxRequests: 10, windowMs: 60_000 },
      },
    },
  }, { puzzleGeneration: generated.service });
  try {
    const user = await h.makeUser('ratedpuzzler');
    const request = { token: user.token, body: { fen: START_FEN, variant: 'standard' } };
    assert.equal((await h.json('POST', '/v1/analysis/puzzle', request)).status, 200);
    const limited = await h.json('POST', '/v1/analysis/puzzle', request);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get('retry-after'));
    assert.equal(generated.provider.calls, 1);
  } finally {
    await h.close();
  }
});

test('GET /v1/capabilities reports puzzle availability and its exact variant subset', async () => {
  const generated = service({ supportsVariant: (variant) => variant === 'standard' });
  const h = await startHarness({}, { puzzleGeneration: generated.service });
  try {
    const response = await h.json('GET', '/v1/capabilities');
    assert.equal(response.body.capabilities.puzzleGeneration, true);
    assert.deepEqual(response.body.puzzleVariants, ['standard']);
  } finally {
    await h.close();
  }
});

test('GET /v1/capabilities disables puzzle generation when routed engines cannot honor MultiPV 3', async () => {
  const provider = new StubProvider();
  const analysis = new AnalysisService({
    provider,
    supportsVariant: () => true,
    supportsMultiPv: () => false,
  });
  const h = await startHarness({}, {
    puzzleGeneration: new PuzzleGenerationService({ analysis }),
  });
  try {
    const response = await h.json('GET', '/v1/capabilities');
    assert.equal(response.body.capabilities.puzzleGeneration, false);
    assert.deepEqual(response.body.puzzleVariants, []);
  } finally {
    await h.close();
  }
});

function line(multipv: number, value: number, principalVariation: readonly string[]): EngineResult {
  return {
    multipv,
    evaluation: { type: 'cp', value },
    principalVariation,
    depth: 16,
    selDepth: 18,
    nodes: 1_000,
    nps: 2_000,
    timeMs: 500,
  };
}
