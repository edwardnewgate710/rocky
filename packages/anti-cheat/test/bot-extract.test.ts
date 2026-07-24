import test from 'node:test';
import * as assert from 'node:assert/strict';
import { extractTimedMoves, type MoveTiming } from '../src/bot-extract';
import { analyzeBotBehavior, BOT_MIN_SAMPLE_SIZE } from '../src/bot-behavior';

test('alternating split: routes moves by color in order with exact moveTimeMs', () => {
  const moves: MoveTiming[] = [
    { by: 'w', moveTimeMs: 1200 },
    { by: 'b', moveTimeMs: 800 },
    { by: 'w', moveTimeMs: 4500 },
    { by: 'b', moveTimeMs: 1500 },
  ];

  const timings = extractTimedMoves(moves);

  assert.deepEqual(timings.white, [{ ms: 1200 }, { ms: 4500 }]);
  assert.deepEqual(timings.black, [{ ms: 800 }, { ms: 1500 }]);
});

test('ms mapping: TimedMove.ms equals source moveTimeMs without alteration or averaging', () => {
  const moves: MoveTiming[] = [
    { by: 'w', moveTimeMs: 333 },
    { by: 'b', moveTimeMs: 777 },
  ];

  const timings = extractTimedMoves(moves);

  assert.equal(timings.white[0].ms, 333);
  assert.equal(timings.black[0].ms, 777);
  assert.equal(timings.white[0].isBook, undefined);
  assert.equal(timings.black[0].isBook, undefined);
});

test('book marking: isBook predicate marks designated game move indices only', () => {
  const moves: MoveTiming[] = [
    { by: 'w', moveTimeMs: 200 }, // i=0 (book)
    { by: 'b', moveTimeMs: 250 }, // i=1 (book)
    { by: 'w', moveTimeMs: 300 }, // i=2 (book)
    { by: 'b', moveTimeMs: 350 }, // i=3 (book)
    { by: 'w', moveTimeMs: 1000 }, // i=4 (non-book)
    { by: 'b', moveTimeMs: 1200 }, // i=5 (non-book)
  ];

  const isBook = (i: number) => i < 4;
  const timings = extractTimedMoves(moves, isBook);

  assert.deepEqual(timings.white, [
    { ms: 200, isBook: true },
    { ms: 300, isBook: true },
    { ms: 1000 },
  ]);
  assert.deepEqual(timings.black, [
    { ms: 250, isBook: true },
    { ms: 350, isBook: true },
    { ms: 1200 },
  ]);
});

test('empty input: returns empty arrays for white and black', () => {
  const timings = extractTimedMoves([]);

  assert.deepEqual(timings, { white: [], black: [] });
});

test('single-color / uneven input: routes correctly to active side leaving empty side as []', () => {
  const movesOnlyWhite: MoveTiming[] = [
    { by: 'w', moveTimeMs: 100 },
    { by: 'w', moveTimeMs: 200 },
    { by: 'w', moveTimeMs: 300 },
  ];

  const timingsWhiteOnly = extractTimedMoves(movesOnlyWhite);
  assert.deepEqual(timingsWhiteOnly.white, [{ ms: 100 }, { ms: 200 }, { ms: 300 }]);
  assert.deepEqual(timingsWhiteOnly.black, []);

  const unevenMoves: MoveTiming[] = [
    { by: 'w', moveTimeMs: 500 },
    { by: 'b', moveTimeMs: 600 },
    { by: 'w', moveTimeMs: 700 },
  ];

  const timingsUneven = extractTimedMoves(unevenMoves);
  assert.deepEqual(timingsUneven.white, [{ ms: 500 }, { ms: 700 }]);
  assert.deepEqual(timingsUneven.black, [{ ms: 600 }]);
});

test('end-to-end extract -> analyze bridge: extracted bot moves trigger high suspicion in analyzeBotBehavior', () => {
  const moveCount = BOT_MIN_SAMPLE_SIZE + 2;
  const moves: MoveTiming[] = [];

  for (let i = 0; i < moveCount; i++) {
    moves.push({ by: 'w', moveTimeMs: 50 });
    moves.push({ by: 'b', moveTimeMs: 2000 });
  }

  const timings = extractTimedMoves(moves);
  const report = analyzeBotBehavior(timings.white);

  assert.equal(report.lowConfidence, false);
  assert.equal(report.sampleSize, moveCount);
  assert.equal(report.instantFraction, 1.0);
  assert.equal(report.suspicion, 'high');
});
