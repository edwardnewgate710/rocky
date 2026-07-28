import test from 'node:test';
import * as assert from 'node:assert/strict';
import { parseNaturalQuery, NATURAL_VOCABULARY, NATURAL_STOP_WORDS } from '../src/natural';

test('parseNaturalQuery: full promotion of vocabulary words and dropping of stop words', () => {
  const result = parseNaturalQuery('blitz games');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'speed', value: 'blitz', negated: false },
      { field: 'type', value: 'game', negated: false },
    ],
  });
});

test('parseNaturalQuery: type vocabulary promotion for games and matches', () => {
  const gamesResult = parseNaturalQuery('blitz games');
  assert.deepEqual(gamesResult.filters, [
    { field: 'speed', value: 'blitz', negated: false },
    { field: 'type', value: 'game', negated: false },
  ]);

  const matchesResult = parseNaturalQuery('rapid matches');
  assert.deepEqual(matchesResult.filters, [
    { field: 'speed', value: 'rapid', negated: false },
    { field: 'type', value: 'game', negated: false },
  ]);
});

test('parseNaturalQuery: player and tournament entity type promotion', () => {
  const playerResult = parseNaturalQuery('players user');
  assert.deepEqual(playerResult.filters, [{ field: 'type', value: 'player', negated: false }]);

  const tournamentResult = parseNaturalQuery('tournaments');
  assert.deepEqual(tournamentResult.filters, [{ field: 'type', value: 'tournament', negated: false }]);
});

test('parseNaturalQuery: explicit syntax preserved and mixed with natural vocabulary', () => {
  const result = parseNaturalQuery('white:magnus "kings gambit" rapid');
  assert.deepEqual(result, {
    terms: [],
    phrases: ['kings gambit'],
    filters: [
      { field: 'white', value: 'magnus', negated: false },
      { field: 'speed', value: 'rapid', negated: false },
    ],
  });
});

test('parseNaturalQuery: unrecognized terms kept', () => {
  const result = parseNaturalQuery('sicilian defense magnus');
  assert.deepEqual(result, {
    terms: ['sicilian', 'defense', 'magnus'],
    phrases: [],
    filters: [],
  });
});

test('parseNaturalQuery: case-insensitive promotion', () => {
  const result = parseNaturalQuery('BLITZ DREW');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'speed', value: 'blitz', negated: false },
      { field: 'result', value: '1/2-1/2', negated: false },
    ],
  });
});

test('parseNaturalQuery: draw synonyms map to canonical result value', () => {
  const drawResult = parseNaturalQuery('drew');
  assert.deepEqual(drawResult.filters, [{ field: 'result', value: '1/2-1/2', negated: false }]);

  const tieResult = parseNaturalQuery('tied');
  assert.deepEqual(tieResult.filters, [{ field: 'result', value: '1/2-1/2', negated: false }]);
});

test('parseNaturalQuery: filter deduplication preserving first occurrence', () => {
  const result = parseNaturalQuery('blitz blitz draw drew');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'speed', value: 'blitz', negated: false },
      { field: 'result', value: '1/2-1/2', negated: false },
    ],
  });
});

test('parseNaturalQuery: negated explicit filter preserved alongside promoted filter', () => {
  const result = parseNaturalQuery('-speed:bullet blitz');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [
      { field: 'speed', value: 'bullet', negated: true },
      { field: 'speed', value: 'blitz', negated: false },
    ],
  });
});

test('parseNaturalQuery: show me all games promotes type: game', () => {
  const result = parseNaturalQuery('show me all games');
  assert.deepEqual(result, {
    terms: [],
    phrases: [],
    filters: [{ field: 'type', value: 'game', negated: false }],
  });
});

test('parseNaturalQuery: empty input and stop-words-only input return empty structures', () => {
  assert.deepEqual(parseNaturalQuery(''), { terms: [], phrases: [], filters: [] });
  assert.deepEqual(parseNaturalQuery('show me all'), { terms: [], phrases: [], filters: [] });
});

test('Exported vocabulary sanity', () => {
  assert.deepEqual(NATURAL_VOCABULARY.get('960'), {
    field: 'variant',
    value: 'chess960',
  });
  assert.deepEqual(NATURAL_VOCABULARY.get('blitz'), {
    field: 'speed',
    value: 'blitz',
  });
  assert.deepEqual(NATURAL_VOCABULARY.get('game'), {
    field: 'type',
    value: 'game',
  });
  assert.strictEqual(NATURAL_STOP_WORDS.has('the'), true);
});
