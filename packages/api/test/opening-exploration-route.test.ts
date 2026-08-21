/**
 * `POST /v1/openings/explore` — the wire contract, the refusals, and the quota.
 *
 * The service suite owns identification behaviour. What is asserted here is what only the route
 * decides: who may call it, which bodies it will not accept, what a deployment without the feature
 * answers, and that the bucket charged is the ordinary one rather than the engine quota.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisProvider } from '@chess-platform/engine';
import { AnalysisService } from '../src/analysis/service.js';
import { DEFAULT_RATE_LIMIT } from '../src/config.js';
import {
  MAX_EXPLORED_PLIES,
  STANDARD_START_FEN,
} from '../src/openings/opening-exploration-service.js';
import { startHarness } from './helpers.js';

/** 1.e4 e5 2.Nf3 Nc6 3.Bb5 — a line the bundled dataset names, so a 200 carries real fields. */
const RUY_LOPEZ = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];

/** Enough of an engine for `POST /v1/analysis` to reach rate-limit admission and answer 200. */
const stubProvider: AnalysisProvider = {
  analyze: async () => [
    {
      multipv: 1,
      evaluation: { type: 'cp', value: 20 },
      principalVariation: ['e2e4'],
      depth: 12,
      nodes: 1000,
      nps: 100000,
      timeMs: 10,
    },
  ],
  play: async () => { throw new Error('not implemented in stub'); },
  capabilitiesFor: () => undefined,
};

test('POST /v1/openings/explore requires a bearer token and returns the published shape', async () => {
  const h = await startHarness();
  try {
    const anonymous = await h.json('POST', '/v1/openings/explore', {
      body: { variant: 'standard', moves: RUY_LOPEZ },
    });
    assert.equal(anonymous.status, 401);

    const user = await h.makeUser('bookreader');
    const response = await h.json('POST', '/v1/openings/explore', {
      token: user.token,
      body: { variant: 'standard', moves: RUY_LOPEZ },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), [
      'continuations', 'eco', 'found', 'matchedMoves', 'moves', 'name', 'outOfBook',
    ]);
    assert.equal(response.body.eco, 'C60');
    assert.equal(response.body.matchedMoves, 5);
    assert.deepEqual(response.body.moves, RUY_LOPEZ);
  } finally {
    await h.close();
  }
});

/** The projection is the only path to the wire; this asserts nothing reintroduces the figures. */
test('the response carries no opening statistics', async () => {
  const h = await startHarness();
  try {
    const user = await h.makeUser('statprobe');
    const response = await h.json('POST', '/v1/openings/explore', {
      token: user.token,
      body: { variant: 'standard', moves: RUY_LOPEZ },
    });
    assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.body), /stats|games|whiteWins|draws|blackWins/);
    for (const continuation of response.body.continuations) {
      assert.deepEqual(Object.keys(continuation).sort(), ['eco', 'move', 'name', 'san']);
    }
  } finally {
    await h.close();
  }
});

test('POST /v1/openings/explore refuses every unservable request with 422', async () => {
  const h = await startHarness();
  try {
    const user = await h.makeUser('refusals');
    const cases: readonly (readonly [string, unknown])[] = [
      ['a variant the book does not describe', { variant: 'crazyhouse', moves: ['e2e4'] }],
      ['a variant that is not a variant', { variant: 'nonsense', moves: ['e2e4'] }],
      ['a non-standard starting position', {
        variant: 'standard',
        moves: ['e2e4'],
        initialFen: '8/8/8/8/8/8/8/K6k w - - 0 1',
      }],
      ['a move that is not UCI', { variant: 'standard', moves: ['xx99'] }],
      ['a legal-looking but illegal sequence', { variant: 'standard', moves: ['e2e4', 'e2e4'] }],
      ['a sequence past the ceiling', {
        variant: 'standard',
        moves: new Array<string>(MAX_EXPLORED_PLIES + 1).fill('e2e4'),
      }],
      ['moves that are not an array', { variant: 'standard', moves: 'e2e4' }],
      ['an array holding something other than a string', { variant: 'standard', moves: ['e2e4', 7] }],
      ['a missing move list', { variant: 'standard' }],
      ['a missing variant', { moves: ['e2e4'] }],
    ];
    for (const [label, body] of cases) {
      const response = await h.json('POST', '/v1/openings/explore', { token: user.token, body });
      assert.equal(response.status, 422, label);
    }
  } finally {
    await h.close();
  }
});

/**
 * No caller-owned policy. Depth, matching rules and the book itself are the server's; a body that
 * tries to name any of them is refused whole rather than having the extra field ignored.
 */
test('POST /v1/openings/explore accepts no property beyond the three it publishes', async () => {
  const h = await startHarness();
  try {
    const user = await h.makeUser('policyprobe');
    for (const field of ['depth', 'limits', 'database', 'stats', 'fen']) {
      const response = await h.json('POST', '/v1/openings/explore', {
        token: user.token,
        body: { variant: 'standard', moves: RUY_LOPEZ, [field]: 1 },
      });
      assert.equal(response.status, 422, field);
    }

    const stated = await h.json('POST', '/v1/openings/explore', {
      token: user.token,
      body: { variant: 'standard', moves: RUY_LOPEZ, initialFen: STANDARD_START_FEN },
    });
    assert.equal(stated.status, 200, 'initialFen is published, so it is accepted when it agrees');
  } finally {
    await h.close();
  }
});

test('POST /v1/openings/explore returns 503 on a deployment without the feature', async () => {
  const h = await startHarness({}, { withoutOpeningExploration: true });
  try {
    const user = await h.makeUser('nobook');
    const response = await h.json('POST', '/v1/openings/explore', {
      token: user.token,
      body: { variant: 'standard', moves: RUY_LOPEZ },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'service_unavailable');
  } finally {
    await h.close();
  }
});

/**
 * The bucket is its own, not a share of the analysis one.
 *
 * The analysis service is injected on purpose: without it `POST /v1/analysis` answers 503 *before*
 * rate-limit admission, so the closing assertion would pass even if the two endpoints shared a
 * bucket — it would be measuring the absence of an engine, not the separation of quotas. Raised in
 * the CodeRabbit review of PR #150.
 */
test('POST /v1/openings/explore has its own per-user bucket, separate from analysis quota', async () => {
  const h = await startHarness({
    rateLimit: {
      ...DEFAULT_RATE_LIMIT,
      openingExploration: {
        perUser: { maxRequests: 2, windowMs: 60_000 },
        perIp: { maxRequests: 50, windowMs: 60_000 },
      },
    },
  }, { analysis: new AnalysisService({ provider: stubProvider }) });
  try {
    const user = await h.makeUser('quota');
    for (const attempt of [1, 2]) {
      const allowed = await h.json('POST', '/v1/openings/explore', {
        token: user.token,
        body: { variant: 'standard', moves: RUY_LOPEZ },
      });
      assert.equal(allowed.status, 200, `attempt ${attempt} is within the bucket`);
    }
    const refused = await h.json('POST', '/v1/openings/explore', {
      token: user.token,
      body: { variant: 'standard', moves: RUY_LOPEZ },
    });
    assert.equal(refused.status, 429);

    // The engine bucket is untouched: exhausting the book does not ration analysis, which is the
    // reason this endpoint does not share the `analysis` limit. Asserted as a 200 rather than as
    // "not 429", so the endpoint has to actually have been served.
    const analysis = await h.json('POST', '/v1/analysis', {
      token: user.token,
      body: { fen: STANDARD_START_FEN, variant: 'standard' },
    });
    assert.equal(analysis.status, 200);
  } finally {
    await h.close();
  }
});

test('GET /v1/capabilities reports openingExplorer against the composed dependency', async () => {
  const present = await startHarness();
  try {
    const res = await present.json('GET', '/v1/capabilities');
    assert.equal(res.body.capabilities.openingExplorer, true);
    assert.equal(
      res.body.capabilities.analysis,
      false,
      'and it is true with no engine at all, unlike every other feature flag',
    );
    assert.equal(
      'openingVariants' in res.body,
      false,
      'no variant list: the feature serves exactly standard and must not look like a growable set',
    );
  } finally {
    await present.close();
  }

  const absent = await startHarness({}, { withoutOpeningExploration: true });
  try {
    const res = await absent.json('GET', '/v1/capabilities');
    assert.equal(res.body.capabilities.openingExplorer, false);
  } finally {
    await absent.close();
  }
});
