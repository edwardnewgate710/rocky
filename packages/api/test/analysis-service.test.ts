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
import {
  CancelledError,
  CircuitOpenError,
  EngineCrashError,
  EngineError,
  EngineTimeoutError,
  EngineVersionError,
  InvalidFenError,
  JobPriority,
  NoEngineForVariantError,
  ProtocolError,
  QueueFullError,
  ShuttingDownError,
} from '@chess-platform/engine';
import { HttpError } from '../src/http/errors';
import { DEFAULT_ANALYSIS_LIMITS } from '../src/analysis/limits';
import { AnalysisService } from '../src/analysis/service';

class FakeAnalysisProvider implements AnalysisProvider {
  lastRequest?: AnalysisRequest;
  response: readonly EngineResult[] = [];
  errorToThrow?: Error;
  delayMs?: number;

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.lastRequest = request;
    if (this.delayMs !== undefined && this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        if (request.signal) {
          request.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new CancelledError());
          });
        }
      });
    }
    if (this.errorToThrow) {
      throw this.errorToThrow;
    }
    return this.response;
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('Not implemented in fake');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('AnalysisService.analyze: successful analyze returns provider lines and applied limits', async () => {
  const provider = new FakeAnalysisProvider();
  const mockLines: EngineResult[] = [
    {
      multipv: 1,
      evaluation: { type: 'cp', value: 28 },
      principalVariation: ['e2e4', 'e7e5'],
      depth: 18,
      nodes: 50_000,
      nps: 250_000,
      timeMs: 200,
    },
  ];
  provider.response = mockLines;

  const service = new AnalysisService({ provider });
  const outcome = await service.analyze({
    fen: START_FEN,
    variant: 'standard',
    depth: 18,
  });

  assert.equal(outcome.fen, START_FEN);
  assert.equal(outcome.variant, 'standard');
  assert.deepEqual(outcome.lines, mockLines);
  assert.equal(outcome.applied.depth, 18);
  assert.equal(outcome.applied.movetimeMs, DEFAULT_ANALYSIS_LIMITS.defaultTimeMs);
  assert.equal(outcome.applied.multiPv, 1);
});

test('AnalysisService.analyze: passes mapped limits, priority, and AbortSignal to provider', async () => {
  const provider = new FakeAnalysisProvider();
  const service = new AnalysisService({ provider });

  await service.analyze({
    fen: START_FEN,
    variant: 'standard',
    depth: 14,
    movetimeMs: 800,
    nodes: 10_000,
    multiPv: 2,
  });

  const req = provider.lastRequest;
  assert.ok(req !== undefined);
  assert.equal(req.fen, START_FEN);
  assert.equal(req.variant, 'standard');
  assert.equal(req.limits.depth, 14);
  assert.equal(req.limits.timeMs, 800);
  assert.equal(req.limits.nodes, 10_000);
  assert.equal(req.multiPv, 2);
  assert.equal(req.priority, JobPriority.LiveAnalysis);
  assert.ok(req.signal !== undefined);
  assert.equal(req.signal instanceof AbortSignal, true);
});

test('AnalysisService.analyze: depth and limits above ceiling are clamped before reaching provider (bypass test)', async () => {
  const provider = new FakeAnalysisProvider();
  const service = new AnalysisService({ provider });

  await service.analyze({
    fen: START_FEN,
    variant: 'standard',
    depth: 9999,
    movetimeMs: 500_000,
    nodes: 100_000_000,
    multiPv: 99,
  });

  const req = provider.lastRequest;
  assert.ok(req !== undefined);
  assert.equal(req.limits.depth, DEFAULT_ANALYSIS_LIMITS.maxDepth);
  assert.equal(req.limits.timeMs, DEFAULT_ANALYSIS_LIMITS.maxTimeMs);
  assert.equal(req.limits.nodes, DEFAULT_ANALYSIS_LIMITS.maxNodes);
  assert.equal(req.multiPv, DEFAULT_ANALYSIS_LIMITS.maxMultiPv);
});

test('AnalysisService.analyze: maps each EngineError code to expected HttpError and prevents information leaks', async () => {
  const marker = 'SECRET_INTERNAL_BINARY_PATH_AND_MEM_DUMP_xyz123';

  const testCases: Array<{
    error: EngineError;
    expectedStatus: number;
    expectedCode: string;
    checkHeader?: { name: string; value: string };
    checkMessageContains?: string;
    checkDetailsKey?: string;
    assertNoMarkerLeak?: boolean;
  }> = [
    {
      error: new InvalidFenError(`Invalid board layout ${marker}`),
      expectedStatus: 422,
      expectedCode: 'validation_failed',
      checkDetailsKey: 'fen',
    },
    {
      error: new NoEngineForVariantError(`unknown_variant_${marker}`),
      expectedStatus: 422,
      expectedCode: 'validation_failed',
      checkDetailsKey: 'variant',
    },
    {
      error: new QueueFullError(`Queue is full ${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      checkHeader: { name: 'Retry-After', value: '1' },
      checkMessageContains: 'saturated',
    },
    {
      error: new CircuitOpenError(`Breaker tripped ${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      checkHeader: { name: 'Retry-After', value: '5' },
      checkMessageContains: 'circuit',
    },
    {
      error: new ShuttingDownError(`Engine manager stopping ${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      checkMessageContains: 'shutting down',
    },
    {
      error: new EngineTimeoutError(`Analysis timed out ${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      checkMessageContains: 'timed out',
    },
    {
      error: new CancelledError(`Operation aborted ${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      checkMessageContains: 'timed out',
    },
    {
      error: new EngineCrashError(`Process died with core at ${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      assertNoMarkerLeak: true,
    },
    {
      error: new ProtocolError(`Malformed UCI response ${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      assertNoMarkerLeak: true,
    },
    {
      error: new EngineVersionError(`Incompatible engine build ${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      assertNoMarkerLeak: true,
    },
    {
      error: new EngineError('not_initialized', `Binary not found at /usr/local/bin/${marker}`),
      expectedStatus: 503,
      expectedCode: 'service_unavailable',
      assertNoMarkerLeak: true,
    },
  ];

  for (const tc of testCases) {
    const provider = new FakeAnalysisProvider();
    provider.errorToThrow = tc.error;
    const service = new AnalysisService({ provider });

    await assert.rejects(
      () => service.analyze({ fen: START_FEN, variant: 'standard' }),
      (err: unknown) => {
        assert.ok(err instanceof HttpError, `Expected HttpError for ${tc.error.code}, got ${String(err)}`);
        assert.equal(err.status, tc.expectedStatus, `Status mismatch for ${tc.error.code}`);
        assert.equal(err.code, tc.expectedCode, `Code mismatch for ${tc.error.code}`);

        if (tc.checkHeader) {
          assert.equal(err.headers?.[tc.checkHeader.name], tc.checkHeader.value);
        }
        if (tc.checkMessageContains) {
          assert.ok(
            err.message.toLowerCase().includes(tc.checkMessageContains.toLowerCase()),
            `Expected message to contain "${tc.checkMessageContains}", got "${err.message}"`,
          );
        }
        if (tc.checkDetailsKey) {
          assert.ok(err.details !== undefined && tc.checkDetailsKey in err.details);
        }
        if (tc.assertNoMarkerLeak) {
          assert.equal(
            err.message.includes(marker),
            false,
            `Information leak detected in message for ${tc.error.code}: "${err.message}" contains "${marker}"`,
          );
        }
        return true;
      },
    );
  }
});

test('AnalysisService.analyze: non-EngineError rejection propagates unchanged', async () => {
  const provider = new FakeAnalysisProvider();
  const unexpectedBug = new TypeError('null dereference in provider');
  provider.errorToThrow = unexpectedBug;

  const service = new AnalysisService({ provider });

  await assert.rejects(
    () => service.analyze({ fen: START_FEN, variant: 'standard' }),
    (err: unknown) => {
      assert.equal(err, unexpectedBug);
      assert.equal(err instanceof HttpError, false);
      return true;
    },
  );
});

test('AnalysisService.analyze: timeout timer is cleared and does not leak handle on fast response or error', async () => {
  const originalClearTimeout = globalThis.clearTimeout;
  let clearedCount = 0;
  globalThis.clearTimeout = ((id: NodeJS.Timeout | string | number | undefined) => {
    clearedCount++;
    return originalClearTimeout(id as NodeJS.Timeout);
  }) as typeof clearTimeout;

  try {
    const provider = new FakeAnalysisProvider();
    const service = new AnalysisService({ provider });

    // Success path
    await service.analyze({ fen: START_FEN, variant: 'standard' });
    assert.equal(clearedCount, 1, 'clearTimeout must be called on success');

    // Error path
    provider.errorToThrow = new EngineTimeoutError('timed out');
    await assert.rejects(() => service.analyze({ fen: START_FEN, variant: 'standard' }));
    assert.equal(clearedCount, 2, 'clearTimeout must be called on error via finally');
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('AnalysisService.analyze: abort signal fires when request exceeds timeout grace', async () => {
  const provider = new FakeAnalysisProvider();
  provider.delayMs = 100;
  const service = new AnalysisService({
    provider,
    policy: { ...DEFAULT_ANALYSIS_LIMITS, maxTimeMs: 10, defaultTimeMs: 10 },
    timeoutGraceMs: 10,
  });

  await assert.rejects(
    () => service.analyze({ fen: START_FEN, variant: 'standard', movetimeMs: 10 }),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 503);
      assert.equal(err.code, 'service_unavailable');
      return true;
    },
  );
});
