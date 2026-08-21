/**
 * Endgame training route tests (ADR-0128).
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
import { AnalysisService } from '../src/analysis/service.js';
import { DEFAULT_RATE_LIMIT } from '../src/config.js';
import { startHarness } from './helpers.js';

class StubProvider implements AnalysisProvider {
  calls = 0;
  /**
   * Mate for the side to move, before and after.
   *
   * The two calls must differ in sign. Engine evaluations are always from the perspective of the
   * side to move, so after the learner's move it is the opponent's turn and a mate the learner is
   * still delivering reads as `-1` there. Returning `+2` twice would negate to mate *against* the
   * learner and classify a winning move as throwing the game away.
   */
  async analyze(_request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.calls += 1;
    const evaluation: EngineResult['evaluation'] =
      this.calls === 1 ? { type: 'mate', value: 2 } : { type: 'mate', value: -1 };
    return [
      {
        multipv: 1,
        evaluation,
        principalVariation: ['g6g7'],
        depth: 16,
        nodes: 1000,
        nps: 100000,
        timeMs: 10,
      },
    ];
  }
  /** Never reached: this service only ever analyses. */
  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not used');
  }
  /** @returns `undefined`: the stub declares no engine capabilities, so nothing is narrowed. */
  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

test('POST /v1/endgames/next requires authentication and returns public position view', async () => {
  const h = await startHarness(
    {},
    { analysis: new AnalysisService({ provider: new StubProvider() }) },
  );
  try {
    const unauthed = await h.json('POST', '/v1/endgames/next', {
      body: { id: 'kq-vs-k-01' },
    });
    assert.equal(unauthed.status, 401);

    const user = await h.makeUser('endgamelearner');
    const response = await h.json('POST', '/v1/endgames/next', {
      token: user.token,
      body: { id: 'kq-vs-k-01' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), [
      'difficulty',
      'fen',
      'id',
      'name',
      'objective',
      'sideToMove',
      'technique',
      'type',
    ]);
    assert.equal(response.body.id, 'kq-vs-k-01');
    assert.equal(response.body.objective, 'mate');
  } finally {
    await h.close();
  }
});

test('POST /v1/endgames/attempt requires authentication and returns evaluation view', async () => {
  const provider = new StubProvider();
  const h = await startHarness(
    {},
    { analysis: new AnalysisService({ provider }) },
  );
  try {
    const unauthed = await h.json('POST', '/v1/endgames/attempt', {
      body: { id: 'kq-vs-k-01', move: 'g6g7' },
    });
    assert.equal(unauthed.status, 401);

    const user = await h.makeUser('endgamemover');
    const response = await h.json('POST', '/v1/endgames/attempt', {
      token: user.token,
      body: { id: 'kq-vs-k-01', move: 'g6g7' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.id, 'kq-vs-k-01');
    assert.equal(response.body.classification, 'optimal');
    assert.equal(response.body.goalPreserved, true);
    assert.deepEqual(response.body.loss, { kind: 'centipawns', value: 0 });
    assert.equal(response.body.betterMove, 'g6g7');
  } finally {
    await h.close();
  }
});

test('POST /v1/endgames/* endpoints reject unexpected properties (strict body)', async () => {
  const h = await startHarness(
    {},
    { analysis: new AnalysisService({ provider: new StubProvider() }) },
  );
  try {
    const user = await h.makeUser('strictprobe');
    for (const field of ['fen', 'goal', 'solution', 'entry', 'depth']) {
      const nextRes = await h.json('POST', '/v1/endgames/next', {
        token: user.token,
        body: { id: 'kq-vs-k-01', [field]: 'forbidden' },
      });
      assert.equal(nextRes.status, 422, `next rejects ${field}`);

      const attemptRes = await h.json('POST', '/v1/endgames/attempt', {
        token: user.token,
        body: { id: 'kq-vs-k-01', move: 'g6g7', [field]: 'forbidden' },
      });
      assert.equal(attemptRes.status, 422, `attempt rejects ${field}`);
    }
  } finally {
    await h.close();
  }
});

test('POST /v1/endgames/* returns 503 when endgame training is not configured', async () => {
  const h = await startHarness({}, { withoutEndgameTraining: true });
  try {
    const user = await h.makeUser('notraining');
    const nextRes = await h.json('POST', '/v1/endgames/next', {
      token: user.token,
      body: { id: 'kq-vs-k-01' },
    });
    assert.equal(nextRes.status, 503);

    const attemptRes = await h.json('POST', '/v1/endgames/attempt', {
      token: user.token,
      body: { id: 'kq-vs-k-01', move: 'g6g7' },
    });
    assert.equal(attemptRes.status, 503);
  } finally {
    await h.close();
  }
});

test('endgame training has its own rate-limiting quota that does not deplete analysis', async () => {
  const provider = new StubProvider();
  const h = await startHarness(
    {
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        endgameTraining: {
          perUser: { maxRequests: 2, windowMs: 60_000 },
          perIp: { maxRequests: 10, windowMs: 60_000 },
        },
      },
    },
    { analysis: new AnalysisService({ provider }) },
  );
  try {
    const user = await h.makeUser('endgamequota');
    for (const attempt of [1, 2]) {
      const res = await h.json('POST', '/v1/endgames/next', {
        token: user.token,
        body: { id: 'kq-vs-k-01' },
      });
      assert.equal(res.status, 200, `request ${attempt} allowed`);
    }

    const limited = await h.json('POST', '/v1/endgames/next', {
      token: user.token,
      body: { id: 'kq-vs-k-01' },
    });
    assert.equal(limited.status, 429);

    // Analysis bucket remains untouched:
    const analysisRes = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: '7k/8/6Q1/8/8/8/8/4K3 w - - 0 1', variant: 'standard' },
    });
    assert.equal(analysisRes.status, 200);
  } finally {
    await h.close();
  }
});

test('GET /v1/capabilities reports endgameTrainer boolean capability', async () => {
  const present = await startHarness(
    {},
    { analysis: new AnalysisService({ provider: new StubProvider() }) },
  );
  try {
    const res = await present.json('GET', '/v1/capabilities');
    assert.equal(res.body.capabilities.endgameTrainer, true);
    assert.equal('endgameVariants' in res.body, false, 'no variant list');
  } finally {
    await present.close();
  }

  const absent = await startHarness({}, { withoutEndgameTraining: true });
  try {
    const res = await absent.json('GET', '/v1/capabilities');
    assert.equal(res.body.capabilities.endgameTrainer, false);
  } finally {
    await absent.close();
  }
});