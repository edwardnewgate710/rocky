import test from 'node:test';
import * as assert from 'node:assert/strict';
import { analyzeGame, ACPL_CAP, MATE_ENCODING, type Player } from '../src/analyzer';
import { InMemoryEvaluator } from '../src/fakes';

// A realistic depth for testing non-low-confidence cases.
const GOOD_DEPTH = 20;

test('high suspicion: perfectly matches #1 move consistently', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  for (let i = 0; i < 25; i++) {
    const fen = `fen-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'a1a2', cp: 50 },
        { uci: 'b1b2', cp: 0 },
        { uci: 'c1c2', cp: -50 },
      ],
    });
    plies.push({ fen, playedUci: 'a1a2', player: 'white' as Player });
  }

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.lowConfidence, false);
  assert.equal(white.t1Rate, 1);
  assert.equal(white.acpl, 0);
  assert.equal(white.suspicion, 'high');
});

test('clean suspicion: weak game with large ACPL', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  for (let i = 0; i < 25; i++) {
    const fen = `fen-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'a1a2', cp: 50 },
        { uci: 'b1b2', cp: 0 },
        { uci: 'c1c2', cp: -50 },
        { uci: 'd1d2', cp: -200 },
      ],
    });
    // Consistently plays a bad move (4th choice).
    plies.push({ fen, playedUci: 'd1d2', player: 'white' as Player });
  }

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.lowConfidence, false);
  assert.equal(white.t1Rate, 0);
  assert.ok(white.acpl > 25);
  assert.equal(white.suspicion, 'clean');
});

test('review suspicion: realistic mixed game', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  for (let i = 0; i < 30; i++) {
    const fen = `fen-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'a1a2', cp: 50 },
        { uci: 'b1b2', cp: 40 },
        { uci: 'c1c2', cp: 30 },
      ],
    });
    // Play #1 60% of the time, #2 40% of the time.
    const playedUci = i < 18 ? 'a1a2' : 'b1b2';
    plies.push({ fen, playedUci, player: 'white' as Player });
  }

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.lowConfidence, false);
  assert.equal(white.t1Rate, 18 / 30); // 60%
  assert.ok(white.acplCapped <= 25); // ACPL is 10 for the 12 misses, average = 120/30 = 4.
  assert.equal(white.suspicion, 'review');
});

test('ACPL math: exact expected value with cap and mate encoding', async () => {
  const evaluator = new InMemoryEvaluator();

  evaluator.set('fen-cap', {
    topMoves: [
      { uci: 'best', cp: 500 },
      { uci: 'blunder', cp: 100 },
    ], // diff is 400 → caps at ACPL_CAP (300)
  });

  evaluator.set('fen-mate', {
    topMoves: [
      { uci: 'best', cp: MATE_ENCODING }, // mate in 1
      { uci: 'blunder', cp: -100 },
    ], // diff is 10100 → caps at ACPL_CAP (300)
  });

  evaluator.set('fen-normal', {
    topMoves: [
      { uci: 'best', cp: 50 },
      { uci: 'ok', cp: 20 },
    ], // diff is 30
  });

  const plies = [
    { fen: 'fen-cap', playedUci: 'blunder', player: 'white' as Player },
    { fen: 'fen-mate', playedUci: 'blunder', player: 'white' as Player },
    { fen: 'fen-normal', playedUci: 'ok', player: 'white' as Player },
  ];

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  const expectedRaw = (400 + (MATE_ENCODING + 100) + 30) / 3;
  const expectedCapped = (ACPL_CAP + ACPL_CAP + 30) / 3;

  assert.equal(white.acpl, expectedRaw);
  assert.equal(white.acplCapped, expectedCapped);
});

test('only-move exclusion: forced recapture does not inflate T1/T3 and increments onlyMoveExcluded', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  // 25 normal plies, played badly (no T1 matches).
  for (let i = 0; i < 25; i++) {
    const fen = `fen-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'best', cp: 50 },
        { uci: 'alt', cp: 0 },
        { uci: 'bad', cp: -100 }, // gap to #2 is 50 (< ONLY_MOVE_GAP)
      ],
    });
    plies.push({ fen, playedUci: 'bad', player: 'white' as Player });
  }

  // 5 only-moves, played perfectly.
  for (let i = 25; i < 30; i++) {
    const fen = `fen-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'only', cp: 500 },
        { uci: 'blunder', cp: 200 }, // gap is 300 (>= ONLY_MOVE_GAP)
      ],
    });
    plies.push({ fen, playedUci: 'only', player: 'white' as Player });
  }

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.onlyMoveExcluded, 5);
  // T1 only considers the 25 normal plies, where the player always played 'bad' (not #1).
  assert.equal(white.t1Rate, 0);
  // ACPL sample size includes all 30 non-book plies.
  assert.equal(white.sampleSize, 30);
});

test('book exclusion: plies flagged isBook are ignored by every metric', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  // 10 book moves that would otherwise be 100% T1.
  for (let i = 0; i < 10; i++) {
    const fen = `fen-book-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'best', cp: 50 },
        { uci: 'alt', cp: 40 },
      ],
    });
    plies.push({ fen, playedUci: 'best', player: 'white' as Player, isBook: true });
  }

  // 20 non-book moves, all off the top move.
  for (let i = 10; i < 30; i++) {
    const fen = `fen-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'best', cp: 50 },
        { uci: 'alt', cp: 40 },
        { uci: 'bad', cp: -50 },
      ],
    });
    plies.push({ fen, playedUci: 'bad', player: 'white' as Player });
  }

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.sampleSize, 20); // the 10 book moves are excluded
  assert.equal(white.t1Rate, 0);
});

test('lowConfidence: tiny sampleSize or low depth sets the flag', async () => {
  const evaluator = new InMemoryEvaluator();

  const setupPlies = (count: number) => {
    const plies = [];
    for (let i = 0; i < count; i++) {
      const fen = `fen-${i}`;
      evaluator.set(fen, {
        topMoves: [
          { uci: 'best', cp: 50 },
          { uci: 'alt', cp: 40 },
        ],
      });
      plies.push({ fen, playedUci: 'best', player: 'white' as Player });
    }
    return plies;
  };

  // Good depth, low sample size (19 < 20).
  let res = await analyzeGame({ plies: setupPlies(19), depth: GOOD_DEPTH, evaluator });
  assert.equal(res.white.lowConfidence, true);
  assert.equal(res.white.suspicion, 'clean'); // low confidence never escalates

  // Low depth (13 < 14), good sample size.
  res = await analyzeGame({ plies: setupPlies(25), depth: 13, evaluator });
  assert.equal(res.white.lowConfidence, true);
  assert.equal(res.white.suspicion, 'clean');
});

test('raw ACPL uses the played move\'s actual eval when it falls outside the top moves', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  // Every ply: best is +50; the played move ('wild') is not in the top list but
  // the evaluator supplies its true eval of -450, a real 500cp loss — far beyond
  // the 300cp cap. Raw ACPL must reflect 500, not a synthesized ACPL_CAP.
  for (let i = 0; i < 25; i++) {
    const fen = `fen-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'best', cp: 50 },
        { uci: 'alt', cp: 20 },
        { uci: 'meh', cp: -10 },
      ],
      playedCp: -450,
    });
    plies.push({ fen, playedUci: 'wild', player: 'white' as Player });
  }

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.acpl, 500); // raw, uncapped — the played move's true loss
  assert.equal(white.acplCapped, ACPL_CAP); // capped for the suspicion math
  assert.equal(white.sampleSize, 25);
  assert.equal(white.t1Rate, 0);
  assert.equal(white.suspicion, 'clean');
});

test('incomplete evaluations are counted as unscored, not scored, and cannot escalate', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  // 30 plies the evaluator cannot score (terminal / incomplete → empty topMoves).
  // None must contribute to ACPL or T1/T3; all land in `unscored`.
  for (let i = 0; i < 30; i++) {
    const fen = `unscored-${i}`;
    // Deliberately not registered → InMemoryEvaluator returns { topMoves: [] }.
    plies.push({ fen, playedUci: 'a1a2', player: 'white' as Player });
  }

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.unscored, 30);
  assert.equal(white.sampleSize, 0);
  assert.equal(white.t1Rate, 0);
  assert.equal(white.lowConfidence, true);
  assert.equal(white.suspicion, 'clean');
});

test('a thin T1 denominator cannot reach high suspicion on its own', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  // 25 forced-only positions (played perfectly) give a healthy ACPL sample but
  // are all excluded from T1/T3. Only 3 non-forced plies remain, all top-1 →
  // t1Rate = 1.0 off a denominator of 3. This must NOT escalate to high/review.
  for (let i = 0; i < 25; i++) {
    const fen = `forced-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'only', cp: 500 },
        { uci: 'blunder', cp: 100 }, // gap 400 ≥ ONLY_MOVE_GAP → excluded
      ],
    });
    plies.push({ fen, playedUci: 'only', player: 'white' as Player });
  }
  for (let i = 0; i < 3; i++) {
    const fen = `open-${i}`;
    evaluator.set(fen, {
      topMoves: [
        { uci: 'best', cp: 50 },
        { uci: 'alt', cp: 40 }, // gap 10 → eligible
      ],
    });
    plies.push({ fen, playedUci: 'best', player: 'white' as Player });
  }

  const { white } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.sampleSize, 28); // healthy ACPL sample
  assert.equal(white.t1Rate, 1); // but off only 3 eligible plies
  assert.equal(white.lowConfidence, true); // thin T-rate denominator
  assert.equal(white.suspicion, 'clean');
});

test('per-player separation: a cheating side is flagged while the human opponent is not', async () => {
  const evaluator = new InMemoryEvaluator();
  const plies = [];

  // White plays the engine's #1 move every time; Black plays a weak 4th choice.
  for (let i = 0; i < 25; i++) {
    const wFen = `w-${i}`;
    const bFen = `b-${i}`;
    evaluator.set(wFen, {
      topMoves: [
        { uci: 'a1a2', cp: 50 },
        { uci: 'b1b2', cp: 0 },
        { uci: 'c1c2', cp: -50 },
      ],
    });
    evaluator.set(bFen, {
      topMoves: [
        { uci: 'a7a6', cp: 50 },
        { uci: 'b7b6', cp: 0 },
        { uci: 'c7c6', cp: -50 },
        { uci: 'd7d6', cp: -250 },
      ],
    });
    plies.push({ fen: wFen, playedUci: 'a1a2', player: 'white' as Player });
    plies.push({ fen: bFen, playedUci: 'd7d6', player: 'black' as Player });
  }

  const { white, black } = await analyzeGame({ plies, depth: GOOD_DEPTH, evaluator });

  assert.equal(white.suspicion, 'high');
  assert.equal(white.t1Rate, 1);
  assert.equal(black.suspicion, 'clean');
  assert.equal(black.t1Rate, 0);
  // The blended game would have hidden White's signal; per-player keeps it.
  assert.ok(black.acpl > white.acpl);
});
