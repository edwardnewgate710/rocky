import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, json } from './support/fake-transport.js';
import {
  applyNavCapabilities,
  NAV_CAPABILITY_MAP,
  routesToRemove,
} from '../src/app/capabilities-nav.js';

class FakeElement {
  readonly route: string;
  removed = false;

  constructor(route: string) {
    this.route = route;
  }

  remove(): void {
    this.removed = true;
  }
}

class FakeDocument {
  readonly elements: FakeElement[];
  constructor(elements: FakeElement[]) {
    this.elements = elements;
  }

  querySelectorAll(selector: string): Element[] {
    const match = selector.match(/nav a\[data-route="([^"]+)"\]/);
    if (!match) return [];
    const route = match[1];
    return this.elements.filter((el) => !el.removed && el.route === route) as unknown as Element[];
  }
}

test('NAV_CAPABILITY_MAP maps every optional nav route to a capability key', () => {
  assert.deepEqual(NAV_CAPABILITY_MAP, {
    courses: 'learning',
    studies: 'studies',
    teams: 'community',
    messages: 'messaging',
  });
});

// ── The decision ────────────────────────────────────────────────────────────
// Tested through the pure function, so the cases that matter never touch the network or the
// module's page-lifetime memo.

test('a capability reported false removes exactly that route', () => {
  const removals = routesToRemove({
    learning: false,
    studies: true,
    achievements: false,
    search: true,
    social: true,
    messaging: true,
    community: false,
  });
  assert.deepEqual([...removals].sort(), ['courses', 'teams']);
});

/**
 * The failure this guards: a 200 carrying `{"capabilities": {}}` reads as "every capability is
 * off" under a truthiness check and strips the entire optional nav. Found in the review of PR #102.
 * An unanswered question must not cost the visitor a link.
 */
test('a payload that does not positively say "false" removes nothing', () => {
  for (const payload of [
    {},                                   // 200 with an empty flags object
    null,                                 // request failed or rejected
    undefined,                            // 200 whose body has no `capabilities` key
    'nope',                               // not an object at all
    { learning: undefined, community: null },
    { learning: 'false', community: 0 },  // falsey, but not the boolean `false`
  ]) {
    assert.deepEqual(
      routesToRemove(payload),
      [],
      `removed a link for payload ${JSON.stringify(payload)}`,
    );
  }
});

test('only the routes the map knows about are ever removed', () => {
  assert.deepEqual(routesToRemove({ tournaments: false, profile: false, lobby: false }), []);
});

// ── The application ─────────────────────────────────────────────────────────

test('the false capabilities lose their links and the true ones keep them', async () => {
  const transport = new FakeTransport(() =>
    json(200, {
      capabilities: {
        learning: false,
        studies: true,
        achievements: false,
        search: true,
        social: true,
        messaging: true,
        community: false,
      },
    }),
  );
  const coursesLink = new FakeElement('courses');
  const studiesLink = new FakeElement('studies');
  const teamsLink = new FakeElement('teams');
  const messagesLink = new FakeElement('messages');
  const doc = new FakeDocument([coursesLink, studiesLink, teamsLink, messagesLink]);
  const api = new GambitClient({ baseUrl: 'https://api.test', transport });

  await applyNavCapabilities(doc as unknown as Document, api);

  assert.equal(coursesLink.removed, true);
  assert.equal(teamsLink.removed, true);
  assert.equal(studiesLink.removed, false);
  assert.equal(messagesLink.removed, false);

  /**
   * `main.ts` re-runs `bootstrap(document)` on every SPA navigation and every `popstate`, so this
   * is called once per in-app click, not once per page load. Asking again each time would be a
   * request per navigation for an answer that cannot have changed. Asserted in the same test as the
   * first call because the memo lives for the page's lifetime and there is deliberately no reset
   * export — production code does not grow a seam so a test can rewind it.
   */
  const requestsAfterFirstRun = transport.calls.length;
  await applyNavCapabilities(new FakeDocument([new FakeElement('courses')]) as unknown as Document, api);
  assert.equal(transport.calls.length, requestsAfterFirstRun, 'capabilities must be fetched once per page');
});
