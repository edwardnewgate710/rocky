/**
 * Endgame training service tests (ADR-0128).
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
import { BundledEndgameDatabase } from '@chess-platform/ai-features';
import { HttpError } from '../src/http/errors.js';
import { AnalysisService } from '../src/analysis/service.js';
import {
  ENDGAME_DEPTH,
  ENDGAME_MOVETIME_MS,
  EndgameTrainingService,
} from '../src/endgames/endgame-training-service.js';

class StubAnalysisProvider implements AnalysisProvider {
  readonly requests: AnalysisRequest[] = [];
  responses: EngineResult[][] = [];

  /**
   * @param request - recorded, so a test can assert how many searches an accepted call made.
   * @returns the next scripted response, or a quiet default once the script runs out.
   */
  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.requests.push(request);
    return this.responses.shift() ?? [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 200 },
        principalVariation: ['g6g7'],
        depth: ENDGAME_DEPTH,
        nodes: 1000,
        nps: 10000,
        timeMs: 50,
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

/**
 * @param provider - the stub engine standing in for a real analysis pool.
 * @returns a service over the real bundled catalogue, which is what production composes.
 */
function createTestService(provider?: StubAnalysisProvider): {
  service: EndgameTrainingService;
  provider: StubAnalysisProvider;
} {
  const p = provider ?? new StubAnalysisProvider();
  const analysis = new AnalysisService({ provider: p });
  const service = new EndgameTrainingService({ analysis });
  return { service, provider: p };
}

test('next returns an endgame position without solution, eval, best move, or authored distance', () => {
  const { service } = createTestService();
  const outcome = service.next({ id: 'kq-vs-k-01' });

  // Key-set structural assertion:
  assert.deepEqual(Object.keys(outcome).sort(), [
    'difficulty',
    'fen',
    'id',
    'name',
    'objective',
    'sideToMove',
    'technique',
    'type',
  ]);

  assert.equal(outcome.id, 'kq-vs-k-01');
  assert.equal(outcome.type, 'KQ_vs_K');
  assert.equal(outcome.objective, 'mate');
  assert.doesNotMatch(JSON.stringify(outcome), /solution|bestMove|bestLine|eval|distance/);

  // Prove the source entry DID carry a goal distance, so the withholding is verified evidence:
  const source = new BundledEndgameDatabase().getById('kq-vs-k-01');
  assert.ok(source);
  assert.equal(source.goal.kind, 'mate');
  assert.equal((source.goal as { distance: number }).distance, 2);
});

test('next filters positions by type and difficulty', () => {
  const { service } = createTestService();
  const outcome = service.next({ type: 'KQ_vs_K', difficulty: 'beginner' });
  assert.equal(outcome.type, 'KQ_vs_K');
  assert.equal(outcome.difficulty, 'beginner');
});

test('next throws 422 for unknown id, bad type, bad difficulty, or unmatched filters', () => {
  const { service } = createTestService();

  assert.throws(
    () => service.next({ id: 'non-existent-id' }),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );

  assert.throws(
    () => service.next({ type: 'invalid_type' as any }),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );

  assert.throws(
    () => service.next({ difficulty: 'impossible' as any }),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );

  // KQ_vs_K with advanced difficulty does not exist in bundled DB:
  assert.throws(
    () => service.next({ type: 'KQ_vs_K', difficulty: 'advanced' }),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );
});

test('attempt evaluates an optimal move and charges quota before engine calls', async () => {
  const provider = new StubAnalysisProvider();
  // Before: mate in 2
  // After (g6g7): Black is checkmated (terminal or mate -0) -> opponent mate -1
  provider.responses = [
    [
      {
        multipv: 1,
        evaluation: { type: 'mate', value: 2 },
        principalVariation: ['g6g7'],
        depth: 16,
        nodes: 1000,
        nps: 10000,
        timeMs: 50,
      },
    ],
    [
      {
        multipv: 1,
        evaluation: { type: 'mate', value: -1 },
        principalVariation: [],
        depth: 16,
        nodes: 1000,
        nps: 10000,
        timeMs: 50,
      },
    ],
  ];

  const { service } = createTestService(provider);
  let charges = 0;

  const outcome = await service.attempt({ id: 'kq-vs-k-01', move: 'g6g7' }, async () => {
    charges += 1;
  });

  assert.equal(charges, 1, 'onAccepted was called before engine analysis');
  assert.equal(provider.requests.length, 2, 'exact two engine analyses executed');
  assert.equal(outcome.classification, 'optimal');
  assert.equal(outcome.goalPreserved, true);
  assert.equal(outcome.kind, 'judged');
  if (outcome.kind !== 'judged') return;
  assert.deepEqual(outcome.loss, { kind: 'centipawns', value: 0 });
  assert.equal(outcome.betterMove, 'g6g7');
  assert.equal(outcome.mateDistanceAfter, 1);
});

test('attempt returns decisive loss when library returns Infinity', async () => {
  const provider = new StubAnalysisProvider();
  // Before: mate in 2
  // After: cp 400 (was mate, now cp -> legacyCpLoss returns Infinity)
  provider.responses = [
    [
      {
        multipv: 1,
        evaluation: { type: 'mate', value: 2 },
        principalVariation: ['g6g7'],
        depth: 16,
        nodes: 1000,
        nps: 10000,
        timeMs: 50,
      },
    ],
    [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: -400 },
        principalVariation: ['h8g8'],
        depth: 16,
        nodes: 1000,
        nps: 10000,
        timeMs: 50,
      },
    ],
  ];

  const { service } = createTestService(provider);
  // A queen move, deliberately: every king move from this position stalemates, which ends the game
  // and produces a terminal outcome with no loss to tag. `g6a6` leaves Black three legal replies.
  const outcome = await service.attempt({ id: 'kq-vs-k-01', move: 'g6a6' });

  assert.equal(outcome.kind, 'judged');
  if (outcome.kind !== 'judged') return;
  assert.deepEqual(outcome.loss, { kind: 'decisive' });
  assert.doesNotMatch(JSON.stringify(outcome), /Infinity|NaN/);
});

/**
 * Stalemate is the whole point of a K+Q trainer, and it has no evaluation.
 *
 * `AnalysisService` answers a decided position with an empty `lines` and a `terminal`, so an
 * implementation that only checked `lines.length === 0` would tell the learner "analysis is
 * unavailable" at the exact moment they threw the win away. Verified against the real rules rather
 * than a stub verdict: from `7k/8/6Q1/8/8/8/8/4K3 w`, every king move stalemates.
 */
test('a move that stalemates is reported as a thrown result, not an engine failure', async () => {
  const provider = new StubAnalysisProvider();
  const { service } = createTestService(provider);

  const outcome = await service.attempt({ id: 'kq-vs-k-01', move: 'e1d2' });

  assert.equal(outcome.kind, 'terminal');
  if (outcome.kind !== 'terminal') return;
  assert.equal(outcome.terminal.result, '1/2-1/2');
  assert.equal(outcome.classification, 'throws_result');
  assert.equal(
    outcome.goalPreserved,
    false,
    'the goal was mate; a draw does not preserve it',
  );
  assert.equal(
    provider.requests.length,
    1,
    'only the before-position was searched; the decided position needed no engine',
  );
  assert.doesNotMatch(JSON.stringify(outcome), /Infinity|NaN|\(none\)/);
});

test('attempt maps missing or (none) bestMove to null', async () => {
  const provider = new StubAnalysisProvider();
  provider.responses = [
    [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 300 },
        principalVariation: ['(none)'],
        depth: 16,
        nodes: 1000,
        nps: 10000,
        timeMs: 50,
      },
    ],
    [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: -280 },
        principalVariation: [],
        depth: 16,
        nodes: 1000,
        nps: 10000,
        timeMs: 50,
      },
    ],
  ];

  const { service } = createTestService(provider);
  const outcome = await service.attempt({ id: 'kq-vs-k-01', move: 'g6g7' });

  assert.equal(outcome.kind, 'judged');
  if (outcome.kind !== 'judged') return;
  assert.equal(outcome.betterMove, null);
  assert.doesNotMatch(JSON.stringify(outcome), /\(none\)/);
});

test('attempt throws 422 for malformed move before engine work', async () => {
  const provider = new StubAnalysisProvider();
  const { service } = createTestService(provider);

  await assert.rejects(
    () => service.attempt({ id: 'kq-vs-k-01', move: 'invalid' }),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );
  assert.equal(provider.requests.length, 0);
});

test('attempt throws 422 for illegal move', async () => {
  const provider = new StubAnalysisProvider();
  const { service } = createTestService(provider);

  // 'e2e4' is illegal in '7k/8/6Q1/8/8/8/8/4K3 w - - 0 1'
  await assert.rejects(
    () => service.attempt({ id: 'kq-vs-k-01', move: 'e2e4' }),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );
  assert.equal(provider.requests.length, 0);
});

test('attempt throws 503 when engine returns empty lines', async () => {
  const provider = new StubAnalysisProvider();
  provider.responses = [[]]; // empty lines

  const { service } = createTestService(provider);

  await assert.rejects(
    () => service.attempt({ id: 'kq-vs-k-01', move: 'g6g7' }),
    (err: unknown) => err instanceof HttpError && err.status === 503,
  );
});
/**
 * A non-finite evaluation is the engine failing, not a dead-equal position.
 *
 * Coercing it to `0` would publish "0.00" — a fabricated fact, and a plausible-looking one, which is
 * strictly worse than an error because nothing downstream can tell it from a real evaluation. Same
 * reasoning as the `loss` tagged union, except that here there is no honest shape to fall back to.
 */
test('a non-finite evaluation fails the request rather than being published as 0.00', async () => {
  const provider = new StubAnalysisProvider();
  provider.responses = [
    [{
      multipv: 1,
      evaluation: { type: 'cp', value: Number.POSITIVE_INFINITY },
      principalVariation: ['g6g7'],
      depth: 16,
      nodes: 1000,
      nps: 10000,
      timeMs: 50,
    }],
    [{
      multipv: 1,
      evaluation: { type: 'cp', value: -100 },
      principalVariation: ['h8g8'],
      depth: 16,
      nodes: 1000,
      nps: 10000,
      timeMs: 50,
    }],
  ];
  const { service } = createTestService(provider);

  await assert.rejects(
    () => service.attempt({ id: 'kq-vs-k-01', move: 'g6a6' }),
    (error: unknown) => (error as { status?: number }).status === 503,
    'an engine that cannot produce a number must not be reported as an equal position',
  );
});

/**
 * The accepted filter values are derived from the catalogue, not from a second hand-written copy of
 * the library's unions — a copy would go stale the day the dataset gains a type.
 *
 * Discriminated by the *detail key*, not the status: an unvalidated type would still end in a 422,
 * because the pool filter finds nothing. The two refusals mean different things and say so.
 */
test('an unknown endgame type is refused as an invalid type, not as an empty result', async () => {
  const { service } = createTestService(new StubAnalysisProvider());

  try {
    service.next({ type: 'KQ_vs_KBNPPP' });
    assert.fail('expected a refusal');
  } catch (error: unknown) {
    const details = (error as { details?: Record<string, string> }).details ?? {};
    assert.ok('type' in details, `expected a "type" detail, got ${JSON.stringify(details)}`);
  }

  // A type that IS in the catalogue but paired with a difficulty no entry has: valid values, no
  // match. That is the other refusal, and it names the filter rather than the type.
  const real = new BundledEndgameDatabase().all()[0]!;
  const otherDifficulty = (['beginner', 'intermediate', 'advanced'] as const).find(
    (d) => !new BundledEndgameDatabase().all().some((e) => e.type === real.type && e.difficulty === d),
  );
  // Asserted rather than skipped: running this half inside `if (otherDifficulty)` would let the
  // whole "valid values, no match" case vanish the day the catalogue covered every difficulty for
  // this type, and the test would still report green. Raised in the CodeRabbit review of PR #151.
  assert.ok(
    otherDifficulty,
    `the catalogue no longer has an unused difficulty for '${real.type}'; pick another type`,
  );
  try {
    service.next({ type: real.type, difficulty: otherDifficulty });
    assert.fail('expected a refusal');
  } catch (error: unknown) {
    const details = (error as { details?: Record<string, string> }).details ?? {};
    assert.ok('filter' in details, `expected a "filter" detail, got ${JSON.stringify(details)}`);
  }
});

/**
 * An explicit id overrides the filters, which is what `NextPositionRequest` documents.
 *
 * Validating the filters first refused a position the catalogue certainly has, because a caller
 * re-requesting a known id had sent a stale filter alongside it. Raised in the Qodo review of #151.
 */
test('an id and a filter are mutually exclusive, whichever the filter says', () => {
  const { service } = createTestService(new StubAnalysisProvider());

  // An id alone resolves the position.
  assert.equal(service.next({ id: 'kq-vs-k-01' }).id, 'kq-vs-k-01');

  // An id *with* a filter is refused, and the refusal names the id rather than the filter: the two
  // express different intentions, so the request is a caller mistake rather than something to guess
  // at. Honouring the id would hide the mistake; validating the filter first would refuse a
  // position the catalogue certainly has. Both readings were raised in the Qodo review of PR #151,
  // one against each ordering.
  for (const filter of [{ type: 'KQ_vs_K' }, { difficulty: 'beginner' }, { type: 'NOT_REAL' }]) {
    try {
      service.next({ id: 'kq-vs-k-01', ...filter });
      assert.fail(`expected a refusal for ${JSON.stringify(filter)}`);
    } catch (error: unknown) {
      assert.ok(error instanceof HttpError && error.status === 422);
      const details = (error as { details?: Record<string, string> }).details ?? {};
      assert.ok('id' in details, `expected an "id" detail, got ${JSON.stringify(details)}`);
    }
  }

  // And the filter path still refuses that same value when there is no id beside it. Given a
  // predicate, because a bare `assert.throws` passes on any throw — a `TypeError` from a broken
  // test would read as a passing assertion.
  assert.throws(
    () => service.next({ type: 'NOT_A_REAL_TYPE' }),
    (error: unknown) => error instanceof HttpError && error.status === 422,
  );
});
