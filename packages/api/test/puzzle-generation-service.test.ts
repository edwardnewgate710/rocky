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
import { HttpError } from '../src/http/errors';
import { AnalysisService } from '../src/analysis/service';
import {
  PUZZLE_DEPTH,
  PUZZLE_MOVETIME_MS,
  PUZZLE_MULTI_PV,
  PuzzleGenerationService,
} from '../src/analysis/puzzle-generation-service';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const CHECKMATE_FEN = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1';

class RecordingProvider implements AnalysisProvider {
  readonly requests: AnalysisRequest[] = [];
  response: readonly EngineResult[] = [
    line(1, { type: 'cp', value: 350 }, ['e2e4', 'e7e5']),
    line(2, { type: 'cp', value: 80 }, ['d2d4', 'd7d5']),
    line(3, { type: 'cp', value: 20 }, ['g1f3', 'g8f6']),
  ];

  async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
    this.requests.push(request);
    return this.response;
  }

  async play(_request: PlayRequest): Promise<PlayResult> {
    throw new Error('not used');
  }

  capabilitiesFor(_variant: string): EngineCapabilities | undefined {
    return undefined;
  }
}

test('PuzzleGenerationService uses one bounded MultiPV analysis and returns JSON-safe evidence', async () => {
  const provider = new RecordingProvider();
  const service = serviceFor(provider);
  let charges = 0;

  const outcome = await service.generate(
    { fen: START_FEN, variant: 'standard' },
    async () => { charges += 1; },
  );

  assert.equal(charges, 1);
  assert.equal(provider.requests.length, 1, 'one MultiPV search supplies all puzzle evidence');
  const request = provider.requests[0]!;
  assert.equal(request.multiPv, PUZZLE_MULTI_PV);
  assert.equal(request.limits.depth, PUZZLE_DEPTH);
  assert.equal(request.limits.timeMs, PUZZLE_MOVETIME_MS);
  assert.equal(outcome.kind, 'puzzle');
  assert.equal(outcome.solutionMove, 'e2e4');
  assert.equal(outcome.comparisonMove, 'd2d4');
  assert.deepEqual(outcome.evidence, { kind: 'centipawn_gap', gapCp: 270 });
  assert.doesNotMatch(JSON.stringify(outcome), /Infinity|NaN|\(none\)/);
});

test('PuzzleGenerationService returns a supported no-tactic conclusion only with complete MultiPV evidence', async () => {
  const provider = new RecordingProvider();
  provider.response = [
    line(1, { type: 'cp', value: 35 }, ['e2e4']),
    line(2, { type: 'cp', value: 20 }, ['d2d4']),
    line(3, { type: 'cp', value: 10 }, ['g1f3']),
  ];

  const outcome = await serviceFor(provider).generate({ fen: START_FEN, variant: 'standard' });

  assert.equal(outcome.kind, 'no_tactic');
  assert.deepEqual(outcome.evidence, { kind: 'centipawn_gap', gapCp: 15 });
  assert.equal(outcome.bestMove, 'e2e4');
  assert.equal(outcome.comparisonMove, 'd2d4');
});

test('PuzzleGenerationService reports incomplete MultiPV output as insufficient evidence', async () => {
  const provider = new RecordingProvider();
  provider.response = [line(1, { type: 'cp', value: 350 }, ['e2e4'])];

  const outcome = await serviceFor(provider).generate({ fen: START_FEN, variant: 'standard' });

  assert.deepEqual(outcome, {
    kind: 'insufficient',
    fen: START_FEN,
    variant: 'standard',
    reason: 'not_enough_lines',
    bestMove: 'e2e4',
    comparisonMove: null,
  });
});

test('PuzzleGenerationService does not promote two valid lines from a partial MultiPV 3 search', async () => {
  const provider = new RecordingProvider();
  provider.response = [
    line(1, { type: 'cp', value: 350 }, ['e2e4']),
    line(2, { type: 'cp', value: 80 }, ['d2d4']),
  ];

  const outcome = await serviceFor(provider).generate({ fen: START_FEN, variant: 'standard' });

  assert.equal(outcome.kind, 'insufficient');
  assert.equal(outcome.reason, 'incomplete_multipv');
});

test('PuzzleGenerationService represents mate evidence without a non-finite number', async () => {
  const provider = new RecordingProvider();
  provider.response = [
    line(1, { type: 'mate', value: 3 }, ['e2e4']),
    line(2, { type: 'cp', value: 150 }, ['d2d4']),
    line(3, { type: 'cp', value: 80 }, ['g1f3']),
  ];

  const outcome = await serviceFor(provider).generate({ fen: START_FEN, variant: 'standard' });

  assert.equal(outcome.kind, 'puzzle');
  assert.deepEqual(outcome.evidence, {
    kind: 'mate',
    relation: 'forces_mate',
    distanceGap: null,
  });
  assert.doesNotMatch(JSON.stringify(outcome), /Infinity|NaN|\(none\)/);
});

test('PuzzleGenerationService treats malformed engine moves as insufficient evidence', async () => {
  const provider = new RecordingProvider();
  provider.response = [
    line(1, { type: 'cp', value: 350 }, ['(none)']),
    line(2, { type: 'cp', value: 80 }, ['d2d4']),
    line(3, { type: 'cp', value: 20 }, ['g1f3']),
  ];

  const outcome = await serviceFor(provider).generate({ fen: START_FEN, variant: 'standard' });

  assert.equal(outcome.kind, 'insufficient');
  assert.equal(outcome.reason, 'invalid_best_move');
  assert.doesNotMatch(JSON.stringify(outcome), /\(none\)/);
});

test('PuzzleGenerationService rejects malformed continuation moves before presenting a puzzle', async () => {
  const provider = new RecordingProvider();
  provider.response = [
    line(1, { type: 'cp', value: 350 }, ['e2e4', '(none)']),
    line(2, { type: 'cp', value: 80 }, ['d2d4']),
    line(3, { type: 'cp', value: 20 }, ['g1f3']),
  ];

  const outcome = await serviceFor(provider).generate({ fen: START_FEN, variant: 'standard' });

  assert.equal(outcome.kind, 'insufficient');
  assert.equal(outcome.reason, 'invalid_solution_line');
  assert.doesNotMatch(JSON.stringify(outcome), /\(none\)/);
});

test('PuzzleGenerationService never publishes a non-finite engine depth', async () => {
  const provider = new RecordingProvider();
  provider.response = [
    { ...line(1, { type: 'cp', value: 350 }, ['e2e4']), depth: Number.NaN },
    line(2, { type: 'cp', value: 80 }, ['d2d4']),
    line(3, { type: 'cp', value: 20 }, ['g1f3']),
  ];

  const outcome = await serviceFor(provider).generate({ fen: START_FEN, variant: 'standard' });

  assert.equal(outcome.kind, 'insufficient');
  assert.equal(outcome.reason, 'non_finite_depth');
  assert.doesNotMatch(JSON.stringify(outcome), /Infinity|NaN|\(none\)/);
});

test('PuzzleGenerationService reports a terminal position without charge or engine work', async () => {
  const provider = new RecordingProvider();
  let charged = false;

  const outcome = await serviceFor(provider).generate(
    { fen: CHECKMATE_FEN, variant: 'standard' },
    async () => { charged = true; },
  );

  assert.equal(charged, false);
  assert.equal(provider.requests.length, 0);
  assert.equal(outcome.kind, 'insufficient');
  assert.equal(outcome.reason, 'terminal_position');
  assert.deepEqual(outcome.terminal, { reason: 'checkmate', result: '1-0' });
});

test('PuzzleGenerationService rejects malformed FEN before charge or engine work', async () => {
  const provider = new RecordingProvider();
  let charged = false;

  await assert.rejects(
    () => serviceFor(provider).generate(
      { fen: `${START_FEN}\nquit`, variant: 'standard' },
      async () => { charged = true; },
    ),
    (err: unknown) => err instanceof HttpError && err.status === 422,
  );

  assert.equal(charged, false);
  assert.equal(provider.requests.length, 0);
});

test('PuzzleGenerationService rejects an unsupported variant before charge or engine work', async () => {
  const provider = new RecordingProvider();
  let charged = false;
  const analysis = new AnalysisService({ provider, supportsVariant: (variant) => variant === 'standard' });
  const service = new PuzzleGenerationService({ analysis });

  await assert.rejects(
    () => service.generate(
      { fen: START_FEN, variant: 'atomic' },
      async () => { charged = true; },
    ),
    (err: unknown) =>
      err instanceof HttpError && err.status === 422 && err.details?.['variant'] === 'unsupported variant',
  );

  assert.equal(charged, false);
  assert.equal(provider.requests.length, 0);
});

test('PuzzleGenerationService rejects an engine without MultiPV 3 before charge or engine work', async () => {
  const provider = new RecordingProvider();
  let charged = false;
  const analysis = new AnalysisService({
    provider,
    supportsVariant: () => true,
    supportsMultiPv: () => false,
  });
  const service = new PuzzleGenerationService({ analysis });

  await assert.rejects(
    () => service.generate(
      { fen: START_FEN, variant: 'standard' },
      async () => { charged = true; },
    ),
    (err: unknown) =>
      err instanceof HttpError && err.status === 422 && err.details?.['variant'] === 'unsupported variant',
  );

  assert.equal(charged, false);
  assert.equal(provider.requests.length, 0);
});

test('PuzzleGenerationService cannot be constructed with analysis ceilings below its fixed policy', () => {
  const provider = new RecordingProvider();
  const analysis = new AnalysisService({
    provider,
    policy: {
      maxDepth: PUZZLE_DEPTH,
      maxNodes: 5_000_000,
      maxTimeMs: PUZZLE_MOVETIME_MS,
      maxMultiPv: PUZZLE_MULTI_PV - 1,
      defaultDepth: PUZZLE_DEPTH,
      defaultTimeMs: PUZZLE_MOVETIME_MS,
    },
  });

  assert.throws(
    () => new PuzzleGenerationService({ analysis }),
    /requires the fixed depth, time, and MultiPV policy/,
  );
});

function serviceFor(provider: RecordingProvider): PuzzleGenerationService {
  return new PuzzleGenerationService({
    analysis: new AnalysisService({ provider, supportsVariant: () => true }),
  });
}

function line(
  multipv: number,
  evaluation: EngineResult['evaluation'],
  principalVariation: readonly string[],
): EngineResult {
  return {
    multipv,
    evaluation,
    principalVariation,
    depth: 16,
    selDepth: 18,
    nodes: 1_000,
    nps: 2_000,
    timeMs: 500,
  };
}
