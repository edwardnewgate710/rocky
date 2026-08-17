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
import { QueueFullError } from '@chess-platform/engine';
import { DEFAULT_ANALYSIS_LIMITS } from '../src/analysis/limits';
import { AnalysisService } from '../src/analysis/service';
import { DEFAULT_RATE_LIMIT } from '../src/config';
import { startHarness } from './helpers';

class StubAnalysisProvider implements AnalysisProvider {
  response: readonly EngineResult[] = [];
  errorToThrow?: Error;
  lastRequest?: AnalysisRequest;

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
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

function createMockLines(): readonly EngineResult[] {
  return [
    {
      multipv: 1,
      evaluation: { type: 'cp', value: 25 },
      principalVariation: ['e2e4', 'e7e5'],
      depth: 16,
      selDepth: 20,
      nodes: 123456,
      nps: 500000,
      timeMs: 900,
    },
  ];
}

test('POST /v1/analysis: unauthenticated request -> 401', async () => {
  const provider = new StubAnalysisProvider();
  provider.response = createMockLines();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const res = await h.json('POST', '/v1/analysis', {
      body: { fen: START_FEN, variant: 'standard' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthorized');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: deps.analysis absent -> 503, takes precedence over malformed body', async () => {
  const h = await startHarness();
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { invalidField: true, variant: 'not-a-variant' },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.body.error.message, 'analysis is not configured');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: happy path -> 200 with documented shape', async () => {
  const provider = new StubAnalysisProvider();
  provider.response = createMockLines();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: {
        fen: START_FEN,
        variant: 'standard',
        depth: 16,
        movetimeMs: 1000,
        multiPv: 1,
        nodes: 500000,
      },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      fen: START_FEN,
      variant: 'standard',
      applied: { depth: 16, movetimeMs: 1000, multiPv: 1, nodes: 500000 },
      lines: [
        {
          multipv: 1,
          evaluation: { type: 'cp', value: 25 },
          moves: ['e2e4', 'e7e5'],
          depth: 16,
          nodes: 123456,
          timeMs: 900,
        },
      ],
    });
    assert.equal((res.body.lines[0] as Record<string, unknown>)['nps'], undefined);
    assert.equal((res.body.lines[0] as Record<string, unknown>)['selDepth'], undefined);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: unknown field in the body -> 422 (strictObject)', async () => {
  const provider = new StubAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: {
        fen: START_FEN,
        variant: 'standard',
        bogus: 'unexpected-property',
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: missing fen -> 422', async () => {
  const provider = new StubAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: {
        variant: 'standard',
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: depth above DEFAULT_ANALYSIS_LIMITS.maxDepth -> 422', async () => {
  const provider = new StubAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: {
        fen: START_FEN,
        variant: 'standard',
        depth: DEFAULT_ANALYSIS_LIMITS.maxDepth + 1,
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: multiPv of 0 or negative -> 422', async () => {
  const provider = new StubAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');
    const res0 = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: {
        fen: START_FEN,
        variant: 'standard',
        multiPv: 0,
      },
    });
    assert.equal(res0.status, 422);
    assert.equal(res0.body.error.code, 'validation_failed');

    const resNeg = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: {
        fen: START_FEN,
        variant: 'standard',
        multiPv: -1,
      },
    });
    assert.equal(resNeg.status, 422);
    assert.equal(resNeg.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: unknown variant -> 422', async () => {
  const provider = new StubAnalysisProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: {
        fen: START_FEN,
        variant: 'invalid_variant',
      },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'validation_failed');
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: per-user rate limit exceeded -> 429 with a Retry-After header', async () => {
  const provider = new StubAnalysisProvider();
  provider.response = createMockLines();
  const h = await startHarness(
    {
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        enabled: true,
        analysis: {
          perUser: { maxRequests: 2, windowMs: 60 * 1000 },
          perIp: { maxRequests: 60, windowMs: 60 * 1000 },
        },
      },
    },
    { analysis: new AnalysisService({ provider }) },
  );
  try {
    const user = await h.makeUser('alice');

    for (let i = 0; i < 2; i++) {
      const res = await h.json('POST', '/v1/analysis', {
        token: user.token,
        body: { fen: START_FEN, variant: 'standard' },
      });
      assert.equal(res.status, 200);
    }

    const resBlocked = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard' },
    });
    assert.equal(resBlocked.status, 429);
    assert.equal(resBlocked.body.error.code, 'rate_limited');
    const retryAfter = resBlocked.headers.get('retry-after');
    assert.ok(retryAfter !== null && Number(retryAfter) > 0);
  } finally {
    await h.close();
  }
});

test('POST /v1/analysis: an engine failure surfaced by the service (QueueFullError) -> 503', async () => {
  const provider = new StubAnalysisProvider();
  provider.errorToThrow = new QueueFullError('analysis engine is saturated');
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('alice');
    const res = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: START_FEN, variant: 'standard' },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'service_unavailable');
    assert.equal(res.body.error.message, 'analysis engine is saturated');
    assert.equal(res.headers.get('retry-after'), '1');
  } finally {
    await h.close();
  }
});
