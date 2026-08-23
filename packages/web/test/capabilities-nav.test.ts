import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GambitClient } from '../src/api/client.js';
import { FakeTransport, json } from './support/fake-transport.js';
import {
  applyNavCapabilities,
  NAV_CAPABILITY_MAP,
  routesToRemove,
  analysisEnabled,
  analysisSupportsVariant,
  applySearchCapability,
  searchEnabled,
  semanticSearchEnabled,
} from '../src/app/capabilities-nav.js';

class FakeElement {
  readonly route: string;
  removed = false;
  /** The header search form ships hidden and is revealed by capability, unlike the nav links. */
  hidden = true;

  constructor(route: string) {
    this.route = route;
  }

  remove(): void {
    this.removed = true;
  }
}

class FakeDocument {
  readonly elements: FakeElement[];
  readonly searchForm: FakeElement | null;
  constructor(elements: FakeElement[], searchForm: FakeElement | null = null) {
    this.elements = elements;
    this.searchForm = searchForm;
  }

  getElementById(id: string): FakeElement | null {
    return id === 'search-form' ? this.searchForm : null;
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
    endgames: 'endgameTrainer',
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
  const searchForm = new FakeElement('search-form');
  const doc = new FakeDocument([coursesLink, studiesLink, teamsLink, messagesLink], searchForm);
  const api = new GambitClient({ baseUrl: 'https://api.test', transport });

  await applyNavCapabilities(doc as unknown as Document, api);

  assert.equal(coursesLink.removed, true);
  assert.equal(teamsLink.removed, true);
  // The header form is gated by the same pass and the same payload. Asserted here rather than in
  // its own test because the fetch is memoised for the process, so this is the only place a real
  // `applyNavCapabilities` call has an answer of its own; the decision itself is covered purely
  // below. Without this the two halves could be wired to nothing and every other test would pass.
  assert.equal(searchForm.hidden, false, 'this payload reports search: true');
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

/**
 * The analysis panel's gate, tested as a pure decision.
 *
 * It cannot be tested through the mount: `loadCapabilities` memoises for the page's lifetime with
 * deliberately no reset seam (see the note in the fetch-once test above), so a second test in the
 * same process cannot vary the answer. Same reason `routesToRemove` is a pure export.
 *
 * The default is the opposite of the nav's on purpose. `routesToRemove` removes a link only on an
 * explicit `false`, because guessing wrong there costs the visitor a link that works. Here guessing
 * wrong offers a button whose every request answers 503, so only an explicit `true` will do.
 */
test('analysisEnabled requires an explicit true', () => {
  assert.equal(analysisEnabled({ capabilities: { analysis: true } }), true);

  for (const payload of [
    { capabilities: { analysis: false } },
    { capabilities: { analysis: 'true' } },
    { capabilities: { analysis: 1 } },
    { capabilities: { analysis: null } },
    { capabilities: {} },
    { capabilities: { learning: true } },
    // The flags object missing entirely, which is what a pre-capabilities response looks like.
    {},
    { capabilities: null },
    null,
    undefined,
    'analysis',
    42,
  ]) {
    assert.equal(
      analysisEnabled(payload),
      false,
      `${JSON.stringify(payload)} is not an explicit true and must not enable the panel`,
    );
  }
});

/**
 * The per-variant gate, tested pure for the same reason `analysisEnabled` is: `loadCapabilities`
 * memoises for the page with deliberately no reset seam.
 *
 * This exists because the deployment-wide flag is not the question that decides whether to offer
 * the control on a given game. ADR-0113 registers only engines whose binary is configured, so an
 * image carrying Stockfish alone reports `analysis: true` and answers 422 for six of the eight
 * variants. Raised in the Qodo review of PR #133.
 */
test('analysisSupportsVariant gates on the advertised list, not the flag alone', () => {
  const stockfishOnly = { capabilities: { analysis: true }, analysisVariants: ['standard', 'chess960'] };

  assert.equal(analysisSupportsVariant(stockfishOnly, 'standard'), true);
  assert.equal(analysisSupportsVariant(stockfishOnly, 'chess960'), true);
  for (const variant of ['atomic', 'crazyhouse', 'kingofthehill', 'threecheck', 'horde', 'racingkings']) {
    assert.equal(
      analysisSupportsVariant(stockfishOnly, variant),
      false,
      `${variant} has no engine in a Stockfish-only deployment and must not be offered`,
    );
  }

  // An empty list means the deployment analyses nothing, which is what `analysis: false` produces.
  assert.equal(
    analysisSupportsVariant({ capabilities: { analysis: true }, analysisVariants: [] }, 'standard'),
    false,
  );
  // The feature being off outranks any list.
  assert.equal(
    analysisSupportsVariant(
      { capabilities: { analysis: false }, analysisVariants: ['standard'] },
      'standard',
    ),
    false,
  );
  // No variant known yet — nothing to offer against.
  assert.equal(analysisSupportsVariant(stockfishOnly, null), false);
});

/**
 * A server predating the field omits it. Reading that as "nothing supported" would silently remove
 * a working feature from every variant, so a missing list fails *open* and the request-time
 * rejection stays the backstop — the opposite direction from the flag itself, deliberately.
 */
test('analysisSupportsVariant fails open when the list is absent but the flag is on', () => {
  assert.equal(analysisSupportsVariant({ capabilities: { analysis: true } }, 'atomic'), true);
  assert.equal(
    analysisSupportsVariant({ capabilities: { analysis: true }, analysisVariants: 'nope' }, 'atomic'),
    true,
  );
  // But an absent list cannot resurrect a disabled feature.
  assert.equal(analysisSupportsVariant({ capabilities: { analysis: false } }, 'standard'), false);
});

/**
 * The three states `GET /v1/search` can be in, as the client must read them (ADR-0132 §5).
 *
 * `search` is the authoritative gate for the whole surface: `SEARCH_ENABLED=0` — the chart's
 * `search.enabled: false` — removes the repository and every mode answers 503, keyword included.
 * `semanticSearch` gates the two extra modes *on top of* it, so it is never enough on its own.
 */
test('searchEnabled and semanticSearchEnabled read the two flags as a hierarchy', () => {
  const caps = (c: Record<string, unknown>): unknown => ({ capabilities: c });

  // Search off: nothing is available, whatever else the payload claims. The composition root never
  // produces this pairing; the client declines to depend on that.
  assert.equal(searchEnabled(caps({ search: false, semanticSearch: true })), false);
  assert.equal(
    semanticSearchEnabled(caps({ search: false, semanticSearch: true })),
    false,
    'semantic modes cannot outlive the repository they are built beside',
  );

  // Keyword only: the shape `search.semanticEnabled: false` publishes.
  assert.equal(searchEnabled(caps({ search: true, semanticSearch: false })), true);
  assert.equal(semanticSearchEnabled(caps({ search: true, semanticSearch: false })), false);

  // Both.
  assert.equal(searchEnabled(caps({ search: true, semanticSearch: true })), true);
  assert.equal(semanticSearchEnabled(caps({ search: true, semanticSearch: true })), true);

  // A server predating `semanticSearch` still serves keyword.
  assert.equal(searchEnabled(caps({ search: true })), true);
  assert.equal(semanticSearchEnabled(caps({ search: true })), false);
});

/** "Not answered" in all its shapes, for both predicates. */
test('both search predicates fail closed on anything that is not an explicit true', () => {
  for (const payload of [
    null,
    undefined,
    {},
    { capabilities: {} },
    'capabilities',
    { capabilities: { search: 'true', semanticSearch: 'true' } },
    { capabilities: { search: 1, semanticSearch: 1 } },
    { capabilities: null },
  ]) {
    const where = JSON.stringify(payload) ?? 'undefined';
    assert.equal(searchEnabled(payload), false, `searchEnabled(${where})`);
    assert.equal(semanticSearchEnabled(payload), false, `semanticSearchEnabled(${where})`);
  }
});

/**
 * The header search form is revealed by capability, and ships hidden.
 *
 * This is the entry point the first version of ADR-0132 missed: a `<form>` in the nav, not an
 * `a[data-route]`, so {@link routesToRemove} cannot reach it — and it sits on every page. Gating the
 * `/search` mount while leaving this active was the one-level-away partial fix.
 *
 * Revealed rather than removed, the opposite default from the nav links, because a control shown
 * and then withdrawn may already have been used, and submitting this one navigates.
 *
 * Tested through the pure function for the reason the file has been doing that throughout: the
 * fetch is memoised for the process, so the cases that matter cannot each have their own answer.
 */
test('the header search form is revealed only by an explicit search capability', () => {
  const form = new FakeElement('search-form');
  assert.equal(form.hidden, true, 'it must ship hidden, or there is a window in which to click it');

  const doc = (): Document => new FakeDocument([], form) as unknown as Document;

  applySearchCapability(doc(), { capabilities: { search: true, semanticSearch: false } });
  assert.equal(form.hidden, false, 'keyword-only is still search');

  applySearchCapability(doc(), { capabilities: { search: false, semanticSearch: true } });
  assert.equal(
    form.hidden,
    true,
    'a search box on a deployment with search off is an entry point into a disabled feature',
  );

  applySearchCapability(doc(), { capabilities: { search: true, semanticSearch: true } });
  assert.equal(form.hidden, false);
});

/** Every shape of "not answered" leaves it hidden, including an older server and a failed request. */
test('the header search form stays hidden when capabilities do not answer', () => {
  for (const payload of [null, undefined, {}, { capabilities: {} }, { capabilities: { search: 'true' } }]) {
    const form = new FakeElement('search-form');
    form.hidden = false;
    applySearchCapability(new FakeDocument([], form) as unknown as Document, payload);
    assert.equal(form.hidden, true, `payload ${JSON.stringify(payload) ?? 'undefined'}`);
  }
});

/** A page with no such form must not throw — the route mounts on documents that lack the nav. */
test('applySearchCapability tolerates a document without the header form', () => {
  applySearchCapability(new FakeDocument([], null) as unknown as Document, {
    capabilities: { search: true },
  });
});
