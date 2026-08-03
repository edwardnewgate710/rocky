import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_LEVELS,
  DEFAULT_BOT_LEVEL,
  parseBotLevel,
} from '../src/app/bot-levels.js';

test('BOT_LEVELS options have unique ids and include default', () => {
  const ids = BOT_LEVELS.map((opt) => opt.id);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, 3);
  assert.equal(uniqueIds.size, 3);
  assert.ok(ids.includes(DEFAULT_BOT_LEVEL));
});

test('parseBotLevel parses valid level ids', () => {
  assert.equal(parseBotLevel('novice'), 'novice');
  assert.equal(parseBotLevel('club'), 'club');
  assert.equal(parseBotLevel('master'), 'master');
});

test('parseBotLevel falls back to default on unknown string or null', () => {
  assert.equal(parseBotLevel('unknown'), DEFAULT_BOT_LEVEL);
  assert.equal(parseBotLevel(''), DEFAULT_BOT_LEVEL);
  assert.equal(parseBotLevel(null), DEFAULT_BOT_LEVEL);
});
