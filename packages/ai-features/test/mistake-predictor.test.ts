/**
 * Hermetic test suite for `MistakePredictor`.
 *
 * Drives the predictor end-to-end with `FakeEngineTransport` (via a
 * lightweight `AnalysisProvider` fake) + `FakeProvider` (M7's fake AI
 * provider).  No keys, no binary, no network.
 *
 * Tests assert that:
 * - A clear blunder (large eval swing) → `blunder` with correct cp loss
 *   and the engine's better move.
 * - A good move (near-zero loss) → `ok` / not a mistake.
 * - An inaccuracy and a mistake at threshold boundaries → correct
 *   classification.
 * - A sign-correctness test: a position where naïve (un-flipped) eval
 *   math would misclassify, proving the perspective flip is handled
 *   right.
 * - A move that walks into mate → always `blunder`.
 * - AI provider omitted → valid verdict with engine fields and no LLM
 *   text.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { FakeEngineTransport, UciEngineInstance } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';

import { MistakePredictor, negateEval, evalToCpLoss, classify } from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers: build a real AnalysisProvider backed by FakeEngineTransport
// ---------------------------------------------------------------------------

/**
 * Creates an `AnalysisProvider` backed by a `FakeEngineTransport` that
 * returns scripted `info` lines + `bestmove` for a given FEN.
 *
 * The `goHandler` receives the FEN of the position being analysed, so
 * different positions can return different scripted responses.
 */
function createFakeAnalysisProvider(
  goHandler: (goCommand: string, positionFen: string | null) => { info: readonly string[]; bestmove: string; ponder?: string } | 'hang',
): AnalysisProvider {
  // Create a fresh transport + instance for each analyze/play call.
  // UciEngineInstance can only be init()ed once, and MistakePredictor
  // calls analyze() twice (before + after positions).
  const provider: AnalysisProvider = {
    async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
      const transport = new FakeEngineTransport({
        name: 'FakeStockfish 1.0',
        author: 'chess-platform',
        go: goHandler,
      });
      const instance = new UciEngineInstance(transport, { id: `fake-${Date.now()}-${Math.random()}` });
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
      const transport = new FakeEngineTransport({
        name: 'FakeStockfish 1.0',
        author: 'chess-platform',
        go: goHandler,
      });
      const instance = new UciEngineInstance(transport, { id: `fake-${Date.now()}-${Math.random()}` });
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
// Known positions
// ---------------------------------------------------------------------------

// Starting position — a safe, well-known FEN for testing.
const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// A middlegame position where White is clearly better (+200cp).
// White to move. Best move is Nf3 (g1f3).
const WHITE_BETTER = 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1';

// ---------------------------------------------------------------------------
// Scripted engine responses
// ---------------------------------------------------------------------------

/**
 * Creates a goHandler that returns different responses based on the FEN
 * being analysed.  This lets us script both the "before" and "after"
 * positions in a single test.
 */
function scriptedProvider(
  responses: Map<string, { info: readonly string[]; bestmove: string }>,
): AnalysisProvider {
  return createFakeAnalysisProvider((_go, fen) => {
    // Normalise FEN: the FakeEngineTransport may report 'startpos' or a FEN.
    // Try exact match first, then try matching on the first 6 fields.
    if (fen && responses.has(fen)) {
      return responses.get(fen)!;
    }
    // Try matching on FEN prefix (first part before moves)
    if (fen) {
      for (const [key, val] of responses) {
        if (key.startsWith(fen.slice(0, 20)) || fen.startsWith(key.slice(0, 20))) {
          return val;
        }
      }
    }
    // Default: return a neutral eval.
    return {
      info: ['info depth 20 seldepth 25 multipv 1 score cp 0 nodes 1000000 nps 500000 time 2000 pv e2e4'],
      bestmove: 'e2e4',
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MistakePredictor (hermetic)', () => {

  test('clear blunder: large eval swing → blunder with correct cp loss and better move', async () => {
    // Original position: White to move, eval = +200cp (White is better).
    // Candidate move: a blunder that drops the eval to -200cp from White's perspective.
    // After the move, it's Black's turn. Engine says eval = +200cp (Black's perspective).
    // Negated: -200cp from White's perspective.
    // Loss = 200 - (-200) = 400cp → blunder (≥ 300).

    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    // After playing a weak move (a2a3), the position is:
    const afterFen = 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1';

    const responses = new Map([
      [beforeFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 200 nodes 1000000 nps 500000 time 2000 pv g1f3'],
        bestmove: 'g1f3',
      }],
      [afterFen, {
        // Engine eval from Black's perspective: +200cp (Black is now better)
        info: ['info depth 20 seldepth 25 multipv 1 score cp 200 nodes 1000000 nps 500000 time 2000 pv e7e5'],
        bestmove: 'e7e5',
      }],
    ]);

    const engine = scriptedProvider(responses);
    const ai = new FakeProvider({
      id: 'fake-ai',
      content: 'This move drops the advantage. Nf3 would have kept the initiative.',
    });

    const predictor = new MistakePredictor({ engine, ai });
    const result = await predictor.predict({
      fen: beforeFen,
      move: 'a2a3',
    });

    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, 400); // 200 - (-200) = 400
    assert.equal(result.evalBefore.type, 'cp');
    assert.equal(result.evalBefore.value, 200);
    assert.equal(result.evalBeforeLabel, '+2.00');
    // evalAfterMoverPerspective should be -200 (negated from +200)
    assert.equal(result.evalAfterMoverPerspective.type, 'cp');
    assert.equal(result.evalAfterMoverPerspective.value, -200);
    assert.equal(result.evalAfterLabel, '-2.00');
    assert.equal(result.betterMove, 'g1f3');
    assert.deepEqual([...result.bestLine], ['g1f3']);
    assert.equal(result.depth, 20);

    // LLM coaching text
    assert.ok(result.coaching);
    assert.equal(result.providerId, 'fake-ai');
  });

  test('good move: near-zero loss → ok / not a mistake', async () => {
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    // After playing e2e4 (a good move):
    const afterFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

    const responses = new Map([
      [beforeFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 20 nodes 1000000 nps 500000 time 2000 pv e2e4'],
        bestmove: 'e2e4',
      }],
      [afterFen, {
        // After e2e4, Black's perspective: eval = -15cp (Black is slightly worse)
        // Negated: +15cp from White's perspective
        info: ['info depth 20 seldepth 25 multipv 1 score cp -15 nodes 1000000 nps 500000 time 2000 pv e7e5'],
        bestmove: 'e7e5',
      }],
    ]);

    const engine = scriptedProvider(responses);
    const predictor = new MistakePredictor({ engine });

    const result = await predictor.predict({
      fen: beforeFen,
      move: 'e2e4',
    });

    // Loss = 20 - 15 = 5cp → ok (< 50 threshold)
    assert.equal(result.classification, 'ok');
    assert.equal(result.centipawnLoss, 5);
    assert.equal(result.evalBefore.value, 20);
    assert.equal(result.evalAfterMoverPerspective.value, 15); // negated from -15
  });

  test('inaccuracy at threshold boundary (50cp loss)', async () => {
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterFen = 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1';

    // evalBefore = +100cp, evalAfter (Black's perspective) = +50cp
    // Negated: -50cp from White's perspective
    // Loss = 100 - (-50) = 150 → mistake (≥ 100)
    // Actually let's make it exactly 50 for inaccuracy:
    // evalBefore = +50, evalAfter (Black) = 0 → negated = 0 → loss = 50 → inaccuracy

    const responses = new Map([
      [beforeFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 50 nodes 1000000 nps 500000 time 2000 pv g1f3'],
        bestmove: 'g1f3',
      }],
      [afterFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 0 nodes 1000000 nps 500000 time 2000 pv e7e5'],
        bestmove: 'e7e5',
      }],
    ]);

    const engine = scriptedProvider(responses);
    const predictor = new MistakePredictor({ engine });

    const result = await predictor.predict({
      fen: beforeFen,
      move: 'a2a3',
    });

    // Loss = 50 - 0 = 50 → inaccuracy (≥ 50, < 100)
    assert.equal(result.classification, 'inaccuracy');
    assert.equal(result.centipawnLoss, 50);
  });

  test('mistake at threshold boundary (100cp loss)', async () => {
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterFen = 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1';

    // evalBefore = +100, evalAfter (Black) = 0 → negated = 0 → loss = 100 → mistake

    const responses = new Map([
      [beforeFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 100 nodes 1000000 nps 500000 time 2000 pv g1f3'],
        bestmove: 'g1f3',
      }],
      [afterFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 0 nodes 1000000 nps 500000 time 2000 pv e7e5'],
        bestmove: 'e7e5',
      }],
    ]);

    const engine = scriptedProvider(responses);
    const predictor = new MistakePredictor({ engine });

    const result = await predictor.predict({
      fen: beforeFen,
      move: 'a2a3',
    });

    // Loss = 100 - 0 = 100 → mistake (≥ 100, < 300)
    assert.equal(result.classification, 'mistake');
    assert.equal(result.centipawnLoss, 100);
  });

  test('sign-correctness: naïve (un-flipped) eval math would misclassify', async () => {
    // This is the critical test.  The engine reports eval from the
    // side-to-move's perspective.  After the candidate move, it's the
    // opponent's turn, so the engine's eval is from the opponent's
    // perspective.
    //
    // Scenario: White to move, eval = +50cp (White slightly better).
    // Candidate move: a reasonable move.  After the move, Black to move.
    // Engine says eval = -30cp from Black's perspective (Black is slightly
    // worse, which means White is still better).
    //
    // CORRECT: negate(-30) = +30 from White's perspective.
    //   Loss = 50 - 30 = 20 → ok.
    //
    // WRONG (no flip): evalAfter = -30 from "White's perspective".
    //   Loss = 50 - (-30) = 80 → inaccuracy.
    //
    // If the sign handling is wrong, this test fails: it would classify
    // as 'inaccuracy' instead of 'ok'.

    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';

    const responses = new Map([
      [beforeFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 50 nodes 1000000 nps 500000 time 2000 pv e2e4'],
        bestmove: 'e2e4',
      }],
      [afterFen, {
        // Black's perspective: -30cp (Black is slightly worse)
        info: ['info depth 20 seldepth 25 multipv 1 score cp -30 nodes 1000000 nps 500000 time 2000 pv e7e5'],
        bestmove: 'e7e5',
      }],
    ]);

    const engine = scriptedProvider(responses);
    const predictor = new MistakePredictor({ engine });

    const result = await predictor.predict({
      fen: beforeFen,
      move: 'e2e4',
    });

    // Correct: negate(-30) = +30, loss = 50 - 30 = 20 → ok
    assert.equal(result.evalAfterMoverPerspective.value, 30, 'evalAfter must be negated to mover perspective');
    assert.equal(result.centipawnLoss, 20, 'cp loss must use the negated eval');
    assert.equal(result.classification, 'ok', 'with correct sign handling, this is ok, not inaccuracy');

    // If the sign were wrong (no negation), loss would be 80 → inaccuracy.
    // This assertion explicitly guards against that regression.
    assert.notEqual(result.classification, 'inaccuracy', 'naïve un-flipped math would give inaccuracy — this must not happen');
  });

  test('move that walks into mate → always blunder', async () => {
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterFen = 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1';

    const responses = new Map([
      [beforeFen, {
        // White is winning, eval = +200cp
        info: ['info depth 20 seldepth 25 multipv 1 score cp 200 nodes 1000000 nps 500000 time 2000 pv g1f3'],
        bestmove: 'g1f3',
      }],
      [afterFen, {
        // After the blunder, Black has mate in 3 (from Black's perspective: mate 3)
        // Negated: mate in -3 from White's perspective (White gets mated)
        info: ['info depth 18 seldepth 18 multipv 1 score mate 3 nodes 800000 nps 400000 time 1800 pv d8h4'],
        bestmove: 'd8h4',
      }],
    ]);

    const engine = scriptedProvider(responses);
    const predictor = new MistakePredictor({ engine });

    const result = await predictor.predict({
      fen: beforeFen,
      move: 'a2a3',
    });

    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, Infinity);
    // evalAfterMoverPerspective should be mate in -3 (mover gets mated)
    assert.equal(result.evalAfterMoverPerspective.type, 'mate');
    assert.equal(result.evalAfterMoverPerspective.value, -3);
  });

  test('AI provider omitted → valid verdict with engine fields and no LLM text', async () => {
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterFen = 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1';

    const responses = new Map([
      [beforeFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 200 nodes 1000000 nps 500000 time 2000 pv g1f3'],
        bestmove: 'g1f3',
      }],
      [afterFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 200 nodes 1000000 nps 500000 time 2000 pv e7e5'],
        bestmove: 'e7e5',
      }],
    ]);

    const engine = scriptedProvider(responses);

    // No `ai` option supplied.
    const predictor = new MistakePredictor({ engine });
    const result = await predictor.predict({
      fen: beforeFen,
      move: 'a2a3',
    });

    // Engine fields are fully populated.
    assert.equal(result.classification, 'blunder');
    assert.equal(result.centipawnLoss, 400);
    assert.equal(result.betterMove, 'g1f3');
    assert.equal(result.evalBefore.value, 200);
    assert.equal(result.evalAfterMoverPerspective.value, -200);

    // LLM fields are null — the LLM is not load-bearing.
    assert.equal(result.coaching, null);
    assert.equal(result.providerId, null);
    assert.equal(result.model, null);
    assert.equal(result.usage, null);
    assert.equal(result.latencyMs, null);
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

    const ai = new FakeProvider({ id: 'fake-ai', content: 'Coaching text.' });

    const analysisBefore: EngineResult[] = [
      {
        multipv: 1,
        evaluation: { type: 'cp', value: 150 },
        principalVariation: ['g1f3', 'e7e5'],
        depth: 22,
        selDepth: 28,
        nodes: 2_000_000,
        nps: 800_000,
        timeMs: 2500,
      },
    ];

    const analysisAfter: EngineResult[] = [
      {
        multipv: 1,
        // From the opponent's perspective: +50cp (opponent is better)
        evaluation: { type: 'cp', value: 50 },
        principalVariation: ['e7e5', 'g1f3'],
        depth: 22,
        selDepth: 27,
        nodes: 2_000_000,
        nps: 800_000,
        timeMs: 2500,
      },
    ];

    const predictor = new MistakePredictor({ engine, ai });
    const result = await predictor.predict({
      fen: STARTPOS,
      move: 'e2e4',
      analysisBefore,
      analysisAfter,
    });

    // evalBefore = 150, evalAfter (opponent) = 50, negated = -50
    // Loss = 150 - (-50) = 200 → mistake (≥ 100, < 300)
    assert.equal(result.classification, 'mistake');
    assert.equal(result.centipawnLoss, 200);
    assert.equal(result.evalAfterMoverPerspective.value, -50);
    assert.equal(result.betterMove, 'g1f3');
  });

  test('grounding is passed to the AI provider when supplied', async () => {
    const beforeFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const afterFen = 'rnbqkbnr/pppppppp/8/8/8/P7/1PPPPPPP/RNBQKBNR b KQkq - 0 1';

    const responses = new Map([
      [beforeFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 200 nodes 1000000 nps 500000 time 2000 pv g1f3'],
        bestmove: 'g1f3',
      }],
      [afterFen, {
        info: ['info depth 20 seldepth 25 multipv 1 score cp 200 nodes 1000000 nps 500000 time 2000 pv e7e5'],
        bestmove: 'e7e5',
      }],
    ]);

    const engine = scriptedProvider(responses);
    const ai = new FakeProvider({
      id: 'fake-ai',
      content: 'This is a blunder. Play Nf3 instead.',
    });

    const predictor = new MistakePredictor({ engine, ai });
    await predictor.predict({
      fen: beforeFen,
      move: 'a2a3',
    });

    assert.equal(ai.calls.length, 1);
    const call = ai.calls[0];
    assert.equal(call.task, 'mistake_prediction');
    assert.ok(call.grounding);
    assert.equal(call.grounding!.fen, beforeFen);
    assert.equal(call.grounding!.moveUci, 'a2a3');
    assert.equal(call.grounding!.evalCp, 200);
  });
});

// ---------------------------------------------------------------------------
// Pure function unit tests
// ---------------------------------------------------------------------------

describe('MistakePredictor pure functions', () => {

  test('negateEval flips cp value', () => {
    assert.deepEqual(negateEval({ type: 'cp', value: 50 }), { type: 'cp', value: -50 });
    assert.deepEqual(negateEval({ type: 'cp', value: -30 }), { type: 'cp', value: 30 });
    // negate(0) produces -0 in JS; use Object.is to verify it's zero.
    const result = negateEval({ type: 'cp', value: 0 });
    assert.equal(result.type, 'cp');
    assert.ok(Object.is(result.value, 0) || Object.is(result.value, -0));
  });

  test('negateEval flips mate value', () => {
    // mate in 3 (side to move wins) → mate in -3 (opponent wins)
    assert.deepEqual(negateEval({ type: 'mate', value: 3 }), { type: 'mate', value: -3 });
    // mate in -5 (side to move gets mated) → mate in 5 (opponent gets mated)
    assert.deepEqual(negateEval({ type: 'mate', value: -5 }), { type: 'mate', value: 5 });
  });

  test('evalToCpLoss: both cp, simple subtraction', () => {
    const before = { type: 'cp' as const, value: 200 };
    const after = { type: 'cp' as const, value: -200 };
    assert.equal(evalToCpLoss(before, after), 400);
  });

  test('evalToCpLoss: move walks into mate → Infinity', () => {
    const before = { type: 'cp' as const, value: 200 };
    const after = { type: 'mate' as const, value: -3 }; // mover gets mated
    assert.equal(evalToCpLoss(before, after), Infinity);
  });

  test('evalToCpLoss: throws away forced mate → Infinity', () => {
    const before = { type: 'mate' as const, value: 3 }; // mover was winning
    const after = { type: 'cp' as const, value: 50 };
    assert.equal(evalToCpLoss(before, after), Infinity);
  });

  test('evalToCpLoss: still winning after move → 0', () => {
    const before = { type: 'mate' as const, value: 3 };
    const after = { type: 'mate' as const, value: 5 }; // still mate, just slower
    assert.equal(evalToCpLoss(before, after), 0);
  });

  test('classify: thresholds', () => {
    assert.equal(classify(0, 50, 100, 300), 'ok');
    assert.equal(classify(49, 50, 100, 300), 'ok');
    assert.equal(classify(50, 50, 100, 300), 'inaccuracy');
    assert.equal(classify(99, 50, 100, 300), 'inaccuracy');
    assert.equal(classify(100, 50, 100, 300), 'mistake');
    assert.equal(classify(299, 50, 100, 300), 'mistake');
    assert.equal(classify(300, 50, 100, 300), 'blunder');
    assert.equal(classify(Infinity, 50, 100, 300), 'blunder');
  });
});
