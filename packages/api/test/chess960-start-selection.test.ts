import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CHESS960_POSITIONS } from '@chess-platform/core';
import {
  chess960StartSelector,
  cryptoChess960Start,
  fixedChess960Start,
} from '../src/ports/chess960';
import { launchChess960StartId, launchGameId } from '../src/tournament/durable-launcher';
import type { LaunchInput } from '../src/tournament/launcher';

/**
 * The entropy boundary, tested deterministically.
 *
 * There is deliberately no statistical test here. Asserting that 960 buckets fill evenly needs a
 * sample large enough to be slow and a threshold loose enough to be meaningless, and it would fail
 * occasionally for no reason — the classic flaky test. What *is* worth pinning is the translation
 * around the draw: that a valid draw is passed through unchanged, that an invalid one is refused
 * rather than persisted, and that the tournament path does not draw at all. ADR-0137.
 */

test('a valid draw is passed through unchanged, including both ends of the range', () => {
  for (const id of [0, 1, 518, 958, 959]) {
    assert.equal(chess960StartSelector(() => id).next(), id);
  }
});

test('a draw outside the range is refused rather than clamped or wrapped', () => {
  // Refused, not repaired. A clamp would turn a broken source into a silent bias towards 0 or 959,
  // and the value ends up on a `GameCreated` event in an append-only store where "the source was
  // broken that day" is not something anyone can establish afterwards.
  for (const bad of [-1, 960, 1_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => chess960StartSelector(() => bad).next(),
      RangeError,
      `${bad} must be refused`,
    );
  }
});

test('a non-integer draw is refused', () => {
  for (const bad of [3.5, 0.1, 518.999]) {
    assert.throws(() => chess960StartSelector(() => bad).next(), RangeError);
  }
});

test('the guard is on every draw, not just the first', () => {
  // A selector is long-lived and used once per game. Validating at construction would leave every
  // subsequent draw unchecked, which is the interesting case for a source that degrades.
  let n = 0;
  const flaky = chess960StartSelector(() => (n++ === 0 ? 42 : 960));
  assert.equal(flaky.next(), 42);
  assert.throws(() => flaky.next(), RangeError);
});

test('the production selector draws usable ids', () => {
  // Not a distribution test: every draw must simply be an id. Failing this would mean the CSPRNG
  // wiring produces something `chess960Fen` cannot accept, which is a wiring bug, not a statistic.
  for (let i = 0; i < 200; i++) {
    const id = cryptoChess960Start.next();
    assert.ok(Number.isInteger(id) && id >= 0 && id < CHESS960_POSITIONS, `drew ${id}`);
  }
});

test('the fixed selector forces exactly the id it was given', () => {
  const s = fixedChess960Start(700);
  assert.equal(s.next(), 700);
  assert.equal(s.next(), 700, 'and keeps forcing it');
});

test('the fixed selector cannot smuggle an invalid id past the guard', () => {
  // It exists to make a test deterministic, not to reach states production cannot.
  assert.throws(() => fixedChess960Start(960).next(), RangeError);
});

// --- The tournament launcher derives rather than draws -----------------------

const launch = (over: Partial<LaunchInput> = {}): LaunchInput => ({
  tournamentId: 't1',
  matchId: 'm1',
  attempt: 0,
  white: 'w',
  black: 'b',
  variant: 'chess960',
  timeControl: { initialMs: 60_000, incrementMs: 0, delayMs: 0, kind: 'sudden_death' },
  ...over,
});

test('the same pairing derives the same starting position on every replica', () => {
  // This is the property the launcher's whole design rests on. Replicas race to append against a
  // deterministic game id and the losers accept the winner's row; a drawn position would mean they
  // built different events for the same id and one silently returned success for a game it had not
  // agreed on.
  assert.equal(launchChess960StartId(launch()), launchChess960StartId(launch()));
  assert.equal(launchGameId(launch()), launchGameId(launch()));
});

test('a relaunched pairing resumes the same arrangement, and a different pairing gets its own', () => {
  const first = launchChess960StartId(launch());

  // A new attempt is a different game and gets its own position.
  assert.notEqual(
    launchChess960StartId(launch({ attempt: 1 })),
    first,
    'a retried pairing is a different game',
  );
  // Different pairings in the same tournament do not share one.
  assert.notEqual(launchChess960StartId(launch({ matchId: 'm2' })), first);
  assert.notEqual(launchChess960StartId(launch({ tournamentId: 't2' })), first);
});

test('every derived id is a usable starting position', () => {
  // The derivation reduces 128 bits modulo 960; this is the check that the arithmetic lands in range
  // for inputs that vary, rather than only for the one in the test above.
  const seen = new Set<number>();
  for (let i = 0; i < 300; i++) {
    const id = launchChess960StartId(launch({ matchId: `m${i}` }));
    assert.ok(Number.isInteger(id) && id >= 0 && id < CHESS960_POSITIONS, `derived ${id}`);
    seen.add(id);
  }
  // Not a distribution claim — just that the derivation is not a constant, which a mistake such as
  // reading zero bytes would make it.
  assert.ok(seen.size > 1, 'the derivation actually depends on the launch identity');
});
