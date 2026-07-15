import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCreateGamePrefs,
  serializeCreateGamePrefs,
  PREFS_STORAGE_KEY,
} from '../src/app/create-game-prefs.js';

test('parse returns null for missing / malformed input', () => {
  assert.equal(parseCreateGamePrefs(null), null);
  assert.equal(parseCreateGamePrefs(''), null);
  assert.equal(parseCreateGamePrefs('not json'), null);
  assert.equal(parseCreateGamePrefs('42'), null);
  assert.equal(parseCreateGamePrefs('null'), null);
});

test('parse accepts a valid preset + mode', () => {
  assert.deepEqual(parseCreateGamePrefs('{"time":"5+3","mode":"rated"}'), {
    time: '5+3',
    mode: 'rated',
  });
});

test('parse rejects an unknown preset id', () => {
  assert.equal(parseCreateGamePrefs('{"time":"7+7","mode":"casual"}'), null);
});

test('parse rejects an invalid mode', () => {
  assert.equal(parseCreateGamePrefs('{"time":"5+0","mode":"ranked"}'), null);
  assert.equal(parseCreateGamePrefs('{"time":"5+0"}'), null);
});

test('parse accepts custom time within limits and rejects out of range', () => {
  assert.deepEqual(parseCreateGamePrefs('{"time":"custom","minutes":7,"increment":4,"mode":"casual"}'), {
    time: 'custom',
    minutes: 7,
    increment: 4,
    mode: 'casual',
  });
  // minutes above the max
  assert.equal(parseCreateGamePrefs('{"time":"custom","minutes":9999,"increment":0,"mode":"casual"}'), null);
  // increment above the max
  assert.equal(parseCreateGamePrefs('{"time":"custom","minutes":5,"increment":999,"mode":"casual"}'), null);
  // missing custom fields
  assert.equal(parseCreateGamePrefs('{"time":"custom","mode":"casual"}'), null);
});

test('serialize round-trips through parse', () => {
  const prefs = { time: 'custom' as const, minutes: 3, increment: 2, mode: 'rated' as const };
  assert.deepEqual(parseCreateGamePrefs(serializeCreateGamePrefs(prefs)), prefs);
});

test('storage key is stable', () => {
  assert.equal(PREFS_STORAGE_KEY, 'gambit-create-game');
});
