import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchController } from '../src/app/search-controller.js';
import type { SearchRow } from '../src/app/search-results.js';
import type { SearchResults } from '../src/api/models.js';

/**
 * A client whose per-entity reads throw if touched.
 *
 * This is the assertion that pins ADR-0094. Before it, a page of ten hits cost up to twelve
 * requests — one search, up to ten `tournaments.byId` / `games.byId`, and one batched
 * `resolvePlayers` — and the list only painted once every one of them settled. Asserting on the
 * rendered text cannot see that; a client that explodes on contact can.
 */
function makeClient(results: SearchResults) {
  let searches = 0;
  const forbidden = (name: string) => (): never => {
    throw new Error(`${name} must not be called: hits carry their own display metadata`);
  };
  const client = {
    search: {
      query: async () => {
        searches += 1;
        return results;
      },
    },
    tournaments: { byId: forbidden('tournaments.byId') },
    games: { byId: forbidden('games.byId') },
    graphql: { resolvePlayers: forbidden('graphql.resolvePlayers') },
  };
  return { client, searchCount: (): number => searches };
}

function run(results: SearchResults) {
  const { client, searchCount } = makeClient(results);
  const rows: SearchRow[] = [];
  const errors: string[] = [];
  const controller = new SearchController({
    client: client as never,
    callbacks: {
      onResults: (hits) => { rows.push(...hits); },
      onLoading: () => {},
      onError: (m) => { errors.push(m); },
    },
  });
  return { controller, rows, errors, searchCount };
}

test('a page of results costs exactly one request', async () => {
  const { controller, rows, errors, searchCount } = run({
    total: 3,
    results: [
      { id: 'player:p1', score: 0.9, display: { type: 'player', title: 'MagnusC', subtitle: 'NO' } },
      {
        id: 'game:g1',
        score: 0.8,
        display: { type: 'game', title: 'Kasparov vs DeepBlue', subtitle: 'Standard · Blitz · 1-0' },
      },
      {
        id: 'tournament:t1',
        score: 0.7,
        display: { type: 'tournament', title: 'Summer Arena', subtitle: 'Arena · Running' },
      },
    ],
  });

  await controller.search('magnus');

  assert.deepEqual(errors, [], 'no per-result fetch should have been attempted');
  assert.equal(searchCount(), 1);
  assert.deepEqual(
    rows.map((r) => [r.label, r.subtitle, r.href]),
    [
      // A profile is addressed by handle, and for a player document the title is the handle.
      ['MagnusC', 'NO', '/profile/MagnusC'],
      ['Kasparov vs DeepBlue', 'Standard · Blitz · 1-0', '/game/g1'],
      ['Summer Arena', 'Arena · Running', '/tournaments/t1'],
    ],
  );
});

test('a hit indexed before display metadata existed still renders, without a link', async () => {
  // `display` is optional in the contract precisely so an older document still matches and is still
  // returned. Dropping the row would hide a real result; linking it would guess an id it cannot
  // resolve. It degrades to a labelled, linkless row — the same posture the old hydration took when
  // a per-result fetch failed, minus the fetch.
  const { controller, rows, errors } = run({
    total: 1,
    results: [{ id: 'game:0123456789abcdef', score: 0.5 }],
  });

  await controller.search('anything');

  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.label, '01234567…');
  assert.equal(rows[0]?.href, undefined);
  assert.equal(rows[0]?.type, 'game', 'the namespaced id still identifies the kind');
});
