import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, parseSearchHit, parseSearchMode } from '../src/app/search-results.js';

test('parseSearchHit parses game prefix', () => {
  const hit = parseSearchHit({ id: 'game:12345', score: 0.95 });
  assert.equal(hit.type, 'game');
  assert.equal(hit.id, '12345');
  assert.equal(hit.raw, 'game:12345');
  assert.equal(hit.score, 0.95);
});

test('parseSearchHit parses player prefix', () => {
  const hit = parseSearchHit({ id: 'player:67890', score: 0.8 });
  assert.equal(hit.type, 'player');
  assert.equal(hit.id, '67890');
  assert.equal(hit.raw, 'player:67890');
  assert.equal(hit.score, 0.8);
});

test('parseSearchHit parses tournament prefix', () => {
  const hit = parseSearchHit({ id: 'tournament:abcde', score: 0.7 });
  assert.equal(hit.type, 'tournament');
  assert.equal(hit.id, 'abcde');
  assert.equal(hit.raw, 'tournament:abcde');
  assert.equal(hit.score, 0.7);
});

test('parseSearchHit handles unknown prefix', () => {
  const hit = parseSearchHit({ id: 'unknown:123', score: 0.5 });
  assert.equal(hit.type, null);
  assert.equal(hit.id, '123');
  assert.equal(hit.raw, 'unknown:123');
  assert.equal(hit.score, 0.5);
});

test('parseSearchHit handles id with no colon', () => {
  const hit = parseSearchHit({ id: 'nocolonid', score: 0.4 });
  assert.equal(hit.type, null);
  assert.equal(hit.id, 'nocolonid');
  assert.equal(hit.raw, 'nocolonid');
  assert.equal(hit.score, 0.4);
});

test('parseSearchHit splits on the first colon only', () => {
  const hit = parseSearchHit({ id: 'game:uuid:extra:segment', score: 0.9 });
  assert.equal(hit.type, 'game');
  assert.equal(hit.id, 'uuid:extra:segment');
  assert.equal(hit.raw, 'game:uuid:extra:segment');
  assert.equal(hit.score, 0.9);
});

test('parseSearchMode handles valid search modes', () => {
  assert.equal(parseSearchMode('keyword'), 'keyword');
  assert.equal(parseSearchMode('semantic'), 'semantic');
  assert.equal(parseSearchMode('hybrid'), 'hybrid');
});

test('parseSearchMode falls back to keyword for invalid or null input', () => {
  assert.equal(parseSearchMode('invalid'), 'keyword');
  assert.equal(parseSearchMode(null), 'keyword');
  assert.equal(parseSearchMode(''), 'keyword');
});

test('buildSearchUrl omits the default mode and an empty query', () => {
  // `keyword` is the server's own default, so spelling it into the URL would make every shared
  // link carry a parameter the user never chose.
  assert.equal(buildSearchUrl('alice', 'keyword'), '/search?q=alice');
  assert.equal(buildSearchUrl('alice', 'hybrid'), '/search?q=alice&mode=hybrid');
  assert.equal(buildSearchUrl('', 'keyword'), '/search?');
});

test('buildSearchUrl encodes a query that would otherwise break the URL', () => {
  assert.equal(buildSearchUrl('a b&c=d', 'semantic'), '/search?q=a+b%26c%3Dd&mode=semantic');
});
