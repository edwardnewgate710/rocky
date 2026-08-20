import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chapterNameFor, parsePgn } from '../src';

/**
 * Parses a PGN string and returns its first game, asserting one is there.
 *
 * `parsePgn` returns an array, and a text that parses to zero games would otherwise make every
 * assertion below run against `undefined` — which reads as a failure in the assertion rather than
 * in the fixture, and sends you looking in the wrong place.
 */
function firstGame(pgn: string) {
  const [game] = parsePgn(pgn);
  assert.ok(game, 'the fixture must parse to at least one game');
  return game;
}

describe('PGN import', () => {
  it('names a chapter from the players, then the event, then its index', () => {
    assert.equal(chapterNameFor(firstGame('[White "A"]\n[Black "B"]\n\n*\n'), 0), 'A vs B');
    assert.equal(chapterNameFor(firstGame('[Event "Open"]\n\n*\n'), 0), 'Open');
    assert.equal(chapterNameFor(firstGame('*\n'), 4), 'Chapter 5');
  });
});
