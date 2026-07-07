import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeToPath, navigate } from '../src/app/router.js';
import type { Route, HistoryLike } from '../src/app/router.js';

test('parseRoute: root path → lobby', () => {
  assert.deepEqual(parseRoute('/'), { name: 'lobby' });
  assert.deepEqual(parseRoute(''), { name: 'lobby' });
});

test('parseRoute: /game/{id} → game route', () => {
  const r = parseRoute('/game/abc123');
  assert.equal(r.name, 'game');
  if (r.name === 'game') assert.equal(r.gameId, 'abc123');
});

test('parseRoute: /profile → profile with null handle', () => {
  const r = parseRoute('/profile');
  assert.equal(r.name, 'profile');
  if (r.name === 'profile') assert.equal(r.handle, null);
});

test('parseRoute: /profile/{handle} → profile with handle', () => {
  const r = parseRoute('/profile/alice');
  assert.equal(r.name, 'profile');
  if (r.name === 'profile') assert.equal(r.handle, 'alice');
});

test('parseRoute: unknown path → not-found', () => {
  assert.equal(parseRoute('/unknown').name, 'not-found');
  assert.equal(parseRoute('/foo/bar/baz').name, 'not-found');
});

test('routeToPath: lobby → /', () => {
  assert.equal(routeToPath({ name: 'lobby' }), '/');
});

test('routeToPath: game → /game/{id}', () => {
  assert.equal(routeToPath({ name: 'game', gameId: 'g1' }), '/game/g1');
});

test('routeToPath: profile without handle → /profile', () => {
  assert.equal(routeToPath({ name: 'profile', handle: null }), '/profile');
});

test('routeToPath: profile with handle → /profile/{handle}', () => {
  assert.equal(routeToPath({ name: 'profile', handle: 'alice' }), '/profile/alice');
});

test('routeToPath: not-found → /not-found', () => {
  assert.equal(routeToPath({ name: 'not-found' }), '/not-found');
});

test('navigate calls pushState with the correct URL', () => {
  const calls: string[] = [];
  const fakeHistory: HistoryLike = {
    pushState: (data, title, url) => { calls.push(url); },
  };
  navigate({ name: 'game', gameId: 'g42' }, fakeHistory);
  assert.deepEqual(calls, ['/game/g42']);
  navigate({ name: 'lobby' }, fakeHistory);
  assert.deepEqual(calls, ['/game/g42', '/']);
});

test('round-trip: parseRoute(routeToPath(route)) is stable for all route shapes', () => {
  const routes: Route[] = [
    { name: 'lobby' },
    { name: 'game', gameId: 'abc' },
    { name: 'profile', handle: null },
    { name: 'profile', handle: 'bob' },
    { name: 'not-found' },
  ];
  for (const r of routes) {
    const path = routeToPath(r);
    const parsed = parseRoute(path);
    assert.equal(parsed.name, r.name, `round-trip failed for ${r.name} via ${path}`);
  }
});

// C1 regression: navigate with no injected history should use globalThis.history.
test('C1 regression: navigate without injected history uses globalThis.history', () => {
  const calls: string[] = [];
  const original = (globalThis as any).history;
  (globalThis as any).history = {
    pushState: (data: unknown, title: string, url: string) => { calls.push(url); },
  };
  try {
    navigate({ name: 'lobby' });
    assert.deepEqual(calls, ['/']);
  } finally {
    (globalThis as any).history = original;
  }
});
