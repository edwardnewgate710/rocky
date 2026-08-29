import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCapabilities,
  compareVersions,
  computeFingerprint,
  negotiateVersion,
  parseOptionLine,
  EngineVersionError,
  type UciOptionSpec,
} from '../src/index.js';

function specs(lines: string[]): UciOptionSpec[] {
  return lines.map((l) => parseOptionLine(l)).filter((s): s is UciOptionSpec => s !== null);
}

test('discovers capabilities from advertised options', () => {
  const caps = buildCapabilities('Stockfish 16', 'the devs', specs([
    'option name Threads type spin default 1 min 1 max 512',
    'option name Hash type spin default 16 min 1 max 1024',
    'option name MultiPV type spin default 1 min 1 max 256',
    'option name UCI_LimitStrength type check default false',
    'option name Skill Level type spin default 20 min 0 max 20',
    'option name UCI_Chess960 type check default false',
  ]));
  assert.equal(caps.version, '16');
  assert.equal(caps.supportsMultiPv, true);
  assert.equal(caps.supportsLimitStrength, true);
  assert.equal(caps.supportsSkillLevel, true);
  assert.equal(caps.maxThreads, 512);
  assert.equal(caps.maxHashMb, 1024);
  assert.ok(caps.variants.has('chess'));
  assert.ok(caps.variants.has('chess960'));
});

test('discovers variants from a UCI_Variant combo', () => {
  const caps = buildCapabilities('Fairy-Stockfish 14', 'fairy', specs([
    'option name UCI_Variant type combo default chess var chess var crazyhouse var atomic var kingofthehill',
  ]));
  assert.ok(caps.variants.has('crazyhouse'));
  assert.ok(caps.variants.has('kingofthehill'));
});

test('fingerprint is stable and version-sensitive', () => {
  const a = computeFingerprint('Stockfish 16', '16', ['Hash', 'Threads']);
  const b = computeFingerprint('Stockfish 16', '16', ['Threads', 'Hash']);
  const c = computeFingerprint('Stockfish 17', '17', ['Threads', 'Hash']);
  assert.equal(a, b, 'option order must not change the fingerprint');
  assert.notEqual(a, c, 'a different build must change the fingerprint');
});

test('fingerprint changes when an advertised option contract changes', () => {
  const first = buildCapabilities(
    'Stockfish 16',
    'the devs',
    specs(['option name EvalFile type string default nn-a.nnue']),
  );
  const second = buildCapabilities(
    'Stockfish 16',
    'the devs',
    specs(['option name EvalFile type string default nn-b.nnue']),
  );

  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('capability fingerprint is stable across semantically irrelevant option ordering', () => {
  const first = buildCapabilities(
    'Fairy-Stockfish 14',
    'fairy',
    specs([
      'option name Hash type spin default 16 min 1 max 1024',
      'option name UCI_Variant type combo default chess var chess var atomic var crazyhouse',
    ]),
  );
  const second = buildCapabilities(
    'Fairy-Stockfish 14',
    'fairy',
    specs([
      'option name UCI_Variant type combo default chess var crazyhouse var atomic var chess',
      'option name Hash type spin default 16 min 1 max 1024',
    ]),
  );

  assert.equal(first.fingerprint, second.fingerprint);
});

test('compareVersions orders correctly', () => {
  assert.equal(compareVersions('16', '15'), 1);
  assert.equal(compareVersions('16.1', '16.1'), 0);
  assert.equal(compareVersions('14', '16'), -1);
});

test('negotiateVersion enforces the floor but tolerates unknown', () => {
  const below = buildCapabilities('Stockfish 14', 'x', []);
  assert.throws(() => negotiateVersion(below, '15'), EngineVersionError);
  const unknown = buildCapabilities('MysteryEngine', 'x', []);
  assert.doesNotThrow(() => negotiateVersion(unknown, '15'));
});
