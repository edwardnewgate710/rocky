/**
 * Hermetic test suite for `PuzzleGenerator`.
 *
 * Drives the generator end-to-end with `FakeEngineTransport` (via a
 * lightweight `AnalysisProvider` fake) + `FakeProvider` (M7's fake AI
 * provider).  No keys, no binary, no network.
 *
 * Tests assert that:
 * - A position where multiPv line 1 beats line 2 by > threshold →
 *   produces a `Puzzle` with correct engine-derived solution move, gap,
 *   and best line.
 * - A position where the gap is below threshold → produces a
 *   `PuzzleRejection` with the measured gap.
 * - A mate-vs-non-mate case → qualifies as a puzzle.
 * - With the AI provider omitted → a valid puzzle with engine fields
 *   and no LLM text (proving the LLM is not load-bearing).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { FakeEngineTransport, UciEngineInstance } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';

import { evalGapCp, PuzzleGenerator } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers: build a real AnalysisProvider backed by FakeEngineTransport
// ---------------------------------------------------------------------------

/**
 * Creates an `AnalysisProvider` backed by a `FakeEngineTransport` that
 * returns scripted `info` lines + `bestmove` for a given FEN.
 */
function createFakeAnalysisProvider(
  goHandler: (goCommand: string, positionFen: string | null) => { info: readonly string[]; bestmove: string; ponder?: string } | 'hang',
): AnalysisProvider {
  const transport = new FakeEngineTransport({
    name: 'FakeStockfish 1.0',
    author: 'chess-platform',
    go: goHandler,
  });

  const instance = new UciEngineInstance(transport, { id: 'fake-1' });

  const provider: AnalysisProvider = {
    async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
      await instance.init();
      const results = await instance.analyze({
        fen: request.fen,
        limits: request.limits,
        multiPv: request.multiPv ?? 1,
        signal: request.signal,
      });
      return results;
    },
    async play(request: PlayRequest): Promise<PlayResult> {
      await instance.init();
      const result = await instance.play({
        fen: request.fen,
        limits: request.limits,
        multiPv: 1,
        strength: request.strength,
        signal: request.signal,
      });
      return result;
    },
    capabilitiesFor(variant: string): EngineCapabilities | undefined {
      if (variant === 'chess' || variant === undefined) {
        return {
          engineName: 'FakeStockfish',
          engineAuthor: 'chess-platform',
          version: '1.0',
          fingerprint: 'fake-fingerprint',
          variants: new Set(['chess']),
          options: new Map(),
          supportsMultiPv: true,
          supportsLimitStrength: true,
          supportsSkillLevel: true,
          supportsPonder: true,
        };
      }
      return undefined;
    },
  };

  return provider;
}

// ---------------------------------------------------------------------------
// Known position: a middlegame position with a sharp tactic
// FEN: r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 0 1
// (Black to move, but the engine evaluates from side-to-move perspective)
// ---------------------------------------------------------------------------

const TEST_FEN = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 0 1';

// ---------------------------------------------------------------------------
// Scripted multi-PV responses
// ---------------------------------------------------------------------------

/** A sharp position: best line is +350cp, second-best is +80cp → gap = 270cp > 200 threshold. */
function sharpGoHandler(
  _goCommand: string,
  _positionFen: string | null,
): { info: readonly string[]; bestmove: string } {
  return {
    info: [
      'info depth 20 seldepth 25 multipv 1 score cp 350 nodes 1000000 nps 500000 time 2000 pv d8a5 b1c3',
      'info depth 20 seldepth 24 multipv 2 score cp 80 nodes 1000000 nps 500000 time 2000 pv e7e6 d2d4',
      'info depth 20 seldepth 23 multipv 3 score cp 30 nodes 1000000 nps 500000 time 2000 pv g8f6 e2e4',
    ],
    bestmove: 'd8a5',
  };
}

/** A quiet position: best line is +35cp, second-best is +20cp → gap = 15cp < 200 threshold. */
function quietGoHandler(
  _goCommand: string,
  _positionFen: string | null,
): { info: readonly string[]; bestmove: string } {
  return {
    info: [
      'info depth 20 seldepth 25 multipv 1 score cp 35 nodes 1000000 nps 500000 time 2000 pv e7e5 e2e4',
      'info depth 20 seldepth 24 multipv 2 score cp 20 nodes 1000000 nps 500000 time 2000 pv d7d5 e2e4',
      'info depth 20 seldepth 23 multipv 3 score cp 10 nodes 1000000 nps 500000 time 2000 pv g8f6 e2e4',
    ],
    bestmove: 'e7e5',
  };
}

/** A mate position: best line is mate in 3, second-best is +150cp → qualifies (mate vs non-mate). */
function mateGoHandler(
  _goCommand: string,
  _positionFen: string | null,
): { info: readonly string[]; bestmove: string } {
  return {
    info: [
      'info depth 20 seldepth 20 multipv 1 score mate 3 nodes 800000 nps 400000 time 1800 pv d8a5',
      'info depth 20 seldepth 19 multipv 2 score cp 150 nodes 800000 nps 400000 time 1800 pv d1h5 g7g6',
      'info depth 20 seldepth 18 multipv 3 score cp 80 nodes 800000 nps 400000 time 1800 pv e2e4 e7e5',
    ],
        bestmove: 'd8a5',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PuzzleGenerator (hermetic)', () => {

  test('sharp position produces a Puzzle with correct engine-derived fields', async () => {
    const engine = createFakeAnalysisProvider(sharpGoHandler);
    const ai = new FakeProvider({
      id: 'fake-ai',
      content: 'THEME: Queen attack\nHINT: Look for a move that attacks multiple weaknesses.',
    });

    const generator = new PuzzleGenerator({ engine, ai });
    const result = await generator.generate({ fen: TEST_FEN });

    assert.equal(result.kind, 'puzzle');
    const puzzle = result as import('../src/index.js').Puzzle;

    // Engine-derived fields (the non-negotiable part).
    assert.equal(puzzle.fen, TEST_FEN);
    assert.equal(puzzle.solutionMove, 'd8a5');
    assert.equal(puzzle.bestEval.type, 'cp');
    assert.equal(puzzle.bestEval.value, 350);
    assert.equal(puzzle.bestEvalLabel, '+3.50');
    assert.equal(puzzle.secondBestEval.type, 'cp');
    assert.equal(puzzle.secondBestEval.value, 80);
    assert.equal(puzzle.secondBestEvalLabel, '+0.80');
    assert.deepEqual(puzzle.evidence, { kind: 'centipawn_gap', gapCp: 270 });
    assert.deepEqual([...puzzle.solutionLine], ['d8a5', 'b1c3']);
    assert.equal(puzzle.depth, 20);

    // LLM-derived fields (additive, not load-bearing).
    assert.equal(puzzle.theme, 'Queen attack');
    assert.equal(puzzle.hint, 'Look for a move that attacks multiple weaknesses.');
    assert.equal(puzzle.providerId, 'fake-ai');
    assert.equal(puzzle.model, 'fake-model');
    assert.ok(puzzle.usage);
    assert.ok(puzzle.usage!.totalTokens > 0);
  });

  test('quiet position (gap below threshold) produces a PuzzleRejection', async () => {
    const engine = createFakeAnalysisProvider(quietGoHandler);
    const ai = new FakeProvider({ id: 'fake-ai', content: 'THEME: Quiet\nHINT: No tactic here.' });

    const generator = new PuzzleGenerator({ engine, ai });
    const result = await generator.generate({ fen: TEST_FEN });

    assert.equal(result.kind, 'rejection');
    const rejection = result as import('../src/index.js').PuzzleRejection;

    assert.equal(rejection.fen, TEST_FEN);
    assert.deepEqual(rejection.evidence, { kind: 'centipawn_gap', gapCp: 15 });
    assert.equal(rejection.thresholdCp, 200); // default
    assert.equal(rejection.reason, 'gap_below_threshold');
    assert.equal(rejection.bestMove, 'e7e5');
    assert.equal(rejection.bestEval.type, 'cp');
    assert.equal(rejection.bestEval.value, 35);
    assert.equal(rejection.secondBestEval.type, 'cp');
    assert.equal(rejection.secondBestEval.value, 20);
    assert.equal(rejection.depth, 20);
  });

  test('mate-vs-non-mate position qualifies as a puzzle', async () => {
    const engine = createFakeAnalysisProvider(mateGoHandler);
    const ai = new FakeProvider({ id: 'fake-ai', content: 'THEME: Forced mate\nHINT: Find the mating sequence.' });

    const generator = new PuzzleGenerator({ engine, ai });
    const result = await generator.generate({ fen: TEST_FEN });

    assert.equal(result.kind, 'puzzle');
    const puzzle = result as import('../src/index.js').Puzzle;

    assert.equal(puzzle.solutionMove, 'd8a5');
    assert.equal(puzzle.bestEval.type, 'mate');
    assert.equal(puzzle.bestEval.value, 3);
    assert.equal(puzzle.bestEvalLabel, 'mate in 3');
    assert.equal(puzzle.secondBestEval.type, 'cp');
    assert.equal(puzzle.secondBestEval.value, 150);
    assert.deepEqual(puzzle.evidence, {
      kind: 'mate',
      relation: 'forces_mate',
      distanceGap: null,
    });
    assert.equal(JSON.stringify(puzzle).includes('null'), true, 'ordinary null fields remain JSON-safe');
    assert.doesNotMatch(JSON.stringify(puzzle), /Infinity|NaN|\(none\)/);
    assert.deepEqual([...puzzle.solutionLine], ['d8a5']);
    assert.equal(puzzle.depth, 20);
  });

  test('mate-distance uniqueness accepts exactly a two-move advantage, not one move', async () => {
    const oneMoveGap = await new PuzzleGenerator().generate({
      fen: TEST_FEN,
      analysis: [
        result(1, { type: 'mate', value: 3 }, ['e2e4']),
        result(2, { type: 'mate', value: 4 }, ['d2d4']),
      ],
    });
    assert.equal(oneMoveGap.kind, 'rejection');
    assert.equal(oneMoveGap.reason, 'mate_not_unique');
    assert.deepEqual(oneMoveGap.evidence, {
      kind: 'mate',
      relation: 'faster_mate',
      distanceGap: 1,
    });

    const twoMoveGap = await new PuzzleGenerator().generate({
      fen: TEST_FEN,
      analysis: [
        result(1, { type: 'mate', value: 3 }, ['e2e4']),
        result(2, { type: 'mate', value: 5 }, ['d2d4']),
      ],
    });
    assert.equal(twoMoveGap.kind, 'puzzle');
    assert.deepEqual(twoMoveGap.evidence, {
      kind: 'mate',
      relation: 'faster_mate',
      distanceGap: 2,
    });
  });

  test('AI provider omitted → valid puzzle with engine fields and no LLM text', async () => {
    const engine = createFakeAnalysisProvider(sharpGoHandler);

    // Note: no `ai` option supplied.
    const generator = new PuzzleGenerator({ engine });
    const result = await generator.generate({ fen: TEST_FEN });

    assert.equal(result.kind, 'puzzle');
    const puzzle = result as import('../src/index.js').Puzzle;

    // Engine fields are fully populated.
    assert.equal(puzzle.solutionMove, 'd8a5');
    assert.equal(puzzle.bestEval.value, 350);
    assert.deepEqual(puzzle.evidence, { kind: 'centipawn_gap', gapCp: 270 });
    assert.deepEqual([...puzzle.solutionLine], ['d8a5', 'b1c3']);
    assert.equal(puzzle.depth, 20);

    // LLM fields are null — the LLM is not load-bearing.
    assert.equal(puzzle.theme, null);
    assert.equal(puzzle.hint, null);
    assert.equal(puzzle.providerId, null);
    assert.equal(puzzle.model, null);
    assert.equal(puzzle.usage, null);
    assert.equal(puzzle.latencyMs, null);
  });

  test('custom sharpness threshold is respected', async () => {
    const engine = createFakeAnalysisProvider(sharpGoHandler);
    const ai = new FakeProvider({ id: 'fake-ai', content: 'THEME: Test\nHINT: Test.' });

    // The gap is 270cp.  Set threshold to 300 → should reject.
    const generator = new PuzzleGenerator({ engine, ai });
    const result = await generator.generate({
      fen: TEST_FEN,
      sharpnessThreshold: 300,
    });

    assert.equal(result.kind, 'rejection');
    const rejection = result as import('../src/index.js').PuzzleRejection;
    assert.deepEqual(rejection.evidence, { kind: 'centipawn_gap', gapCp: 270 });
    assert.equal(rejection.thresholdCp, 300);
  });

  test('accepts pre-computed analysis and skips engine call', async () => {
    // Engine that would throw if called.
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        throw new Error('Engine should not be called when pre-computed analysis is supplied');
      },
      async play(): Promise<PlayResult> {
        throw new Error('play should not be called');
      },
      capabilitiesFor(): EngineCapabilities | undefined {
        return undefined;
      },
    };

    const ai = new FakeProvider({ id: 'fake-ai', content: 'THEME: Fork\nHINT: Look for a knight fork.' });

    const preComputed: EngineResult[] = [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 500 },
        principalVariation: ['e2e4', 'e7e5'],
        depth: 22,
        selDepth: 28,
        nodes: 2_000_000,
        nps: 800_000,
        timeMs: 2500,
      },
      {
        multipv: 2,
        evaluation: { type: 'cp', value: 100 },
        principalVariation: ['d2d4', 'd7d5'],
        depth: 22,
        selDepth: 27,
        nodes: 2_000_000,
        nps: 800_000,
        timeMs: 2500,
      },
    ];

    const generator = new PuzzleGenerator({ engine, ai });
    const result = await generator.generate({
      fen: TEST_FEN,
      analysis: preComputed,
      multiPv: 2,
    });

    assert.equal(result.kind, 'puzzle');
    const puzzle = result as import('../src/index.js').Puzzle;
    assert.equal(puzzle.solutionMove, 'e2e4');
    assert.deepEqual(puzzle.evidence, { kind: 'centipawn_gap', gapCp: 400 });
    assert.deepEqual([...puzzle.solutionLine], ['e2e4', 'e7e5']);
  });

  test('difficulty is derived from gap and depth', async () => {
    const engine = createFakeAnalysisProvider(sharpGoHandler);
    const generator = new PuzzleGenerator({ engine });

    // Gap = 270, depth = 20 → medium (gap 200-400 with depth ≥ 20)
    const result = await generator.generate({ fen: TEST_FEN });
    assert.equal(result.kind, 'puzzle');
    const puzzle = result as import('../src/index.js').Puzzle;
    assert.equal(puzzle.difficulty, 'medium');
  });

  test('fewer than two lines is insufficient evidence, not a quiet position', async () => {
    const generator = new PuzzleGenerator({
      engine: createFakeAnalysisProvider(() => ({
        info: ['info depth 20 multipv 1 score cp 500 nodes 1 time 1 pv e2e4'],
        bestmove: 'e2e4',
      })),
    });

    const result = await generator.generate({ fen: TEST_FEN });

    assert.deepEqual(result, {
      kind: 'insufficient',
      fen: TEST_FEN,
      reason: 'not_enough_lines',
      bestMove: 'e2e4',
      comparisonMove: null,
    });
  });

  test('a missing best move is explicit insufficient evidence', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, []),
      result(2, { type: 'cp', value: 0 }, ['d2d4']),
    ];
    const generator = new PuzzleGenerator();

    const generated = await generator.generate({ fen: TEST_FEN, analysis });

    assert.deepEqual(generated, {
      kind: 'insufficient',
      fen: TEST_FEN,
      reason: 'missing_best_move',
      bestMove: null,
      comparisonMove: 'd2d4',
    });
  });

  test('a missing comparison move is explicit insufficient evidence', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, ['e2e4']),
      result(2, { type: 'cp', value: 0 }, []),
    ];
    const generator = new PuzzleGenerator();

    const generated = await generator.generate({ fen: TEST_FEN, analysis });

    assert.deepEqual(generated, {
      kind: 'insufficient',
      fen: TEST_FEN,
      reason: 'missing_comparison_move',
      bestMove: 'e2e4',
      comparisonMove: null,
    });
  });

  test('duplicate best and comparison moves cannot establish uniqueness', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, ['e2e4', 'e7e5']),
      result(2, { type: 'cp', value: 0 }, ['e2e4', 'c7c5']),
    ];

    const generated = await new PuzzleGenerator().generate({ fen: TEST_FEN, analysis });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'duplicate_moves');
  });

  test('non-finite engine scores are explicit insufficient evidence', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: Number.NaN }, ['e2e4']),
      result(2, { type: 'cp', value: 0 }, ['d2d4']),
    ];
    const generator = new PuzzleGenerator();

    const generated = await generator.generate({ fen: TEST_FEN, analysis });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'non_finite_evaluation');
    assert.doesNotMatch(JSON.stringify(generated), /Infinity|NaN|\(none\)/);
  });

  test('finite scores whose subtraction overflows cannot escape as infinite evidence', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: Number.MAX_VALUE }, ['e2e4']),
      result(2, { type: 'cp', value: -Number.MAX_VALUE }, ['d2d4']),
    ];

    const generated = await new PuzzleGenerator().generate({ fen: TEST_FEN, analysis });

    assert.equal(generated.kind, 'insufficient');
    assert.doesNotMatch(JSON.stringify(generated), /Infinity|NaN|\(none\)/);
  });

  test('evalGapCp returns null when finite operands overflow during subtraction', () => {
    assert.equal(
      evalGapCp(
        { type: 'cp', value: Number.MAX_VALUE },
        { type: 'cp', value: -Number.MAX_VALUE },
      ),
      null,
    );
  });

  test('an invalid move later in the solution line is insufficient and never serialized', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, ['e2e4', '(none)']),
      result(2, { type: 'cp', value: 0 }, ['d2d4']),
    ];

    const generated = await new PuzzleGenerator().generate({ fen: TEST_FEN, analysis });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'invalid_solution_line');
    assert.doesNotMatch(JSON.stringify(generated), /\(none\)/);
  });

  test('a zero-depth comparison line is incomplete evidence', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, ['e2e4']),
      { ...result(2, { type: 'cp', value: 0 }, ['d2d4']), depth: 0 },
    ];

    const generated = await new PuzzleGenerator().generate({ fen: TEST_FEN, analysis });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'incomplete_depth');
  });

  test('a bounded score is insufficient evidence', async () => {
    const analysis: EngineResult[] = [
      { ...result(1, { type: 'cp', value: 500 }, ['e2e4']), evaluationBound: 'lowerbound' },
      result(2, { type: 'cp', value: 0 }, ['d2d4']),
      result(3, { type: 'cp', value: -50 }, ['g1f3']),
    ];

    const generated = await new PuzzleGenerator().generate({ fen: TEST_FEN, analysis });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'bounded_evaluation');
  });

  test('mismatched MultiPV depths are insufficient evidence', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, ['e2e4']),
      { ...result(2, { type: 'cp', value: 0 }, ['d2d4']), depth: 19 },
      result(3, { type: 'cp', value: -50 }, ['g1f3']),
    ];

    const generated = await new PuzzleGenerator().generate({ fen: TEST_FEN, analysis });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'mismatched_depth');
  });

  test('missing requested MultiPV rank is insufficient evidence', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, ['e2e4']),
      result(2, { type: 'cp', value: 0 }, ['d2d4']),
    ];

    const generated = await new PuzzleGenerator().generate({ fen: TEST_FEN, analysis, multiPv: 3 });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'incomplete_multipv');
  });

  test('duplicate requested MultiPV ranks are insufficient evidence', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, ['e2e4']),
      result(2, { type: 'cp', value: 0 }, ['d2d4']),
      result(2, { type: 'cp', value: -50 }, ['g1f3']),
    ];

    const generated = await new PuzzleGenerator().generate({ fen: TEST_FEN, analysis, multiPv: 3 });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'incomplete_multipv');
  });

  test('a requested MultiPV line below the required depth is incomplete evidence', async () => {
    const analysis: EngineResult[] = [
      { ...result(1, { type: 'cp', value: 500 }, ['e2e4']), depth: 15 },
      { ...result(2, { type: 'cp', value: 0 }, ['d2d4']), depth: 15 },
      { ...result(3, { type: 'cp', value: -50 }, ['g1f3']), depth: 15 },
    ];

    const generated = await new PuzzleGenerator().generate({
      fen: TEST_FEN,
      analysis,
      limits: { depth: 16 },
      multiPv: 3,
    });

    assert.equal(generated.kind, 'insufficient');
    assert.equal(generated.reason, 'incomplete_depth');
  });

  test('a non-finite caller threshold falls back to the safe default', async () => {
    const analysis: EngineResult[] = [
      result(1, { type: 'cp', value: 500 }, ['e2e4']),
      result(2, { type: 'cp', value: 0 }, ['d2d4']),
    ];
    const generator = new PuzzleGenerator({ defaultSharpnessThreshold: Number.POSITIVE_INFINITY });

    const generated = await generator.generate({
      fen: TEST_FEN,
      analysis,
      sharpnessThreshold: Number.NaN,
    });

    assert.equal(generated.kind, 'puzzle');
    assert.doesNotMatch(JSON.stringify(generated), /Infinity|NaN|\(none\)/);
  });

  test('grounding is passed to the AI provider when supplied', async () => {
    const engine = createFakeAnalysisProvider(sharpGoHandler);
    const ai = new FakeProvider({
      id: 'fake-ai',
      content: 'THEME: Pin\nHINT: Look for a pin.',
    });

    const generator = new PuzzleGenerator({ engine, ai });
    await generator.generate({ fen: TEST_FEN });

    assert.equal(ai.calls.length, 1);
    const call = ai.calls[0];
    assert.equal(call.task, 'puzzle_generation');
    assert.ok(call.grounding);
    assert.equal(call.grounding!.fen, TEST_FEN);
    assert.equal(call.grounding!.moveUci, 'd8a5');
    assert.equal(call.grounding!.evalCp, 350);
  });
});

function result(
  multipv: number,
  evaluation: EngineResult['evaluation'],
  principalVariation: readonly string[],
): EngineResult {
  return {
    multipv,
    evaluation,
    principalVariation,
    depth: 20,
    selDepth: 20,
    nodes: 1,
    nps: 1,
    timeMs: 1,
  };
}
