/**
 * Hermetic test suite for `EndgameTrainer`.
 *
 * Drives the trainer end-to-end with `BundledEndgameDatabase` (the
 * bundled real dataset) + `FakeEngineTransport` (M5 fake) + `FakeProvider`
 * (M7 fake).  No keys, no binary, no network.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { AnalysisProvider, AnalysisRequest, EngineResult, PlayRequest, PlayResult, EngineCapabilities } from '@chess-platform/engine';
import { FakeEngineTransport, UciEngineInstance } from '@chess-platform/engine';
import { FakeProvider } from '@chess-platform/ai-orchestrator';
import { Position } from '@chess-platform/core';

import { EndgameTrainer, BundledEndgameDatabase, classifyAttempt } from '../src/index.js';
import type { EndgameDatabase, EndgameEntry } from '../src/index.js';

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

// ---------------------------------------------------------------------------
// Known position: K+Q vs K, king on edge
// FEN: 7k/8/6Q1/8/8/8/8/4K3 w - - 0 1
// White to move, mate in 2.
// ---------------------------------------------------------------------------

const KQ_FEN = '7k/8/6Q1/8/8/8/8/4K3 w - - 0 1';
const KQ_ENTRY: EndgameEntry = {
  id: 'kq-vs-k-01',
  type: 'KQ_vs_K',
  name: 'Queen vs King mate — king on edge',
  fen: KQ_FEN,
  sideToMove: 'w',
  goal: { kind: 'mate', distance: 2 },
  difficulty: 'beginner',
  technique: 'Use the queen to confine the enemy king to the edge.',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EndgameTrainer (hermetic)', () => {

  test('nextPosition returns training position with goal and engine solution', async () => {
    const db = new BundledEndgameDatabase();
    // Engine says mate in 2, best move Qg7
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 25 seldepth 27 multipv 1 score mate 2 nodes 500000 nps 250000 time 1000 pv g6g7'],
      bestmove: 'g6g7',
    }));
    const ai = new FakeProvider({ id: 'fake-ai', content: 'Teaching narrative.' });

    const trainer = new EndgameTrainer({ database: db, engine, ai });
    const result = await trainer.nextPosition({ id: 'kq-vs-k-01' });

    assert.equal(result.entry.id, 'kq-vs-k-01');
    assert.equal(result.entry.name, 'Queen vs King mate — king on edge');
    assert.equal(result.fen, KQ_FEN);
    assert.equal(result.goal.kind, 'mate');
    assert.equal(result.solution.bestMove, 'g6g7');
    assert.equal(result.solution.eval.type, 'mate');
    assert.equal(result.solution.eval.value, 2);
    assert.equal(result.solution.mateDistance, 2);
    assert.ok(result.narrative);
    assert.equal(result.providerId, 'fake-ai');
  });

  test('evaluateAttempt with optimal move → classified optimal, goal preserved', async () => {
    const db = new BundledEndgameDatabase();
    // Before: mate in 2 (eval = mate 2). After optimal move: mate in 1 (eval = mate 1 from opponent's perspective = mate -1).
    // Negated: mate 1 from mover's perspective. Loss = 0 (still mate, faster). → optimal.
    const engine = createFakeAnalysisProvider((_go, fen) => {
      if (fen === KQ_FEN) {
        return {
          info: ['info depth 25 seldepth 27 multipv 1 score mate 2 nodes 500000 nps 250000 time 1000 pv g6g7'],
          bestmove: 'g6g7',
        };
      }
      // After the move — opponent's perspective: mate in -1 (opponent gets mated in 1)
      return {
        info: ['info depth 25 seldepth 25 multipv 1 score mate -1 nodes 300000 nps 200000 time 800 pv h8h7'],
        bestmove: 'h8h7',
      };
    });

    const trainer = new EndgameTrainer({ database: db, engine });
    const result = await trainer.evaluateAttempt({
      entry: KQ_ENTRY,
      move: 'g6g7',
    });

    assert.equal(result.classification, 'optimal');
    assert.equal(result.goalPreserved, true);
    assert.equal(result.evalBefore.type, 'mate');
    assert.equal(result.evalBefore.value, 2);
    // After move: opponent sees mate -1, negated = mate 1 (mover still mates)
    assert.equal(result.evalAfterMoverPerspective.type, 'mate');
    assert.equal(result.evalAfterMoverPerspective.value, 1);
    assert.equal(result.mateDistanceAfter, 1);
    assert.equal(result.betterMove, 'g6g7');
  });

  test('evaluateAttempt with move that throws away the win → classified throws_result, goal lost', async () => {
    const db = new BundledEndgameDatabase();
    // Use pre-computed analysis to control the eval values precisely.
    // Before: mate in 2. After a bad move: eval = cp 0 (drawn).
    // The move e1e2 is a passive king move. After it, it's Black's turn.
    // Engine says cp 0 from Black's perspective (drawn).
    // Negated: cp 0 from White's perspective. Loss = mate→cp(0) = Infinity.
    // Goal (mate) is NOT preserved. → throws_result.
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        throw new Error('Should use pre-computed analysis');
      },
      async play(): Promise<PlayResult> { throw new Error('play not called'); },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    const trainer = new EndgameTrainer({ database: db, engine });
    const result = await trainer.evaluateAttempt({
      entry: KQ_ENTRY,
      move: 'e1e2',
      analysisBefore: [{
        multipv: 1,
        evaluation: { type: 'mate', value: 2 },
        principalVariation: ['g6g7'],
        depth: 25, selDepth: 27, nodes: 500000, nps: 250000, timeMs: 1000,
      }],
      analysisAfter: [{
        multipv: 1,
        // Opponent's perspective: cp 0 (drawn)
        evaluation: { type: 'cp', value: 0 },
        principalVariation: ['h8h7'],
        depth: 25, selDepth: 25, nodes: 300000, nps: 200000, timeMs: 800,
      }],
    });

    assert.equal(result.classification, 'throws_result');
    assert.equal(result.goalPreserved, false);
    assert.equal(result.centipawnLoss, Infinity); // threw away forced mate
  });

  test('evaluateAttempt with acceptable move → classified acceptable, goal preserved', async () => {
    const db = new BundledEndgameDatabase();
    const winEntry: EndgameEntry = {
      id: 'test-win',
      type: 'KP_vs_K',
      name: 'Test win position',
      fen: '8/7k/8/6K1/8/8/6P1/8 w - - 0 1',
      sideToMove: 'w',
      goal: { kind: 'win', description: 'Promote the pawn.' },
      difficulty: 'intermediate',
    };

    // Use pre-computed analysis for precise control.
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        throw new Error('Should use pre-computed analysis');
      },
      async play(): Promise<PlayResult> { throw new Error('play not called'); },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    const trainer = new EndgameTrainer({ database: db, engine });
    const result = await trainer.evaluateAttempt({
      entry: winEntry,
      move: 'g2g3',
      analysisBefore: [{
        multipv: 1,
        evaluation: { type: 'cp', value: 300 },
        principalVariation: ['g5g6'],
        depth: 25, selDepth: 27, nodes: 500000, nps: 250000, timeMs: 1000,
      }],
      analysisAfter: [{
        multipv: 1,
        // Opponent's perspective: -250 (opponent is worse)
        evaluation: { type: 'cp', value: -250 },
        principalVariation: ['h7h6'],
        depth: 25, selDepth: 25, nodes: 300000, nps: 200000, timeMs: 800,
      }],
    });

    assert.equal(result.classification, 'acceptable');
    assert.equal(result.goalPreserved, true);
    assert.equal(result.centipawnLoss, 50);
  });

  test('sign/perspective: naïve un-flipped eval would misjudge goal preservation', async () => {
    // This is the critical sign test.  After the learner's move, the engine
    // reports eval from the OPPONENT's perspective.  If we don't negate,
    // we get the wrong sign and misclassify.
    //
    // Scenario: White to move in a winning endgame.  evalBefore = +200cp.
    // Learner plays a reasonable move.  After the move, Black to move.
    // Engine says eval = -150cp from Black's perspective (Black is worse,
    // meaning White is still winning).
    //
    // CORRECT: negate(-150) = +150 from White's perspective.
    //   Loss = 200 - 150 = 50. Goal (win) preserved (eval > 100). → acceptable.
    //
    // WRONG (no flip): evalAfter = -150 from "White's perspective".
    //   Loss = 200 - (-150) = 350. Goal NOT preserved (eval < 100). → throws_result.
    //
    // If the sign handling is wrong, this test fails.

    const db = new BundledEndgameDatabase();
    const winEntry: EndgameEntry = {
      id: 'test-sign',
      type: 'KP_vs_K',
      name: 'Sign test position',
      fen: '8/7k/8/6K1/8/8/6P1/8 w - - 0 1',
      sideToMove: 'w',
      goal: { kind: 'win', description: 'Promote the pawn.' },
      difficulty: 'intermediate',
    };

    // Use pre-computed analysis for precise control.
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        throw new Error('Should use pre-computed analysis');
      },
      async play(): Promise<PlayResult> { throw new Error('play not called'); },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    const trainer = new EndgameTrainer({ database: db, engine });
    const result = await trainer.evaluateAttempt({
      entry: winEntry,
      move: 'g2g3',
      analysisBefore: [{
        multipv: 1,
        evaluation: { type: 'cp', value: 200 },
        principalVariation: ['g5g6'],
        depth: 25, selDepth: 27, nodes: 500000, nps: 250000, timeMs: 1000,
      }],
      analysisAfter: [{
        multipv: 1,
        // Black's perspective: -150cp (Black is worse)
        evaluation: { type: 'cp', value: -150 },
        principalVariation: ['h7h8'],
        depth: 25, selDepth: 25, nodes: 300000, nps: 200000, timeMs: 800,
      }],
    });

    // Correct: negate(-150) = +150, loss = 200 - 150 = 50, goal preserved.
    assert.equal(result.evalAfterMoverPerspective.value, 150, 'evalAfter must be negated to mover perspective');
    assert.equal(result.centipawnLoss, 50, 'cp loss must use the negated eval');
    assert.equal(result.goalPreserved, true, 'with correct sign handling, goal is preserved');
    assert.equal(result.classification, 'acceptable');
    // If sign were wrong: loss = 350, goalPreserved = false, classification = throws_result.
    assert.notEqual(result.classification, 'throws_result', 'naïve un-flipped math would give throws_result — must not happen');
  });

  test('engine solution to mate (K+Q vs K) → mate distance surfaced correctly', async () => {
    const db = new BundledEndgameDatabase();
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 30 seldepth 30 multipv 1 score mate 3 nodes 800000 nps 400000 time 1500 pv g6g7 h8g8 g7g8'],
      bestmove: 'g6g7',
    }));

    const trainer = new EndgameTrainer({ database: db, engine });
    const result = await trainer.nextPosition({ id: 'kq-vs-k-03' });

    assert.equal(result.solution.mateDistance, 3);
    assert.equal(result.solution.eval.type, 'mate');
    assert.equal(result.solution.eval.value, 3);
    assert.equal(result.solution.evalLabel, 'mate in 3');
  });

  test('AI provider omitted → valid results with engine/dataset fields and no LLM text', async () => {
    const db = new BundledEndgameDatabase();
    const engine = createFakeAnalysisProvider((_go, _fen) => ({
      info: ['info depth 25 seldepth 27 multipv 1 score mate 2 nodes 500000 nps 250000 time 1000 pv g6g7'],
      bestmove: 'g6g7',
    }));

    // No AI supplied
    const trainer = new EndgameTrainer({ database: db, engine });

    // Test nextPosition
    const pos = await trainer.nextPosition({ id: 'kq-vs-k-01' });
    assert.equal(pos.entry.id, 'kq-vs-k-01');
    assert.equal(pos.solution.bestMove, 'g6g7');
    assert.equal(pos.narrative, null);
    assert.equal(pos.providerId, null);

    // Test evaluateAttempt
    const eval_result = await trainer.evaluateAttempt({
      entry: KQ_ENTRY,
      move: 'g6g7',
      analysisBefore: [{
        multipv: 1,
        evaluation: { type: 'mate', value: 2 },
        principalVariation: ['g6g7'],
        depth: 25,
        selDepth: 27,
        nodes: 500000,
        nps: 250000,
        timeMs: 1000,
      }],
      analysisAfter: [{
        multipv: 1,
        evaluation: { type: 'mate', value: -1 },
        principalVariation: ['h8h7'],
        depth: 25,
        selDepth: 25,
        nodes: 300000,
        nps: 200000,
        timeMs: 800,
      }],
    });
    assert.equal(eval_result.classification, 'optimal');
    assert.equal(eval_result.coaching, null);
    assert.equal(eval_result.providerId, null);
  });

  test('evaluateAttempt accepts pre-computed analysis and skips engine call', async () => {
    const db = new BundledEndgameDatabase();
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        throw new Error('Engine should not be called when pre-computed analysis is supplied');
      },
      async play(): Promise<PlayResult> { throw new Error('play should not be called'); },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    const trainer = new EndgameTrainer({ database: db, engine });
    const result = await trainer.evaluateAttempt({
      entry: KQ_ENTRY,
      move: 'g6g7',
      analysisBefore: [{
        multipv: 1,
        evaluation: { type: 'mate', value: 2 },
        principalVariation: ['g6g7'],
        depth: 25, selDepth: 27, nodes: 500000, nps: 250000, timeMs: 1000,
      }],
      analysisAfter: [{
        multipv: 1,
        evaluation: { type: 'mate', value: -1 },
        principalVariation: ['h8h7'],
        depth: 25, selDepth: 25, nodes: 300000, nps: 200000, timeMs: 800,
      }],
    });

    assert.equal(result.classification, 'optimal');
    assert.equal(result.goalPreserved, true);
  });

  test('draw goal: move that loses the draw → throws_result', async () => {
    const db = new BundledEndgameDatabase();
    const drawEntry: EndgameEntry = {
      id: 'test-draw',
      type: 'Philidor',
      name: 'Draw test position',
      fen: '8/8/8/8/8/2k5/8/1K1R1r2 w - - 0 1',
      sideToMove: 'w',
      goal: { kind: 'draw', description: 'Hold the draw.' },
      difficulty: 'advanced',
    };

    // Use pre-computed analysis for precise control.
    const engine: AnalysisProvider = {
      async analyze(): Promise<readonly EngineResult[]> {
        throw new Error('Should use pre-computed analysis');
      },
      async play(): Promise<PlayResult> { throw new Error('play not called'); },
      capabilitiesFor(): EngineCapabilities | undefined { return undefined; },
    };

    const trainer = new EndgameTrainer({ database: db, engine });
    const result = await trainer.evaluateAttempt({
      entry: drawEntry,
      move: 'd1c1',
      analysisBefore: [{
        multipv: 1,
        evaluation: { type: 'cp', value: 0 },
        principalVariation: ['d1d2'],
        depth: 25, selDepth: 27, nodes: 500000, nps: 250000, timeMs: 1000,
      }],
      analysisAfter: [{
        multipv: 1,
        // Opponent's perspective: +500 (opponent is winning)
        evaluation: { type: 'cp', value: 500 },
        principalVariation: ['f3f1'],
        depth: 25, selDepth: 25, nodes: 300000, nps: 200000, timeMs: 800,
      }],
    });

    assert.equal(result.classification, 'throws_result');
    assert.equal(result.goalPreserved, false);
    // evalAfter: opponent perspective +500, negated = -500
    assert.equal(result.evalAfterMoverPerspective.value, -500);
  });
});

// ---------------------------------------------------------------------------
// Pure function unit tests
// ---------------------------------------------------------------------------

describe('EndgameTrainer classifyAttempt', () => {
  const cp = (v: number) => ({ type: 'cp' as const, value: v });
  const mate = (v: number) => ({ type: 'mate' as const, value: v });
  const mateGoal = { kind: 'mate' as const, distance: 2 };
  const winGoal = { kind: 'win' as const, description: 'Win' };
  const drawGoal = { kind: 'draw' as const, description: 'Draw' };

  test('mate goal: still mate → optimal', () => {
    const r = classifyAttempt(mateGoal, mate(1), 0, 50);
    assert.equal(r.classification, 'optimal');
    assert.equal(r.goalPreserved, true);
  });

  test('mate goal: no longer mate → throws_result', () => {
    const r = classifyAttempt(mateGoal, cp(0), Infinity, 50);
    assert.equal(r.classification, 'throws_result');
    assert.equal(r.goalPreserved, false);
  });

  test('win goal: still winning → acceptable', () => {
    const r = classifyAttempt(winGoal, cp(250), 50, 50);
    assert.equal(r.classification, 'acceptable');
    assert.equal(r.goalPreserved, true);
  });

  test('win goal: no longer winning → throws_result', () => {
    const r = classifyAttempt(winGoal, cp(50), 250, 50);
    assert.equal(r.classification, 'throws_result');
    assert.equal(r.goalPreserved, false);
  });

  test('draw goal: still drawn → acceptable', () => {
    const r = classifyAttempt(drawGoal, cp(0), 0, 50);
    assert.equal(r.classification, 'optimal');
    assert.equal(r.goalPreserved, true);
  });

  test('draw goal: getting mated → throws_result', () => {
    const r = classifyAttempt(drawGoal, mate(-3), Infinity, 50);
    assert.equal(r.classification, 'throws_result');
    assert.equal(r.goalPreserved, false);
  });
});

// ---------------------------------------------------------------------------
// BundledEndgameDatabase unit tests
// ---------------------------------------------------------------------------

describe('BundledEndgameDatabase', () => {

  test('all entries have valid fields', () => {
    const db = new BundledEndgameDatabase();
    for (const entry of db.all()) {
      assert.ok(entry.id.length > 0, `Empty id`);
      assert.ok(entry.name.length > 0, `Empty name for ${entry.id}`);
      assert.ok(entry.fen.length > 0, `Empty FEN for ${entry.id}`);
      assert.ok(entry.sideToMove === 'w' || entry.sideToMove === 'b', `Invalid sideToMove for ${entry.id}`);
      assert.ok(entry.goal.kind === 'mate' || entry.goal.kind === 'win' || entry.goal.kind === 'draw', `Invalid goal for ${entry.id}`);
    }
  });

  test('all entry FENs are legal positions', () => {
    const db = new BundledEndgameDatabase();
    for (const entry of db.all()) {
      // Should not throw
      const pos = Position.fromFen(entry.fen);
      assert.ok(pos.fen().length > 0, `Invalid FEN for ${entry.id}`);
    }
  });

  test('getById returns the correct entry', () => {
    const db = new BundledEndgameDatabase();
    const entry = db.getById('kq-vs-k-01');
    assert.ok(entry);
    assert.equal(entry!.id, 'kq-vs-k-01');
    assert.equal(entry!.type, 'KQ_vs_K');
  });

  test('getByType returns matching entries', () => {
    const db = new BundledEndgameDatabase();
    const entries = db.getByType('KQ_vs_K');
    assert.ok(entries.length > 0);
    for (const e of entries) {
      assert.equal(e.type, 'KQ_vs_K');
    }
  });

  test('random returns a valid entry', () => {
    const db = new BundledEndgameDatabase();
    const entry = db.random();
    assert.ok(entry);
    assert.ok(entry.id.length > 0);
  });
});

/**
 * The learner was already being mated, and their move made it worse.
 *
 * This is the case M15 increment 5 briefly changed by accident. Mistake Prediction's
 * `assessEvaluation` deliberately puts "already lost" ahead of "walked into mate" — it measures what
 * a *move* cost, and a player being forcibly mated before it lost nothing by it. Routing this feature
 * through that helper flipped this case from `Infinity`/`throws_result` to `0`/`optimal`, which is
 * exactly backwards for an exercise whose whole subject is technique: converting mate-in-2-against-you
 * into mate-in-1-against-you is the failure being graded. Raised in the Qodo review of PR #136.
 */
test('evaluateAttempt: worsening an already-lost mate still throws the result', async () => {
  const db = new BundledEndgameDatabase();
  const engine = createFakeAnalysisProvider((_go, fen) => {
    if (fen === KQ_FEN) {
      // The learner is already being mated in 2.
      return {
        info: ['info depth 25 multipv 1 score mate -2 nodes 500000 nps 250000 time 1000 pv g6g7'],
        bestmove: 'g6g7',
      };
    }
    // After the move the opponent mates in 1; negated, the learner is mated in 1 — worse.
    return {
      info: ['info depth 25 multipv 1 score mate 1 nodes 300000 nps 200000 time 800 pv h8h7'],
      bestmove: 'h8h7',
    };
  });

  const trainer = new EndgameTrainer({ database: db, engine });
  const result = await trainer.evaluateAttempt({ entry: KQ_ENTRY, move: 'g6g7' });

  assert.equal(result.evalAfterMoverPerspective.type, 'mate');
  assert.equal(result.evalAfterMoverPerspective.value, -1, 'the learner is the one being mated');
  assert.equal(result.centipawnLoss, Infinity, 'this feature still publishes Infinity, not 0');
  assert.equal(result.classification, 'throws_result');
  assert.equal(result.goalPreserved, false);
});
