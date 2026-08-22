/**
 * Coach route tests (ADR-0129).
 *
 * The service tests cover what the Coach says; these cover what the endpoint costs and who may ask.
 * Two of them are the reason the route exists in this shape: the one proving a client cannot buy a
 * deeper search by asking for one, and the one proving that orchestrating five services internally
 * charges the Coach's quota once rather than each of their route quotas as well.
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
import { createMistakePrediction, createPuzzleGeneration } from '../src/analysis/composition.js';

/** The position after 1.e4 e5 2.Nf3 Nc6 3.Bc4 — a real book line, so the opening section fires. */
const ITALIAN_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';
const ITALIAN_MOVES = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'];

class StubProvider implements AnalysisProvider {
  readonly requests: AnalysisRequest[] = [];

  /**
   * @param request - recorded so the limits assertions can read what the engine was actually asked.
   * @returns a flat, unremarkable evaluation; these tests are about cost and access, not chess.
   */
  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.requests.push(request);
    const count = request.multiPv ?? 1;
    return Array.from({ length: count }, (_unused, i) => ({
      multipv: i + 1,
      evaluation: { type: 'cp' as const, value: 25 - i * 5 },
      principalVariation: ['g8f6', 'd2d3'],
      depth: 16,
      nodes: 1000,
      nps: 100000,
      timeMs: 10,
    }));
  }

  /** Never reached: coaching only ever analyses. Throwing says so rather than returning a lie. */
  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not used');
  }

  /** @returns `undefined`: the stub declares no engine capabilities, so nothing is narrowed. */
  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

test('POST /v1/coach requires authentication and returns every section', async () => {
  const h = await startHarness({}, { analysis: new AnalysisService({ provider: new StubProvider() }) });
  try {
    const unauthed = await h.json('POST', '/v1/coach', {
      body: { fen: ITALIAN_FEN, variant: 'standard' },
    });
    assert.equal(unauthed.status, 401);

    const user = await h.makeUser('coachlearner');
    const res = await h.json('POST', '/v1/coach', {
      token: user.token,
      body: { fen: ITALIAN_FEN, variant: 'standard', moves: ITALIAN_MOVES },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'endgame', 'explanation', 'featuresFired', 'fen', 'mistake', 'move', 'opening', 'puzzle', 'variant',
    ]);
    // Every section is present-or-omitted, never absent and never null.
    for (const name of ['mistake', 'explanation', 'opening', 'puzzle', 'endgame']) {
      const section = res.body[name] as { kind?: string };
      assert.ok(
        section.kind === 'present' || section.kind === 'omitted',
        `${name} was neither present nor omitted`,
      );
    }
    assert.equal(res.body.opening.kind, 'present');
    assert.equal(res.body.opening.value.found, true);
  } finally {
    await h.close();
  }
});

test('a client cannot name a depth, a MultiPV, a movetime or a provider', async () => {
  const provider = new StubProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('coachgreedy');

    // Every one of these is server-owned policy, and `strictObject` refuses the request outright
    // rather than ignoring the field — a client that tries is told, instead of quietly believing it
    // got a depth-40 search.
    for (const extra of [
      { depth: 40 },
      { multiPv: 5 },
      { movetimeMs: 60_000 },
      { nodes: 10 ** 9 },
      { threshold: 10 },
      { provider: 'openai' },
      { model: 'gpt-4' },
      { temperature: 2 },
      { maxTokens: 100_000 },
    ]) {
      const res = await h.json('POST', '/v1/coach', {
        token: user.token,
        body: { fen: ITALIAN_FEN, variant: 'standard', ...extra },
      });
      assert.equal(res.status, 422, `${Object.keys(extra)[0] ?? '?'} was not refused`);
    }

    // And what the engine was actually asked for is the server's fixed policy throughout.
    await h.json('POST', '/v1/coach', {
      token: user.token,
      body: { fen: ITALIAN_FEN, variant: 'standard', move: 'g8f6' },
    });
    assert.ok(provider.requests.length > 0);
    for (const request of provider.requests) {
      assert.equal(request.limits.depth, 16);
      assert.equal(request.limits.timeMs, 1000);
      assert.ok((request.multiPv ?? 1) <= 3);
    }
  } finally {
    await h.close();
  }
});

test('coaching has its own quota, and spends no other feature quota while composing them', async () => {
  const provider = new StubProvider();
  const analysis = new AnalysisService({ provider });
  const puzzleGeneration = createPuzzleGeneration(analysis);
  const h = await startHarness(
    {
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        coach: {
          perUser: { maxRequests: 2, windowMs: 60_000 },
          perIp: { maxRequests: 10, windowMs: 60_000 },
        },
        // Deliberately tiny. If orchestrating the services internally also charged their own route
        // buckets — the thing this test exists to rule out — one coaching request would exhaust
        // these and the follow-up calls below would answer 429.
        mistakePrediction: { perUser: { maxRequests: 1, windowMs: 60_000 }, perIp: { maxRequests: 1, windowMs: 60_000 } },
        puzzleGeneration: { perUser: { maxRequests: 1, windowMs: 60_000 }, perIp: { maxRequests: 1, windowMs: 60_000 } },
        openingExploration: { perUser: { maxRequests: 1, windowMs: 60_000 }, perIp: { maxRequests: 1, windowMs: 60_000 } },
      },
    },
    {
      analysis,
      mistakePrediction: createMistakePrediction(analysis),
      ...(puzzleGeneration ? { puzzleGeneration } : {}),
    },
  );
  try {
    const user = await h.makeUser('coachquota');
    const body = { fen: ITALIAN_FEN, variant: 'standard', move: 'g8f6', moves: ITALIAN_MOVES };

    for (const attempt of [1, 2]) {
      const res = await h.json('POST', '/v1/coach', { token: user.token, body });
      assert.equal(res.status, 200, `coaching request ${String(attempt)} allowed`);
    }
    const limited = await h.json('POST', '/v1/coach', { token: user.token, body });
    assert.equal(limited.status, 429, 'the coach bucket did not bind');

    // The feature routes are each still holding their full single-request budget, which is only
    // possible if composing them internally charged none of it. This is the property that makes the
    // Coach's quota the whole cost of a coaching request rather than one charge among six.
    const opening = await h.json('POST', '/v1/openings/explore', {
      token: user.token,
      body: { variant: 'standard', moves: ITALIAN_MOVES },
    });
    assert.equal(opening.status, 200, 'coaching had already spent the opening quota');

    const puzzle = await h.json('POST', '/v1/analysis/puzzle', {
      token: user.token,
      body: { fen: ITALIAN_FEN, variant: 'standard' },
    });
    assert.equal(puzzle.status, 200, 'coaching had already spent the puzzle quota');
  } finally {
    await h.close();
  }
});

test('a refused request spends no quota, so junk cannot empty a budget', async () => {
  const h = await startHarness(
    {
      rateLimit: {
        ...DEFAULT_RATE_LIMIT,
        coach: {
          perUser: { maxRequests: 1, windowMs: 60_000 },
          perIp: { maxRequests: 10, windowMs: 60_000 },
        },
      },
    },
    { analysis: new AnalysisService({ provider: new StubProvider() }) },
  );
  try {
    const user = await h.makeUser('coachjunk');

    // Four malformed requests against a budget of one.
    //
    // The last one is the one that distinguishes where the bound lives. A junk `moves` entry is
    // refused downstream too — the opening service validates every move it replays — but that
    // happens *after* `onAccepted`, so without the route-level length check the caller is charged
    // for a request that was never well-formed. Refusing it while parsing the body costs nothing.
    for (const body of [
      { fen: 'nonsense', variant: 'standard' },
      { fen: ITALIAN_FEN, variant: 'standard', move: 'zzzz' },
      { fen: ITALIAN_FEN, variant: 'standard', move: 'a1a8' },
      { fen: ITALIAN_FEN, variant: 'standard', moves: ['e2e4', 'x'.repeat(100_000)] },
    ]) {
      const res = await h.json('POST', '/v1/coach', { token: user.token, body });
      assert.equal(res.status, 422);
    }

    // The budget is intact, because none of them was ever a real request.
    const good = await h.json('POST', '/v1/coach', {
      token: user.token,
      body: { fen: ITALIAN_FEN, variant: 'standard' },
    });
    assert.equal(good.status, 200, 'malformed requests had spent the quota');
  } finally {
    await h.close();
  }
});

test('a deployment with no coaching answers 503 and reports the capability as false', async () => {
  const h = await startHarness(
    {},
    { withoutCoach: true, withoutOpeningExploration: true, withoutEndgameTraining: true },
  );
  try {
    const user = await h.makeUser('coachless');
    const res = await h.json('POST', '/v1/coach', {
      token: user.token,
      body: { fen: ITALIAN_FEN, variant: 'standard' },
    });
    assert.equal(res.status, 503);

    const capabilities = await h.json('GET', '/v1/capabilities', {});
    assert.equal(capabilities.body.capabilities.coach, false);
  } finally {
    await h.close();
  }
});

test('an engineless deployment still coaches openings, and says so section by section', async () => {
  const h = await startHarness({}, { withoutEndgameTraining: true });
  try {
    const user = await h.makeUser('coachnoengine');
    const res = await h.json('POST', '/v1/coach', {
      token: user.token,
      body: { fen: ITALIAN_FEN, variant: 'standard', moves: ITALIAN_MOVES },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.opening.kind, 'present');
    // `mistake` is `not_requested` because this body supplies no move — the question was never
    // asked, which takes precedence over whether this deployment could have answered it. `puzzle`
    // is the one that shows the capability gap: it needs no move, so the only reason it is empty is
    // that there is no engine here and never will be within this page's lifetime.
    assert.deepEqual(res.body.mistake, { kind: 'omitted', reason: 'not_requested' });
    assert.deepEqual(res.body.puzzle, { kind: 'omitted', reason: 'unsupported' });

    const capabilities = await h.json('GET', '/v1/capabilities', {});
    assert.equal(capabilities.body.capabilities.coach, true);
    assert.equal(capabilities.body.capabilities.analysis, false);
  } finally {
    await h.close();
  }
});

test('a moves entry that is not a UCI move is refused, however long it is', async () => {
  const provider = new StubProvider();
  const h = await startHarness({}, { analysis: new AnalysisService({ provider }) });
  try {
    const user = await h.makeUser('coachlongmoves');

    // The array cap alone bounds the count, not the size: 60 entries of 100KB each satisfies it and
    // the overall body limit, and every one would be replayed through the rules. The schema has
    // always promised `minLength: 2, maxLength: 6` per entry; the route now enforces it.
    // Raised in the adversarial review of PR #152.
    const oversized = await h.json('POST', '/v1/coach', {
      token: user.token,
      body: { fen: ITALIAN_FEN, variant: 'standard', moves: ['e2e4', 'x'.repeat(100_000)] },
    });
    assert.equal(oversized.status, 422);

    const tooShort = await h.json('POST', '/v1/coach', {
      token: user.token,
      body: { fen: ITALIAN_FEN, variant: 'standard', moves: ['e'] },
    });
    assert.equal(tooShort.status, 422);

    // Nothing reached the engine for either.
    assert.equal(provider.requests.length, 0);
  } finally {
    await h.close();
  }
});
