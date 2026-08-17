import test from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '@chess-platform/core';
import { InvalidFenError } from '@chess-platform/engine';
import { VARIANTS } from '../src/domain';
import {
  CoreFenValidator,
  coreFenValidator,
} from '../src/analysis/fen-validator';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('CoreFenValidator: accepts valid standard start position', () => {
  assert.doesNotThrow(() => {
    coreFenValidator.validate(START_FEN, 'standard');
  });
});

test('CoreFenValidator: accepts valid variant positions', () => {
  // Crazyhouse with pocket pieces
  assert.doesNotThrow(() => {
    coreFenValidator.validate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[P] w KQkq - 0 1', 'crazyhouse');
  });

  // Atomic position
  assert.doesNotThrow(() => {
    coreFenValidator.validate('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'atomic');
  });
});

test('CoreFenValidator: rejects structurally invalid FEN strings via structural validator', () => {
  assert.throws(
    () => coreFenValidator.validate('', 'standard'),
    InvalidFenError,
  );

  assert.throws(
    () => coreFenValidator.validate(' ' + START_FEN, 'standard'),
    InvalidFenError,
  );

  assert.throws(
    () => coreFenValidator.validate('x'.repeat(201), 'standard'),
    InvalidFenError,
  );

  assert.throws(
    () => coreFenValidator.validate('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1; rm -rf /', 'standard'),
    InvalidFenError,
  );
});

test('CoreFenValidator: rejects unsupported or unknown variants', () => {
  assert.throws(
    () => coreFenValidator.validate(START_FEN, 'nonexistent_variant'),
    (err: unknown) => {
      assert.ok(err instanceof InvalidFenError);
      assert.ok(err.message.includes('Unsupported or unknown variant'));
      return true;
    },
  );
});

test('CoreFenValidator: rejects rule-illegal FENs without leaking internal stack traces or wording', () => {
  // 9 files in first rank
  const illegalRankFen = 'rnbqkbnr1/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  assert.throws(
    () => coreFenValidator.validate(illegalRankFen, 'standard'),
    (err: unknown) => {
      assert.ok(err instanceof InvalidFenError);
      assert.equal(err.message, 'Invalid FEN position.');
      return true;
    },
  );

  // Missing fields
  const shortFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w';
  assert.throws(
    () => coreFenValidator.validate(shortFen, 'standard'),
    (err: unknown) => {
      assert.ok(err instanceof InvalidFenError);
      return true;
    },
  );
});

/**
 * `parseFen` decodes a FEN; it does not adjudicate one. It accepts an empty board, a lone king and
 * two white kings — none of which is a chess position, and all of which reached the engine before
 * this check existed. Raised in the Qodo review of PR #132, which also showed ADR-0113 claiming a
 * legality guarantee the code did not provide.
 */
test('CoreFenValidator rejects positions with the wrong number of kings', () => {
  const validator = new CoreFenValidator();
  const illegal: readonly (readonly [string, string])[] = [
    ['empty board', '8/8/8/8/8/8/8/8 w - - 0 1'],
    ['no black king', '4K3/8/8/8/8/8/8/8 w - - 0 1'],
    ['no white king', '4k3/8/8/8/8/8/8/8 w - - 0 1'],
    ['two white kings', '4k3/8/8/8/8/8/8/K3K3 w - - 0 1'],
    ['two black kings', 'k3k3/8/8/8/8/8/8/4K3 w - - 0 1'],
  ];
  for (const [label, fen] of illegal) {
    assert.throws(
      () => validator.validate(fen, 'standard'),
      InvalidFenError,
      `"${label}" is not a chess position and must be refused`,
    );
  }
});

/**
 * The counts come from each variant's own starting position, so Horde — which has no white king at
 * all — must still validate. Hardcoding "one king each" would have made an entire variant
 * unanalysable, which is the failure this derivation avoids.
 */
test('CoreFenValidator accepts each variant\'s own starting position, including kingless-white Horde', () => {
  const validator = new CoreFenValidator();
  for (const variant of VARIANTS) {
    const fen = Position.initial(variant).fen();
    assert.doesNotThrow(
      () => validator.validate(fen, variant),
      `${variant} must accept its own initial position`,
    );
  }
});

/** A Horde position with a white king added is not Horde, and must be refused. */
test('CoreFenValidator rejects a Horde position carrying a white king', () => {
  const validator = new CoreFenValidator();
  const withWhiteKing = Position.initial('horde').fen().replace('PPPPPPPP w', 'PPPPPPPK w');
  assert.throws(() => validator.validate(withWhiteKing, 'horde'), InvalidFenError);
});
