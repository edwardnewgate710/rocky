/**
 * What `GET /v1/capabilities` promises must match what the routes will do (ADR-0132).
 *
 * ADR-0131 made the *forwarding* of optional dependencies exhaustive at compile time and recorded
 * this file's subject as the remaining gap: a feature never added to `capabilitiesView` is invisible
 * to the capabilities document, and nothing complains. The live instance was semantic search — one
 * published `search` flag standing for three modes served by two independently-gated dependency
 * sets, so a deployment with `search.semanticEnabled: false` advertised search, and the two modes it
 * cannot serve answered 503 to a client that had no way to know.
 *
 * The compile-time half of this file follows the house pattern: each `const` carries a type-level
 * predicate and is initialised to the answer that predicate must give, so loosening a guarantee
 * stops the build rather than quietly stopping guarding. They are asserted at runtime too, which
 * makes the failure legible in a test report and keeps them from being dead code a cleanup deletes.
 *
 * These predicates re-derive the property rather than importing the assertion in `presenters.ts`,
 * which means the property is enforced in two independent places. That is deliberate and is not the
 * same thing as testing that file's assertion: delete the one in `presenters.ts` and this still
 * fails when a dependency goes unclassified. Neither is load-bearing alone.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { OptionalDependencyKey } from '../src/deps';
import {
  HashingEmbeddingProvider,
  InMemorySearchRepository,
  InMemorySemanticSearchRepository,
  SEARCH_EMBEDDING_DIMENSIONS,
} from '@chess-platform/search';
import { capabilitiesView } from '../src/presenters';
import type { NotAPublishedCapability } from '../src/presenters';
import { startHarness } from './helpers';

/** `true` exactly when `A` is assignable to `B`; the tuple stops a union `A` from distributing. */
type IsAssignable<A, B> = [A] extends [B] ? true : false;

/**
 * The capability source set, read off the presenter's own parameter.
 *
 * Naming a type separately would guard the name rather than the code — the mistake ADR-0131 §6a
 * paid for. `Parameters<typeof capabilitiesView>[0]` cannot drift from the function, because it is
 * the function's parameter.
 */
type CapabilitySourceKey = keyof Parameters<typeof capabilitiesView>[0];

/**
 * Every optional dependency is either published as a capability or explicitly declared not to be.
 *
 * Add one and neither, and `Exclude` stops being `never`: this initialiser fails with `TS2322`
 * here, and the matching assertion in `presenters.ts` fails there.
 */
const everyOptionalDependencyIsClassified: IsAssignable<
  Exclude<OptionalDependencyKey, CapabilitySourceKey | NotAPublishedCapability>,
  never
> = true;

/**
 * Semantic search reads *both* of its dependencies, because the route does.
 *
 * A vector repository with no embedding provider cannot answer, so a flag built from either one
 * alone would be the same lie in a narrower window. Dropping one from the presenter's parameter
 * flips this.
 */
const bothSemanticDependenciesAreCapabilitySources: IsAssignable<
  'semanticSearchRepository' | 'embeddingProvider',
  CapabilitySourceKey
> = true;

/** A dependency cannot be published and unpublished at once. */
const noDependencyIsBothPublishedAndNot: IsAssignable<
  Extract<CapabilitySourceKey, NotAPublishedCapability>,
  never
> = true;

/**
 * The classification above is satisfied vacuously if `OptionalDependencyKey` is ever `never`.
 *
 * `Exclude<never, anything>` is `never`, so a broken optional-key derivation in `deps.ts` would make
 * the guard pass while classifying nothing at all — the assertion would still be there, still green,
 * and covering zero keys. This pins the set as populated, with one example from each side of the
 * decision so it also fails if either side empties.
 */
const theClassifiedSetIsNotEmpty: IsAssignable<
  'semanticSearchRepository' | 'graphql',
  OptionalDependencyKey
> = true;

/**
 * A value for every capability source, so each can be taken away one at a time below.
 *
 * The mapped type is the point: a dependency added to the presenter's parameter has no entry here
 * and this stops compiling, so it cannot reach the test below unexamined.
 *
 * The presenter reads all but three of these for presence alone, so those are supplied as bare
 * objects. That is not a mock standing in for behaviour — there is no behaviour to stand in for, and
 * it fails loudly rather than silently if that ever changes: the day `capabilitiesView` calls a
 * method on one, this throws a `TypeError` naming it. `analysis`, `puzzleGeneration`, and
 * `gameReview` do have a method read — `supportsVariant` — so they carry one.
 */
type SourceValues = {
  [K in CapabilitySourceKey]-?: NonNullable<Parameters<typeof capabilitiesView>[0][K]>;
};

function sourceValues(): SourceValues {
  const present = <T>(): T => ({}) as T;
  const variantAware = <T>(): T => ({ supportsVariant: () => true }) as T;
  return {
    learningRepository: present(),
    studiesRepository: present(),
    achievementsRepository: present(),
    searchRepository: new InMemorySearchRepository(),
    semanticSearchRepository: new InMemorySemanticSearchRepository(),
    embeddingProvider: new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS),
    socialGraphRepository: present(),
    messagingRepository: present(),
    communityRepository: present(),
    analysis: variantAware(),
    moveExplanation: present(),
    mistakePrediction: present(),
    puzzleGeneration: variantAware(),
    openingExploration: present(),
    endgameTraining: present(),
    coach: present(),
    studyPartner: present(),
    tournamentCommentary: present(),
    gameReview: variantAware(),
  };
}

/**
 * Every capability source must actually change what is published.
 *
 * This is the assertion the type-level ones cannot make, and the adversarial review of this branch
 * found the hole it fills. `CapabilitySourceKey` reads the presenter's *parameter*, and TypeScript
 * is content for a parameter to carry a key nothing in the body reads — so adding a dependency to
 * `ApiDependencies`, composing it in `bootstrap.ts`, and listing it in the `Pick` while giving it no
 * flag compiled clean and passed every test. Verified by running it. The capability reached
 * production unpublished, which is the exact defect this file exists to prevent, one level up.
 *
 * Removing a key must therefore change the document. A key whose removal changes nothing is a key
 * that publishes nothing.
 *
 * Removal rather than addition, because `semanticSearch` needs *two* dependencies: supplying
 * `embeddingProvider` alone flips no flag and would look like a dead key under the opposite test.
 */
test('every capability source changes what the document publishes', () => {
  const values = sourceValues();
  const full = capabilitiesView(values);

  for (const key of Object.keys(values) as CapabilitySourceKey[]) {
    const without: Record<string, unknown> = { ...values };
    delete without[key];
    assert.notDeepEqual(
      capabilitiesView(without as Parameters<typeof capabilitiesView>[0]),
      full,
      `'${key}' is declared a capability source but removing it publishes the same document, so nothing on the wire describes it`,
    );
  }
});

test('every optional dependency is classified as published or deliberately unpublished', () => {
  assert.equal(everyOptionalDependencyIsClassified, true);
  assert.equal(bothSemanticDependenciesAreCapabilitySources, true);
  assert.equal(noDependencyIsBothPublishedAndNot, true);
  assert.equal(theClassifiedSetIsNotEmpty, true);
});

/**
 * The presenter directly, because the harness composes the two semantic dependencies together and
 * so cannot separate them — while the dependency type can, and the route reads both.
 *
 * A flag built from either one alone would be the same over-promise in a narrower window: a vector
 * repository with no embedding provider has nothing to turn a query into a vector with, and the
 * route answers 503 exactly as if neither were there.
 */
test('semantic search is advertised only when both of its dependencies are present', () => {
  const repository = (): InMemorySemanticSearchRepository => new InMemorySemanticSearchRepository();
  const provider = (): HashingEmbeddingProvider =>
    new HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS);

  assert.equal(
    capabilitiesView({ semanticSearchRepository: repository(), embeddingProvider: provider() })
      .capabilities.semanticSearch,
    true,
  );
  assert.equal(
    capabilitiesView({ semanticSearchRepository: repository() }).capabilities.semanticSearch,
    false,
    'a vector repository with no embedding provider cannot answer a semantic query',
  );
  assert.equal(
    capabilitiesView({ embeddingProvider: provider() }).capabilities.semanticSearch,
    false,
    'an embedding provider with nothing to search cannot either',
  );
});

/**
 * The regression: keyword search on, semantic search off — the shape `search.semanticEnabled: false`
 * produces, and the one the published contract could not describe.
 */
test('a deployment with keyword search but no semantic search says so, and means it', async () => {
  const h = await startHarness({}, { withoutSemanticSearch: true });
  try {
    const caps = await h.json('GET', '/v1/capabilities');
    assert.equal(caps.status, 200);
    assert.equal(caps.body.capabilities.search, true, 'keyword search is composed');
    assert.equal(caps.body.capabilities.semanticSearch, false, 'the semantic modes are not');

    const keyword = await h.json('GET', '/v1/search?q=parity');
    assert.notEqual(keyword.status, 503, 'the mode the flag advertises must answer');

    const semantic = await h.json('GET', '/v1/search?q=parity&mode=semantic');
    assert.equal(semantic.status, 503, 'and the mode it does not advertise must not');
    assert.equal(semantic.body.error.code, 'service_unavailable');

    const hybrid = await h.json('GET', '/v1/search?q=parity&mode=hybrid');
    assert.equal(hybrid.status, 503, 'hybrid needs the same two dependencies as semantic');
  } finally {
    await h.close();
  }
});

/** The other direction, so the flag is not simply always false. */
test('a deployment with semantic search composed advertises it and serves the mode', async () => {
  const h = await startHarness();
  try {
    const caps = await h.json('GET', '/v1/capabilities');
    assert.equal(caps.body.capabilities.semanticSearch, true);

    const semantic = await h.json('GET', '/v1/search?q=parity&mode=semantic');
    assert.notEqual(
      semantic.status,
      503,
      'an advertised mode answered "not configured", so the flag over-promised',
    );
  } finally {
    await h.close();
  }
});
