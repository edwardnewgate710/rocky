import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeToPath } from '../src/app/router.js';

test('parseRoute handles /tournaments', () => {
  const r = parseRoute('/tournaments');
  assert.deepEqual(r, { name: 'tournaments' });
  assert.equal(routeToPath(r), '/tournaments');
});

test('parseRoute handles /tournaments/:id', () => {
  const r = parseRoute('/tournaments/t-12345');
  assert.deepEqual(r, { name: 'tournament', id: 't-12345' });
  assert.equal(routeToPath(r), '/tournaments/t-12345');
});

test('parseRoute preserves existing routes', () => {
  const lobby = parseRoute('/');
  assert.deepEqual(lobby, { name: 'lobby' });
  assert.equal(routeToPath(lobby), '/');

  const game = parseRoute('/game/g-999');
  assert.deepEqual(game, { name: 'game', gameId: 'g-999' });
  assert.equal(routeToPath(game), '/game/g-999');

  const profile = parseRoute('/profile/alice');
  assert.deepEqual(profile, { name: 'profile', handle: 'alice' });
  assert.equal(routeToPath(profile), '/profile/alice');

  const notFound = parseRoute('/unrelated-path');
  assert.deepEqual(notFound, { name: 'not-found' });
  assert.equal(routeToPath(notFound), '/not-found');
});

test('parseRoute decodes a percent-encoded tournament id', () => {
  // The list link encodes the id and the API client encodes it again on the way out, so a segment
  // left encoded here would be sent double-encoded and resolve to nothing. Today's ids are UUIDs,
  // which `encodeURIComponent` leaves untouched — this keeps the round trip correct for ids that
  // would not survive it.
  const route = parseRoute(`/tournaments/${encodeURIComponent('a b/c')}`);
  assert.deepEqual(route, { name: 'tournament', id: 'a b/c' });
});

test('parseRoute keeps a malformed escape rather than throwing', () => {
  // `decodeURIComponent('%zz')` throws, and a router that throws renders a blank page. A hand-typed
  // URL can easily contain one, so the raw segment is the better answer: it simply matches nothing.
  const route = parseRoute('/tournaments/%zz');
  assert.deepEqual(route, { name: 'tournament', id: '%zz' });
});
