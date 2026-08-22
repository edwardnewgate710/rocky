/**
 * Coach orchestration tests (ADR-0129).
 *
 * The load-bearing ones here are the two leak tests and the cost test. Everything else this service
 * does is sequencing that a reviewer can read; what a reviewer cannot read is whether a solution
 * withheld by another endpoint reappears in this one, or whether a single request can quietly cost
 * five engine searches instead of four.
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
import { BundledEndgameDatabase, MistakePredictor, MoveExplainer } from '@chess-platform/ai-features';
import { AiOrchestrator, FakeProvider } from '@chess-platform/ai-orchestrator';
import { HttpError } from '../src/http/errors.js';
import { AnalysisService } from '../src/analysis/service.js';
import type { AnalysisPort } from '../src/analysis/service.js';
import { MistakePredictionService } from '../src/analysis/mistake-prediction-service.js';
import { MoveExplanationService } from '../src/ai/move-explanation-service.js';
import { PuzzleGenerationService } from '../src/analysis/puzzle-generation-service.js';
import { EndgameTrainingService } from '../src/endgames/endgame-training-service.js';
import { OpeningExplorationService } from '../src/openings/opening-exploration-service.js';
import { CoachService, MAX_COACH_PLIES } from '../src/coach/coach-service.js';
import { isUciShape } from '../src/analysis/uci.js';
import type { CoachFeatureBundle } from '../src/coach/coach-service.js';
import { MAX_EXPLORED_PLIES } from '../src/openings/opening-exploration-service.js';

/** A Crazyhouse position with a white pawn in hand, so `P@e4` is a legal drop. */
const CRAZYHOUSE_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[P] w KQkq - 0 1';

/** A quiet middlegame with a move to judge, and no tactic worth reporting. */
const QUIET_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3';

/**
 * Records every search so a test can assert the exact count, and answers by MultiPV.
 *
 * The MultiPV split matters: puzzle detection asks for three lines and everything else asks for one,
 * so a stub that ignored it would either starve the puzzle generator or hand two extra lines to a
 * service that reads only the first.
 */
class RecordingProvider implements AnalysisProvider {
  readonly requests: AnalysisRequest[] = [];
  /** Set to make the next search fail, standing in for a pool with no worker to give. */
  failNext = false;

  /**
   * @param request - recorded for the cost assertions.
   * @returns one line, or three with a decisive gap when three were asked for.
   */
  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.requests.push(request);
    if (this.failNext) {
      this.failNext = false;
      throw new HttpError(503, 'service_unavailable', 'no engine', undefined, { 'Retry-After': '1' });
    }
    /**
     * @param multipv - the line's rank.
     * @param value - its centipawn score.
     * @param pv - its principal variation.
     * @returns one engine line at the fixed depth the server's policy applies.
     */
    const line = (multipv: number, value: number, pv: readonly string[]): EngineResult => ({
      multipv,
      evaluation: { type: 'cp', value },
      principalVariation: [...pv],
      depth: 16,
      nodes: 1000,
      nps: 10000,
      timeMs: 50,
    });
    if ((request.multiPv ?? 1) >= 3) {
      // A wide gap between the best line and the second, which is what makes a position a tactic.
      return [line(1, 900, ['c6d4', 'f3d4']), line(2, 20, ['g8f6']), line(3, 10, ['d7d6'])];
    }
    return [line(1, 30, ['g8f6', 'd2d3'])];
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

/**
 * @param provider - the recording stub.
 * @returns a real `AnalysisService` over it, so the limits policy under test is the production one.
 */
function analysisOver(provider: AnalysisProvider): AnalysisService {
  return new AnalysisService({ provider });
}

/**
 * Build the feature bundle the way bootstrap does, over whichever port the Coach hands the factory.
 *
 * Real services throughout — no mocks. A mocked `MistakePredictionService` would prove nothing about
 * whether the Coach can leak a solution, because the thing that withholds the solution is the real
 * service's own projection.
 *
 * @param omit - feature names to leave out, for the degradation tests.
 * @returns a factory suitable for `CoachService`.
 */
function features(omit: readonly string[] = []): (analysis: AnalysisPort | undefined) => CoachFeatureBundle {
  return (analysis) => {
    const bundle: {
      mistakePrediction?: MistakePredictionService;
      moveExplanation?: MoveExplanationService;
      puzzleGeneration?: PuzzleGenerationService;
      openingExploration?: OpeningExplorationService;
      endgameTraining?: EndgameTrainingService;
    } = {};
    if (analysis && !omit.includes('mistakePrediction')) {
      bundle.mistakePrediction = new MistakePredictionService({
        analysis,
        predictor: new MistakePredictor({ defaultVariant: 'standard' }),
      });
    }
    if (analysis && !omit.includes('moveExplanation')) {
      // A real `MoveExplanationService` over a fake AI provider. The narrative it produces is not
      // what these tests check; what matters is that the section exists, so the tests about *why* it
      // is omitted are not silently answered by `unsupported` before they begin.
      const orchestrator = new AiOrchestrator();
      orchestrator.registry.register(
        new FakeProvider({ id: 'fake', model: 'fake-model', content: 'A developing move.' }),
        {
          providerId: 'fake',
          displayName: 'fake',
          modalities: ['text'],
          taskClasses: [],
          supportsStreaming: true,
          supportsStructured: true,
          supportsEmbeddings: false,
          supportsCancellation: true,
          models: [
            {
              id: 'fake-model',
              displayName: 'fake-model',
              contextWindow: 128_000,
              inputCostPerMtMicroUsd: 0,
              outputCostPerMtMicroUsd: 0,
              maxOutputTokens: 4096,
            },
          ],
          maxContextTokens: 128_000,
          local: false,
        },
      );
      bundle.moveExplanation = new MoveExplanationService({
        analysis,
        explainer: new MoveExplainer({ ai: orchestrator, defaultVariant: 'standard' }),
      });
    }
    if (analysis && !omit.includes('puzzleGeneration')) {
      bundle.puzzleGeneration = new PuzzleGenerationService({ analysis });
    }
    if (!omit.includes('openingExploration')) {
      bundle.openingExploration = new OpeningExplorationService({});
    }
    if (analysis && !omit.includes('endgameTraining')) {
      bundle.endgameTraining = new EndgameTrainingService({ analysis });
    }
    return bundle;
  };
}

// ---------------------------------------------------------------------------
// The two leak tests.
// ---------------------------------------------------------------------------

test('the endgame section identifies a catalogue position without carrying the authored answer', async () => {
  const provider = new RecordingProvider();
  const analysis = analysisOver(provider);
  // The first entry whose goal is a mate, so there is an authored `distance` to withhold. A `win`
  // or `draw` entry carries only a prose description and would make this test vacuous.
  const entry = new BundledEndgameDatabase().all().find((e) => e.goal.kind === 'mate')!;
  const distance = entry.goal.kind === 'mate' ? entry.goal.distance : -1;
  const service = new CoachService({ analysis, features: features() });

  const outcome = await service.coach({ fen: entry.fen, variant: 'standard' });

  assert.equal(outcome.endgame.kind, 'present');
  const identified = outcome.endgame.kind === 'present' ? outcome.endgame.value : null;
  assert.equal(identified?.id, entry.id);
  assert.equal(identified?.objective, 'mate');

  // The authored "mate in N" is the thing `/v1/endgames/next` withholds, for the ADR-0127 reason:
  // it is never cross-checked against the engine, so publishing it presents an authored number as a
  // measured one. It must not arrive by this door either.
  const serialised = JSON.stringify(outcome.endgame);
  assert.equal(
    serialised.includes(`"distance":${String(distance)}`),
    false,
    'the authored mate distance reached the coaching response',
  );
  assert.doesNotMatch(serialised, /solution|bestMove|bestLine|distance|evaluation|mateDistance/i);

  // And the field list is exactly the one `endgameNextView` publishes — no more.
  assert.deepEqual(Object.keys(identified ?? {}).sort(), [
    'difficulty', 'fen', 'id', 'name', 'objective', 'sideToMove', 'technique', 'type',
  ]);

  // Identifying an endgame costs no engine search at all: it is a catalogue scan. The only search
  // this request made is the MultiPV 3 one that tactic detection always makes.
  assert.equal(provider.requests.filter((r) => (r.multiPv ?? 1) === 1).length, 0);
  assert.equal(provider.requests.length, 1);
});

test('the puzzle section reports that a tactic exists without reporting what it is', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });

  const outcome = await service.coach({ fen: QUIET_FEN, variant: 'standard' });

  assert.equal(outcome.puzzle.kind, 'present');
  const puzzle = outcome.puzzle.kind === 'present' ? outcome.puzzle.value : null;
  assert.equal(puzzle?.kind, 'puzzle');
  assert.ok(typeof puzzle?.difficulty === 'string' && puzzle.difficulty.length > 0);

  // `c6d4` is the winning move the stub put at the top of the MultiPV 3 result, and it is exactly
  // what `/v1/puzzles/generate` would publish as `solutionMove`. It must not be here.
  const serialised = JSON.stringify(outcome.puzzle);
  assert.equal(serialised.includes('c6d4'), false, 'the tactic solution reached the coaching response');
  assert.equal(serialised.includes('solutionMove'), false);
  assert.equal(serialised.includes('solutionLine'), false);
  assert.deepEqual(Object.keys(puzzle ?? {}).sort(), ['difficulty', 'fen', 'kind', 'variant']);
});

// ---------------------------------------------------------------------------
// Cost.
// ---------------------------------------------------------------------------

test('the worst case is four engine searches, because the duplicated one is collapsed', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });

  // `d7d6` deliberately, not the stub's own best move `g8f6`. Playing the engine's choice leaves
  // nothing better to explain, so the explanation section reports `not_applicable` and never issues
  // the second search of the starting position — which is the exact search this test exists to
  // prove is collapsed. An earlier version of this test did that and proved nothing.
  await service.coach({
    fen: QUIET_FEN,
    variant: 'standard',
    move: 'd7d6',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'],
  });

  // Both services asked for the starting position at MultiPV 1; only one search went out.
  assert.ok(
    provider.requests.length >= 3,
    'the explanation section did not run, so there was no duplicate to collapse',
  );

  // Mistake prediction searches the position and the position after the move; puzzle detection
  // searches the position again at MultiPV 3. Move explanation would search the position a third
  // time at MultiPV 1 — the request-scoped port returns the first search's promise instead.
  const keys = provider.requests.map((r) => `${String(r.multiPv ?? 1)}|${r.fen}`);
  assert.equal(new Set(keys).size, keys.length, 'the same search was issued twice');
  assert.ok(provider.requests.length <= 4, `expected at most 4 searches, got ${String(provider.requests.length)}`);

  // And the de-duplication is real rather than incidental: exactly one MultiPV 1 search of the
  // starting position, despite two services each asking for one.
  const startSearches = provider.requests.filter(
    (r) => r.fen === QUIET_FEN && (r.multiPv ?? 1) === 1,
  );
  assert.equal(startSearches.length, 1);
});

test('a move sequence longer than the ply cap is refused before anything is charged', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });
  let charged = 0;

  await assert.rejects(
    () =>
      service.coach(
        {
          fen: QUIET_FEN,
          variant: 'standard',
          moves: Array.from({ length: MAX_COACH_PLIES + 1 }, () => 'e2e4'),
        },
        async () => {
          charged += 1;
        },
      ),
    (error: unknown) => error instanceof HttpError && error.status === 422,
  );
  assert.equal(charged, 0, 'an over-long request spent quota');
  assert.equal(provider.requests.length, 0, 'an over-long request spent an engine search');
});

test('the coach ply cap is the opening service ply cap, not a second number', () => {
  assert.equal(MAX_COACH_PLIES, MAX_EXPLORED_PLIES);
});

test('a malformed FEN costs neither quota nor a search', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });
  let charged = 0;

  await assert.rejects(
    () => service.coach({ fen: 'not a fen', variant: 'standard' }, async () => { charged += 1; }),
    (error: unknown) => error instanceof HttpError && error.status === 422,
  );
  assert.equal(charged, 0);
  assert.equal(provider.requests.length, 0);
});

test('an illegal move is refused before the request is charged for', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });
  let charged = 0;

  await assert.rejects(
    () => service.coach(
      { fen: QUIET_FEN, variant: 'standard', move: 'a1a8' },
      async () => { charged += 1; },
    ),
    (error: unknown) => error instanceof HttpError && error.status === 422,
  );

  // The charge is the property under test, not the search count. Mistake prediction validates the
  // move itself and would refuse it before searching either way — but it runs *after* `onAccepted`,
  // so without the check up here the caller pays for a move that was never legal.
  assert.equal(charged, 0, 'an illegal move was charged for');
  assert.equal(provider.requests.length, 0);
});

// ---------------------------------------------------------------------------
// Degradation.
// ---------------------------------------------------------------------------

test('a feature this deployment never built is unsupported, not unavailable', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({
    analysis: analysisOver(provider),
    features: features(['puzzleGeneration']),
  });

  const outcome = await service.coach({ fen: QUIET_FEN, variant: 'standard' });

  // `unsupported`, because no retry will make this deployment grow a puzzle generator. The
  // difference from `unavailable` is the difference between "not offered here" and "try again".
  assert.deepEqual(outcome.puzzle, { kind: 'omitted', reason: 'unsupported' });
  // The endgame section still ran and still answered, which is the whole point of per-section
  // degradation: one missing feature is not five.
  assert.equal(outcome.endgame.kind, 'omitted');
  assert.equal(outcome.endgame.kind === 'omitted' ? outcome.endgame.reason : null, 'not_applicable');
});

test('a failing engine marks that section unavailable while another section still answers', async () => {
  const provider = new RecordingProvider();
  const entry = new BundledEndgameDatabase().all()[0]!;
  const service = new CoachService({
    analysis: analysisOver(provider),
    features: features(['mistakePrediction']),
  });
  provider.failNext = true;

  // On a catalogue endgame, so one section can still produce a value while the engine-backed one
  // fails. That is the property under test: a broken dependency costs its own section and no more.
  const outcome = await service.coach({ fen: entry.fen, variant: 'standard' });

  assert.deepEqual(outcome.puzzle, { kind: 'omitted', reason: 'unavailable' });
  assert.equal(outcome.endgame.kind, 'present');
  assert.deepEqual(outcome.featuresFired, ['endgameTraining']);
});

test('a deployment composing nothing answers 503 rather than five empty sections', async () => {
  const service = new CoachService({ features: () => ({}) });

  await assert.rejects(
    () => service.coach({ fen: QUIET_FEN, variant: 'standard' }),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
});

test('delivering nothing because something is broken is a 503, not a quiet-position 200', async () => {
  const provider = new RecordingProvider();
  // Only the puzzle feature exists, and its engine fails, so no section can produce a value and the
  // reason one of them is empty is a failure rather than a shrug.
  const service = new CoachService({
    analysis: analysisOver(provider),
    features: features(['mistakePrediction', 'openingExploration', 'endgameTraining']),
  });
  provider.failNext = true;

  await assert.rejects(
    () => service.coach({ fen: QUIET_FEN, variant: 'standard' }),
    (error: unknown) => error instanceof HttpError && error.status === 503,
  );
});

test('delivering nothing because there was nothing to say is an ordinary 200', async () => {
  const provider = new RecordingProvider();
  // Nothing here is broken. The position is not a book line and not a catalogue endgame, and the
  // one feature that is absent is absent permanently rather than failing. The difference from the
  // test above is the *reason* the sections are empty, and it is the whole difference between an
  // error and an answer.
  const service = new CoachService({
    analysis: analysisOver(provider),
    features: features(['puzzleGeneration']),
  });

  const outcome = await service.coach({ fen: QUIET_FEN, variant: 'standard' });

  assert.deepEqual(outcome.featuresFired, []);
  assert.equal(outcome.endgame.kind === 'omitted' ? outcome.endgame.reason : null, 'not_applicable');
  assert.equal(outcome.puzzle.kind === 'omitted' ? outcome.puzzle.reason : null, 'unsupported');
});

test('a quiet position with nothing requested is a 200 with reasons, not an error', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({
    analysis: analysisOver(provider),
    features: features(['puzzleGeneration']),
  });

  const outcome = await service.coach({ fen: QUIET_FEN, variant: 'standard' });

  assert.deepEqual(outcome.mistake, { kind: 'omitted', reason: 'not_requested' });
  assert.deepEqual(outcome.explanation, { kind: 'omitted', reason: 'not_requested' });
  assert.deepEqual(outcome.opening, { kind: 'omitted', reason: 'not_requested' });
});

test('a move sequence that left book is not_applicable rather than a present empty result', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });

  const outcome = await service.coach({
    fen: QUIET_FEN,
    variant: 'standard',
    moves: ['a2a3', 'h7h6', 'a3a4', 'h6h5'],
  });

  assert.deepEqual(outcome.opening, { kind: 'omitted', reason: 'not_applicable' });
});

// ---------------------------------------------------------------------------
// Cancellation.
// ---------------------------------------------------------------------------

test('a caller that disconnects stops the sections that had not started', async () => {
  const provider = new RecordingProvider();
  const controller = new AbortController();
  const service = new CoachService({
    analysis: analysisOver(provider),
    features: features(['mistakePrediction']),
  });

  controller.abort();
  const outcome = await service.coach({
    fen: QUIET_FEN,
    variant: 'standard',
    signal: controller.signal,
  });

  assert.deepEqual(outcome.puzzle, { kind: 'omitted', reason: 'cancelled' });
  assert.equal(provider.requests.length, 0, 'a cancelled request still reached the engine');
});

test('the request signal reaches the engine, so an in-flight search can be stopped', async () => {
  const provider = new RecordingProvider();
  const controller = new AbortController();
  const service = new CoachService({
    analysis: analysisOver(provider),
    features: features(['mistakePrediction']),
  });

  await service.coach({ fen: QUIET_FEN, variant: 'standard', signal: controller.signal });

  assert.ok(provider.requests.length > 0);
  for (const request of provider.requests) {
    assert.ok(request.signal !== undefined, 'a search was issued with no cancellation signal');
    assert.equal(request.signal?.aborted, false);
  }
  // Aborting the request aborts what the engine was given, which is what `AbortSignal.any` buys:
  // the search's own timeout controller is still in there too, so this does not replace it.
  controller.abort();
  assert.equal(provider.requests[0]?.signal?.aborted, true);
});

test('a failed verdict does not become "your move could not be improved on"', async () => {
  const provider = new RecordingProvider();
  // Move explanation is present, mistake prediction is present, and the engine fails on the first
  // search — so the verdict cannot be produced and there is no better move to explain.
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });
  provider.failNext = true;

  const outcome = await service.coach({ fen: QUIET_FEN, variant: 'standard', move: 'g8f6' });

  assert.deepEqual(outcome.mistake, { kind: 'omitted', reason: 'unavailable' });
  // Inherited, not `not_applicable`. Reporting "nothing better to suggest" here would be a claim
  // about the learner's move, made on the strength of a search that never happened.
  assert.deepEqual(outcome.explanation, { kind: 'omitted', reason: 'unavailable' });
});

test('a move that was already best leaves nothing to explain, and says so', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });

  // The stub's MultiPV 1 line is `g8f6`, so playing it means the engine agrees and there is no
  // better move. That is a real answer about the move, and the reason differs from the one above.
  const outcome = await service.coach({ fen: QUIET_FEN, variant: 'standard', move: 'g8f6' });

  assert.equal(outcome.mistake.kind, 'present');
  assert.deepEqual(outcome.explanation, { kind: 'omitted', reason: 'not_applicable' });
});

test('a variant the opening service will not serve costs that section, not the request', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });

  // Opening exploration serves `standard` only and answers 422 for anything else. Because
  // `sectionFailure` rethrows everything that is not a 503, that 422 used to abort the whole
  // request — so a Crazyhouse game that sent its move ledger lost the tactic, mistake and endgame
  // sections too, none of which have anything to do with openings. Raised in the adversarial review
  // of PR #152.
  const outcome = await service.coach({
    fen: CRAZYHOUSE_FEN,
    variant: 'crazyhouse',
    moves: ['e2e4', 'e7e5'],
  });

  assert.deepEqual(outcome.opening, { kind: 'omitted', reason: 'unsupported' });
  // And the sections that had nothing to do with openings still ran.
  assert.notDeepEqual(outcome.puzzle, { kind: 'omitted', reason: 'unavailable' });
});

test('a Crazyhouse drop is a move, not malformed input', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });

  // The shape filter here runs before the two services it feeds, so anything narrower than theirs
  // refuses a move they would have accepted. It was narrower: `P@e4` was rejected as malformed
  // before any variant-aware rule saw it. The request is still refused — the position below has no
  // pawn in hand — but as an *illegal move for this position*, which is a different answer arrived
  // at by the authoritative rules rather than by a regex that had never heard of drops.
  // The drop is legal here: White has a pawn in hand and e4 is empty.
  const outcome = await service.coach({
    fen: CRAZYHOUSE_FEN,
    variant: 'crazyhouse',
    move: 'P@e4',
  });

  // It reached the sections rather than being refused as malformed, which is the whole point.
  assert.equal(outcome.move, 'P@e4');
  assert.notDeepEqual(outcome.mistake, { kind: 'omitted', reason: 'not_requested' });
});

test('every service filters move syntax through the one shared matcher', () => {
  // The first version of this test declared its own copy of the regex and asserted against that,
  // which could not fail however far the real filter drifted — the exact failure it was written to
  // prevent. There is now one `isUciShape`, imported by the Coach and by both services it composes,
  // and this exercises that function. Raised in the CodeRabbit review of PR #152.
  for (const move of ['e2e4', 'e7e8q', 'P@e4', 'N@f3', 'Q@d5', 'a1h8']) {
    assert.equal(isUciShape(move), true, `${move} should pass the shape filter`);
  }
  for (const move of ['', 'e2', 'e2e4e6', 'z9z9', 'P@z9', 'K@e4', 'resign']) {
    assert.equal(isUciShape(move), false, `${move} should not pass the shape filter`);
  }
});

test('a decided game is refused before the request is charged for', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });
  let charged = 0;

  // Insufficient material: two bare kings. There are legal moves, so `play` accepts one — the game
  // is over all the same, and mistake prediction refuses such a position. It refuses *after* this
  // service has already charged, so the caller paid for a 422. Raised in the CodeRabbit review of
  // PR #152.
  await assert.rejects(
    () => service.coach(
      { fen: '8/8/8/4k3/8/8/8/4K3 w - - 0 1', variant: 'standard', move: 'e1e2' },
      async () => { charged += 1; },
    ),
    (error: unknown) => error instanceof HttpError && error.status === 422,
  );
  assert.equal(charged, 0, 'a decided position was charged for');
  assert.equal(provider.requests.length, 0);
});

test('a decided position with no move still gets the sections that do not need one', async () => {
  const provider = new RecordingProvider();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });

  // The refusal above is scoped to a supplied move on purpose. A finished game still has an opening
  // worth naming, and taking that away over a question nobody asked would be the wrong trade.
  const outcome = await service.coach({
    fen: '8/8/8/4k3/8/8/8/4K3 w - - 0 1',
    variant: 'standard',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'],
  });

  assert.equal(outcome.opening.kind, 'present');
  assert.deepEqual(outcome.mistake, { kind: 'omitted', reason: 'not_requested' });
});

test('a caller who has gone is owed no work, engineless sections included', async () => {
  const provider = new RecordingProvider();
  const controller = new AbortController();
  const service = new CoachService({ analysis: analysisOver(provider), features: features() });
  controller.abort();

  const outcome = await service.coach({
    fen: QUIET_FEN,
    variant: 'standard',
    moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'],
    signal: controller.signal,
  });

  // Opening identification and endgame lookup touch no engine, so skipping them saves little — but
  // a section that reports `cancelled` is a more honest record than one that quietly ran anyway.
  assert.deepEqual(outcome.opening, { kind: 'omitted', reason: 'cancelled' });
  assert.deepEqual(outcome.endgame, { kind: 'omitted', reason: 'cancelled' });
  assert.deepEqual(outcome.featuresFired, []);
  // `featuresFired` alone is too weak to carry this claim: a search that started and then aborted
  // would leave it empty and pass, which is the opposite of what the test is named for. The count
  // of searches that actually reached the engine is the property. Raised in the CodeRabbit review
  // of PR #152.
  assert.equal(provider.requests.length, 0, 'a cancelled request still reached the engine');
});
