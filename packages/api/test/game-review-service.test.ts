import test from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisPort } from '../src/analysis/service.js';
import type { MistakePredictionInput, MistakePredictionOutcome } from '../src/analysis/mistake-prediction-service.js';
import type { FinishedGameForReview } from '../src/game-review/finished-game-review.js';
import { createGameReview } from '../src/game-review/composition.js';
import { GameReviewService, MAX_REVIEWED_PLAYER_MOVES } from '../src/game-review/service.js';
import { startHarness } from './helpers.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/8/8 w - - 0 1';

const game = (overrides: Partial<FinishedGameForReview> = {}): FinishedGameForReview => ({
  gameId: '00000000-0000-4000-8000-000000000001',
  variant: 'standard',
  white: 'white-player',
  black: 'black-player',
  result: '1-0',
  termination: 'resignation',
  moves: [
    { ply: 1, uci: 'e2e4', san: 'e4', by: 'w', fenBefore: FEN },
    { ply: 2, uci: 'e7e5', san: 'e5', by: 'b', fenBefore: FEN },
    { ply: 3, uci: 'g1f3', san: 'Nf3', by: 'w', fenBefore: FEN },
  ],
  ...overrides,
});

const outcome = (input: MistakePredictionInput, classification: MistakePredictionOutcome['classification']): MistakePredictionOutcome => ({
  fen: input.fen,
  variant: input.variant,
  move: input.move,
  classification,
  before: { evalKind: 'cp', evalValue: 20, evalLabel: '+0.20' },
  after: { kind: 'evaluation', evalKind: 'cp', evalValue: 10, evalLabel: '+0.10' },
  centipawnLoss: 10,
  bestMove: input.move,
  bestLine: [input.move],
  depth: 16,
});

const reviewAnalysis: AnalysisPort = {
  analyze: async (input) => ({
    fen: input.fen,
    variant: input.variant,
    applied: { depth: 16, movetimeMs: 1_000, multiPv: 2 },
    lines: [
      { multipv: 1, evaluation: { type: 'cp', value: 20 }, principalVariation: ['e2e4'], depth: 16, nodes: 1, nps: 1, timeMs: 1 },
      { multipv: 2, evaluation: { type: 'cp', value: -150 }, principalVariation: ['d2d4'], depth: 16, nodes: 1, nps: 1, timeMs: 1 },
    ],
  }),
  supportsVariant: () => true,
  supportsMultiPv: () => true,
  canSatisfyLimits: () => true,
};

function build(source: FinishedGameForReview | undefined) {
  const assessed: MistakePredictionInput[] = [];
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return source; } },
    analysis: reviewAnalysis,
    createMoveAssessment: () => ({
      async predict(input) {
        assessed.push(input);
        return outcome(input, input.move === 'g1f3' ? 'mistake' : 'ok');
      },
    }),
  });
  return { service, assessed };
}

test('completed-game review assesses only the authenticated player moves and returns their board positions', async () => {
  const { service, assessed } = build(game());
  let charged = 0;
  const result = await service.review({
    gameId: '00000000-0000-4000-8000-000000000001',
    userId: 'white-player',
    signal: new AbortController().signal,
  }, async () => { charged += 1; });

  assert.equal(charged, 1);
  assert.deepEqual(assessed.map((entry) => entry.move), ['e2e4', 'g1f3']);
  assert.equal(result.playerColor, 'white');
  assert.deepEqual(result.summary, {
    brilliant: 0, great: 1, best: 0, excellent: 0, good: 0, book: 0,
    inaccuracy: 0, mistake: 1, miss: 0, blunder: 0, missed_win: 0,
  });
  assert.deepEqual(result.moves.map((move) => [move.ply, move.san, move.fenBefore]), [
    [1, 'e4', FEN],
    [3, 'Nf3', FEN],
  ]);
});

test('completed-game review hides a game from a non-player without charging or assessing it', async () => {
  const { service, assessed } = build(game());
  let charged = 0;
  await assert.rejects(
    () => service.review({
      gameId: '00000000-0000-4000-8000-000000000001',
      userId: 'spectator',
      signal: new AbortController().signal,
    }, async () => { charged += 1; }),
    { code: 'not_found' },
  );
  assert.equal(charged, 0);
  assert.equal(assessed.length, 0);
});

test('completed-game review rejects an overlong game before charging the player', async () => {
  const moves = Array.from({ length: MAX_REVIEWED_PLAYER_MOVES + 1 }, (_, index) => ({
    ply: index * 2 + 1,
    uci: 'e2e4',
    san: 'e4',
    by: 'w' as const,
    fenBefore: FEN,
  }));
  const { service, assessed } = build(game({ moves }));
  let charged = 0;
  await assert.rejects(
    () => service.review({
      gameId: '00000000-0000-4000-8000-000000000001',
      userId: 'white-player',
      signal: new AbortController().signal,
    }, async () => { charged += 1; }),
    { code: 'validation_failed' },
  );
  assert.equal(charged, 0);
  assert.equal(assessed.length, 0);
});

test('completed-game review rejects an unsupported engine policy before charging the player', async () => {
  let analyzed = 0;
  const unsupportedAnalysis: AnalysisPort = {
    ...reviewAnalysis,
    analyze: async (input) => {
      analyzed += 1;
      return reviewAnalysis.analyze(input);
    },
    supportsMultiPv: () => false,
  };
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return game(); } },
    analysis: unsupportedAnalysis,
    createMoveAssessment: () => ({ async predict(input) { return outcome(input, 'ok'); } }),
  });
  let charged = 0;

  await assert.rejects(
    () => service.review({
      gameId: game().gameId,
      userId: 'white-player',
      signal: new AbortController().signal,
    }, async () => { charged += 1; }),
    { code: 'validation_failed' },
  );
  assert.equal(charged, 0);
  assert.equal(analyzed, 0);
});

test('Game Review composition stays absent unless one variant can honor its exact policy', () => {
  const archive = { async finishedGameForReview() { return undefined; } };
  const insufficientLimits: AnalysisPort = {
    ...reviewAnalysis,
    canSatisfyLimits: () => false,
  };
  const noMultiPv: AnalysisPort = {
    ...reviewAnalysis,
    supportsMultiPv: () => false,
  };
  const standardOnly: AnalysisPort = {
    ...reviewAnalysis,
    supportsMultiPv: (variant, count) => variant === 'standard' && count === 2,
  };

  assert.equal(createGameReview(insufficientLimits, archive), undefined);
  assert.equal(createGameReview(noMultiPv, archive), undefined);
  const composed = createGameReview(standardOnly, archive);
  assert.ok(composed);
  assert.equal(composed.supportsVariant('standard'), true);
  assert.equal(composed.supportsVariant('atomic'), false);
});

test('POST /v1/games/:id/review requires a player token and presents only that player\'s review', async () => {
  let source: FinishedGameForReview | undefined;
  const service = new GameReviewService({
    archive: { async finishedGameForReview() { return source; } },
    analysis: reviewAnalysis,
    createMoveAssessment: () => ({ async predict(input) { return outcome(input, 'blunder'); } }),
  });
  const h = await startHarness({}, { gameReview: service });
  try {
    const white = await h.makeUser('reviewwhite');
    const spectator = await h.makeUser('reviewspectator');
    source = game({ white: white.userId });

    const unauthenticated = await h.json('POST', `/v1/games/${source.gameId}/review`);
    assert.equal(unauthenticated.status, 401);

    const hidden = await h.json('POST', `/v1/games/${source.gameId}/review`, { token: spectator.token });
    assert.equal(hidden.status, 404);

    const response = await h.json('POST', `/v1/games/${source.gameId}/review`, { token: white.token });
    assert.equal(response.status, 200);
    assert.equal(response.body.playerColor, 'white');
    assert.equal(response.body.moves.length, 2);
    assert.equal(response.body.moves[0].san, 'e4');
    assert.equal(response.body.moves[0].assessment.classification, 'blunder');
    assert.equal(response.body.moves[0].classification, 'blunder');
    assert.equal(response.body.summary.blunder, 2);
  } finally {
    await h.close();
  }
});
