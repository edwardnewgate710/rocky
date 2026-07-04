import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInfoLine,
  parseBestMove,
  parseIdLine,
  parseOptionLine,
  buildPositionCommand,
  buildGoCommand,
  buildSetOption,
} from '../src/index.js';

test('parses a centipawn info line with a principal variation', () => {
  const info = parseInfoLine('info depth 20 seldepth 28 multipv 1 score cp 34 nodes 1000000 nps 5000000 time 200 pv e2e4 e7e5 g1f3');
  assert.ok(info);
  assert.equal(info?.depth, 20);
  assert.equal(info?.selDepth, 28);
  assert.equal(info?.multipv, 1);
  assert.equal(info?.scoreCp, 34);
  assert.equal(info?.nodes, 1000000);
  assert.deepEqual(info?.pv, ['e2e4', 'e7e5', 'g1f3']);
});

test('parses a mate score', () => {
  const info = parseInfoLine('info depth 10 score mate -3 pv a1a2');
  assert.equal(info?.scoreMate, -3);
});

test('ignores info string lines', () => {
  assert.equal(parseInfoLine('info string NNUE evaluation using nn-xxx.nnue'), null);
});

test('parses bestmove with and without ponder', () => {
  assert.deepEqual(parseBestMove('bestmove e2e4 ponder e7e5'), { best: 'e2e4', ponder: 'e7e5' });
  assert.deepEqual(parseBestMove('bestmove d2d4'), { best: 'd2d4' });
  assert.deepEqual(parseBestMove('bestmove (none)'), { best: '(none)' });
  assert.equal(parseBestMove('info depth 1'), null);
});

test('parses id lines', () => {
  assert.deepEqual(parseIdLine('id name Stockfish 16.1'), { field: 'name', value: 'Stockfish 16.1' });
  assert.deepEqual(parseIdLine('id author the Stockfish developers'), { field: 'author', value: 'the Stockfish developers' });
});

test('parses spin/check/combo option lines', () => {
  const spin = parseOptionLine('option name Hash type spin default 16 min 1 max 33554432');
  assert.equal(spin?.type, 'spin');
  assert.equal(spin?.min, 1);
  assert.equal(spin?.max, 33554432);

  const check = parseOptionLine('option name UCI_LimitStrength type check default false');
  assert.equal(check?.type, 'check');
  assert.equal(check?.default, 'false');

  const combo = parseOptionLine('option name UCI_Variant type combo default chess var chess var crazyhouse var atomic');
  assert.equal(combo?.type, 'combo');
  assert.deepEqual(combo?.vars, ['chess', 'crazyhouse', 'atomic']);
});

test('builds bounded go commands', () => {
  assert.equal(buildGoCommand({ depth: 20 }), 'go depth 20');
  assert.equal(buildGoCommand({ nodes: 100000 }), 'go nodes 100000');
  assert.equal(buildGoCommand({ timeMs: 500 }), 'go movetime 500');
  assert.equal(buildGoCommand({}), 'go depth 1', 'a bare go must never launch an infinite search');
});

test('builds position and setoption commands', () => {
  assert.equal(buildPositionCommand('FEN'), 'position fen FEN');
  assert.equal(buildPositionCommand('FEN', ['e2e4']), 'position fen FEN moves e2e4');
  assert.equal(buildSetOption('Threads', 4), 'setoption name Threads value 4');
  assert.equal(buildSetOption('Clear Hash'), 'setoption name Clear Hash');
});
