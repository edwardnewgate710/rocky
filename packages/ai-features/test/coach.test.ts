/**
 * Hermetic test suite for `Coach`.
 *
 * Drives the Coach end-to-end with fakes-backed features.  Tests that:
 * - A position with a played blunder → MistakePredictor verdict + MoveExplainer.
 * - An in-book opening position → OpeningExplorer identification.
 * - A sharp tactical position → puzzle flagged.
 * - A recognized endgame → endgame guidance.
 * - A quiet, non-book, non-tactical, non-endgame position with a fine move →
 *   NO fabricated lessons (the key failure mode).
 * - AI provider omitted → structured results present, narrative null.
 * - The Coach calls the underlying features (spy test).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities, AnalysisLimits } from '@chess-platform/engine';
import { FakeEngineTransport, UciEngineInstance } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';

import { Coach } from '../src/index.js';
import { MoveExplainer } from '../src/move-explainer.js';
import { MistakePredictor } from '../src/mistake-predictor.js';
import { OpeningExplorer } from '../src/opening-explorer.js';
import { PuzzleGenerator } from '../src/puzzle-generator.js';
import { EndgameTrainer } from '../src/endgame-trainer.js';
import { BundledOpeningDatabase } from '../src/bundled-opening-database.js';
import { BundledEndgameDatabase } from '../src/bundled-endgame-database.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakeAnalysisProvider(
  goHandler: (goCommand: string, positionFen: string | null) => { info: readonly string[]; bestmove: string; ponder?: string } | 'hang',
): AnalysisProvider {
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

/** A multi-PV fake that returns different responses based on multiPv count. */
function createMultiPvProvider(
  singlePvInfo: string,
  multiPvInfo: readonly string[],
): AnalysisProvider {
  return createFakeAnalysisProvider((_go, _fen) => {
    // The FakeEngineTransport doesn't distinguish multiPv in the go command,
    // but the UciEngineInstance sets MultiPV via setoption. The fake
    // transport just returns whatever info lines we give it.
    // For puzzle detection, we need multiPv > 1.
    // For simplicity, return the multiPv lines always — the instance
    // will parse all of them.
    return {
      info: multiPvInfo.length > 0 ? multiPvInfo : [singlePvInfo],
      bestmove: multiPvInfo[0]?.split(' pv ')[1]?.split(' ')[0] ?? 'e2e4',
    };
  });
}

// ---------------------------------------------------------------------------
// Known positions
// ---------------------------------------------------------------------------

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const KQ_FEN = '7k/8/6Q1/8/8/8/8/4K3 w - - 0 1'; // K+Q vs K endgame

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Coach (hermetic)', () => {

  test('position with a played blunder → MistakePredictor verdict + MoveExplainer', async () => {
    // Use pre-computed analysis for the mistake predictor to control evals.
    // evalBefore = +200cp, evalAfter (opponent perspective) = +200cp → negated = -200cp
    // Loss = 400 → blunder. Better move = g1f3.
    const engine: AnalysisProvider = {
      async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
        // Return different results based on the FEN
        if (request.fen === STARTPOS) {
          return [{
            multipv: 1,
            evaluation: { type: 'cp', value: 200 },
            principalVariation: ['g1f3', 'e7e5'],
            depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000,
          }];
        }
        // After the blunder move (a2a3), opponent's perspective
        return [{
          multipv: 1,
          evaluation: { type: 'cp', value: 200 },
          principalVariation: ['e7e5'],
          depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000,
        }];
      },
      async play(): Promise<PlayResult> { return { move: 'g1f3' }; },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    const ai = new FakeProvider({ id: 'fake-ai', content: 'Coaching narrative.' });

    const coach = new Coach({ engine, ai });
    const result = await coach.coach({
      fen: STARTPOS,
      move: 'a2a3',
    });

    // MistakePredictor should fire and report a blunder.
    assert.ok(result.mistakeVerdict, 'MistakePredictor should produce a verdict');
    assert.equal(result.mistakeVerdict!.classification, 'blunder');
    assert.equal(result.mistakeVerdict!.betterMove, 'g1f3');
    assert.ok(result.featuresFired.includes('mistakePredictor'));

    // MoveExplainer should fire for the better move.
    assert.ok(result.moveExplanation, 'MoveExplainer should explain the better move');
    assert.ok(result.featuresFired.includes('moveExplainer'));

    // Narrative should be present.
    assert.ok(result.narrative);
    assert.equal(result.providerId, 'fake-ai');
  });

  test('in-book opening position → OpeningExplorer identification', async () => {
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 20 seldepth 25 multipv 1 score cp 30 nodes 1000000 nps 500000 time 2000 pv g1f3'],
      bestmove: 'g1f3',
    }));
    const ai = new FakeProvider({ id: 'fake-ai', content: 'Opening narrative.' });

    const coach = new Coach({ engine, ai });
    const result = await coach.coach({
      fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'],
    });

    assert.ok(result.opening, 'OpeningExplorer should identify the opening');
    assert.equal(result.opening!.eco, 'C60');
    assert.equal(result.opening!.name, 'Ruy Lopez (Spanish Opening)');
    assert.ok(result.featuresFired.includes('openingExplorer'));
  });

  test('sharp tactical position → puzzle flagged', async () => {
    // Use a position where multiPv shows a big gap.
    // The PuzzleGenerator needs multiPv >= 2.
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: [
        'info depth 20 seldepth 25 multipv 1 score cp 350 nodes 1000000 nps 500000 time 2000 pv d8a5 b1c3',
        'info depth 20 seldepth 24 multipv 2 score cp 80 nodes 1000000 nps 500000 time 2000 pv e7e6 d2d4',
        'info depth 20 seldepth 23 multipv 3 score cp 30 nodes 1000000 nps 500000 time 2000 pv g8f6 e2e4',
      ],
      bestmove: 'd8a5',
    }));

    const ai = new FakeProvider({ id: 'fake-ai', content: 'Puzzle narrative.' });
    const coach = new Coach({ engine, ai });

    const result = await coach.coach({
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR b KQkq - 0 1',
    });

    assert.ok(result.puzzle, 'PuzzleGenerator should detect a puzzle');
    assert.equal(result.puzzle!.kind, 'puzzle');
    assert.ok(result.featuresFired.includes('puzzleGenerator'));
  });

  test('recognized endgame → endgame guidance', async () => {
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 25 seldepth 27 multipv 1 score mate 2 nodes 500000 nps 250000 time 1000 pv g6g7'],
      bestmove: 'g6g7',
    }));

    const ai = new FakeProvider({ id: 'fake-ai', content: 'Endgame narrative.' });
    const coach = new Coach({ engine, ai });

    const result = await coach.coach({
      fen: KQ_FEN, // K+Q vs K, matches bundled endgame entry
    });

    assert.ok(result.endgame, 'EndgameTrainer should provide guidance');
    assert.equal(result.endgame!.entry.type, 'KQ_vs_K');
    assert.ok(result.featuresFired.includes('endgameTrainer'));
  });

  test('quiet, non-book, non-tactical, non-endgame position with fine move → NO fabricated lessons', async () => {
    // This is the critical test: a position where nothing interesting happens.
    // The engine says eval is close to 0, multiPv gap is small (not a puzzle),
    // no opening match (no moves supplied), not an endgame (too many pieces).
    // The move is fine (small cp loss → ok).
    const engine: AnalysisProvider = {
      async analyze(request: AnalysisRequest): Promise<readonly EngineResult[]> {
        if (request.fen === STARTPOS) {
          // Original position: eval = +20cp, best move e2e4
          return [{
            multipv: 1,
            evaluation: { type: 'cp', value: 20 },
            principalVariation: ['e2e4'],
            depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000,
          }];
        }
        // After the fine move (e2e4): opponent perspective = -15cp → negated = +15cp
        // Loss = 20 - 15 = 5 → ok
        return [{
          multipv: 1,
          evaluation: { type: 'cp', value: -15 },
          principalVariation: ['e7e5'],
          depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000,
        }];
      },
      async play(): Promise<PlayResult> { return { move: 'e2e4' }; },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    const ai = new FakeProvider({ id: 'fake-ai', content: 'Narrative.' });
    const coach = new Coach({ engine, ai });

    const result = await coach.coach({
      fen: STARTPOS,
      move: 'e2e4',
      // No moves[] supplied → OpeningExplorer not run.
    });

    // MistakePredictor fires (move was supplied) but reports 'ok'.
    assert.ok(result.mistakeVerdict);
    assert.equal(result.mistakeVerdict!.classification, 'ok');

    // MoveExplainer fires for the better move.
    // (The Coach always explains the better move when a move is supplied.)
    // This is acceptable — it's explaining what the engine recommends,
    // not fabricating a lesson about the player's move.
    // But the key assertions are:
    // No opening (no moves supplied).
    assert.equal(result.opening, null, 'No opening should be identified without a move sequence');

    // No puzzle (the position is not sharp — but the PuzzleGenerator
    // always runs. With a single PV, the gap is 0, so it should reject.
    // Actually, the fake engine returns only 1 PV, so the PuzzleGenerator
    // will get 1 result and reject (fewer than 2 lines).
    assert.equal(result.puzzle, null, 'No puzzle should be detected for a quiet position');

    // No endgame (32 pieces on the board, way more than 7).
    assert.equal(result.endgame, null, 'No endgame guidance for a full-board position');

    // The key assertion: the Coach does NOT fabricate lessons.
    // featuresFired should only contain mistakePredictor and moveExplainer
    // (which are always run when a move is supplied), NOT openingExplorer,
    // puzzleGenerator, or endgameTrainer.
    assert.ok(!result.featuresFired.includes('openingExplorer'), 'Should not fire openingExplorer');
    assert.ok(!result.featuresFired.includes('puzzleGenerator'), 'Should not fire puzzleGenerator');
    assert.ok(!result.featuresFired.includes('endgameTrainer'), 'Should not fire endgameTrainer');
  });

  test('AI provider omitted → structured results present, narrative null', async () => {
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        return [{
          multipv: 1,
          evaluation: { type: 'cp', value: 200 },
          principalVariation: ['g1f3', 'e7e5'],
          depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000,
        }];
      },
      async play(): Promise<PlayResult> { return { move: 'g1f3' }; },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    // No AI supplied.
    const coach = new Coach({ engine });
    const result = await coach.coach({
      fen: STARTPOS,
      move: 'a2a3',
    });

    // MistakePredictor fires (it doesn't need AI for the verdict).
    assert.ok(result.mistakeVerdict);

    // MoveExplainer is NOT available without an AI provider (it requires
    // AI to produce the explanation text). This is correct — the LLM is
    // not load-bearing for the engine-verified verdict, but the explainer
    // inherently needs an LLM to produce prose.
    assert.equal(result.moveExplanation, null);

    // No LLM text.
    assert.equal(result.narrative, null);
    assert.equal(result.providerId, null);
    assert.equal(result.model, null);
    assert.equal(result.usage, null);
  });

  test('Coach calls the underlying features (spy test)', async () => {
    // Create spy feature wrappers that record calls.
    let mistakePredictorCalled = false;
    let moveExplainerCalled = false;
    let puzzleGeneratorCalled = false;

    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        return [{
          multipv: 1,
          evaluation: { type: 'cp', value: 200 },
          principalVariation: ['g1f3'],
          depth: 20, selDepth: 25, nodes: 1000000, nps: 500000, timeMs: 2000,
        }];
      },
      async play(): Promise<PlayResult> { return { move: 'g1f3' }; },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    // Wrap the real features with spies.
    const realMistakePredictor = new MistakePredictor({ engine });
    const mistakePredictor: MistakePredictor = {
      ...realMistakePredictor,
      async predict(request) {
        mistakePredictorCalled = true;
        return realMistakePredictor.predict(request);
      },
    } as MistakePredictor;

    const realMoveExplainer = new MoveExplainer({ engine, ai: new FakeProvider({ id: 'fake', content: 'x' }) });
    const moveExplainer: MoveExplainer = {
      ...realMoveExplainer,
      async explain(request) {
        moveExplainerCalled = true;
        return realMoveExplainer.explain(request);
      },
    } as MoveExplainer;

    const realPuzzleGenerator = new PuzzleGenerator({ engine });
    const puzzleGenerator: PuzzleGenerator = {
      ...realPuzzleGenerator,
      async generate(request) {
        puzzleGeneratorCalled = true;
        return realPuzzleGenerator.generate(request);
      },
    } as PuzzleGenerator;

    const coach = new Coach({
      engine,
      features: {
        mistakePredictor,
        moveExplainer,
        puzzleGenerator,
      },
    });

    await coach.coach({ fen: STARTPOS, move: 'a2a3' });

    // Verify the Coach called the features rather than re-deriving.
    assert.ok(mistakePredictorCalled, 'Coach should call MistakePredictor.predict');
    assert.ok(moveExplainerCalled, 'Coach should call MoveExplainer.explain');
    assert.ok(puzzleGeneratorCalled, 'Coach should call PuzzleGenerator.generate');
  });

  test('canonical Three-Check FEN is coached under the requested rule set', async () => {
    const threeCheckFen = '4k3/8/8/8/8/8/8/3R3K w - - 3+3 0 1';
    const before: EngineResult = {
      multipv: 1,
      evaluation: { type: 'cp', value: 100 },
      principalVariation: ['d1e1'],
      depth: 20,
      selDepth: 22,
      nodes: 1000,
      nps: 1000,
      timeMs: 10,
    };
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        return [{ ...before, evaluation: { type: 'cp', value: -100 } }];
      },
      async play(): Promise<PlayResult> { return { move: 'd1e1' }; },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    const coaching = await new Coach({ engine }).coach({
      fen: threeCheckFen,
      variant: 'threecheck',
      move: 'd1e1',
      analysis: [before],
    });

    assert.equal(coaching.variant, 'threecheck');
    assert.match(coaching.mistakeVerdict?.fenAfter ?? '', / 2\+3 1 1$/);
  });
});
