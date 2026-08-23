/**
 * The composition root's dependency-parity guarantees (ADR-0131).
 *
 * Most of this file is checked by `tsc`, not by the assertions below. Each `const` in the
 * compile-time section is annotated with a type-level predicate and initialised to the answer that
 * predicate must give; if a guarantee is ever loosened, the predicate flips and the initialiser
 * stops typechecking, so the build fails rather than the guard quietly stopping guarding.
 *
 * They are asserted at runtime as well. That is not redundant with the compile check — it is what
 * makes the failure legible in a test report rather than only in `tsc` output, and it keeps the
 * values from being dead code that a future cleanup deletes without understanding.
 *
 * The two behavioural tests at the end cover what no type can observe: that a bundle carrying a
 * feature actually reaches the router, and that one carrying nothing still degrades to 503.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { OptionalDependencies } from '../src/deps';
import type { ForwardedDeps } from '../src/server';
import type { buildRouter } from '../src/routes';
import { startHarness } from './helpers';

/**
 * `true` exactly when `A` is assignable to `B`.
 *
 * The tuple wrapping stops a union `A` from distributing, which would otherwise answer the question
 * one member at a time and report `boolean` instead of a definite answer.
 */
type IsAssignable<A, B> = [A] extends [B] ? true : false;

/**
 * A production bundle that composes every optional dependency but one must not be a valid bundle.
 *
 * This is the shape `createPgDependencies` had before ADR-0131: the feature is built, the build is
 * clean, and its route answers 503 on a deployment that configured it correctly.
 */
const bundleMissingOneIsRejected: IsAssignable<
  Omit<OptionalDependencies, 'tournamentCommentary'>,
  OptionalDependencies
> = false;

/**
 * The same omission in the forwarding literal — the exact defect Increment 22 shipped, now a type
 * error instead of a 503.
 */
const forwardMissingOneIsRejected: IsAssignable<
  Omit<ForwardedDeps, 'tournamentCommentary'>,
  ForwardedDeps
> = false;

/**
 * A second key, so the guarantee is shown to cover the derived union rather than one name that
 * happens to be spelled somewhere.
 */
const forwardMissingCoachIsRejected: IsAssignable<Omit<ForwardedDeps, 'coach'>, ForwardedDeps> =
  false;

/**
 * `undefined` must remain a legal *value* for an optional forwarded key.
 *
 * Requiring the key while forbidding `undefined` would force every deployment to compose every
 * feature, which is the opposite of what an optional dependency is for — so this half of the
 * contract needs pinning as much as the half above.
 */
const undefinedIsALegalFeatureValue: IsAssignable<undefined, ForwardedDeps['tournamentCommentary']> =
  true;

/**
 * And must stay illegal for a key the server cannot run without, so the relaxation above is
 * confined to the features.
 */
const undefinedIsNotALegalCoreValue: IsAssignable<undefined, ForwardedDeps['repos']> = false;

/**
 * What the router *actually* accepts — read off `buildRouter` rather than named.
 *
 * Naming `RouteDeps` here was the second version of this test, and the CodeRabbit review of PR #154
 * showed it still asserted one level away from the contract: widen `buildRouter`'s parameter so the
 * feature keys become omissible again, leave `RouteDeps` untouched, and every predicate below still
 * passes while the guard is gone. That was verified, not assumed — the mutation survived a full run.
 *
 * `Parameters<typeof buildRouter>[0]` cannot drift from the function, because it *is* the function's
 * parameter. Changing the signature changes what these assert.
 */
type RouterArgument = Parameters<typeof buildRouter>[0];

/**
 * The guard that matters: the router's own parameter type must reject an argument missing a feature
 * key.
 *
 * The three predicates above are properties of type *aliases*. The adversarial review pointed out
 * what that leaves open — reverting `server.ts` to conditional spreads while leaving the aliases
 * defined would pass all of them — so the requirement lives in `buildRouter`'s signature, where no
 * call site can opt out of it, and this is what pins it there.
 *
 * Deleting `const forwarded: ForwardedDeps`'s annotation and then dropping a key is `TS2345` on the
 * `buildRouter` call, with or without the aliases.
 */
const routerRejectsAMissingFeature: IsAssignable<
  Omit<RouterArgument, 'tournamentCommentary'>,
  RouterArgument
> = false;

/** The same, for a second key, so this is a property of the parameter and not of one name. */
const routerRejectsAMissingCoach: IsAssignable<Omit<RouterArgument, 'coach'>, RouterArgument> = false;

test('the router type rejects an argument missing any feature key', () => {
  assert.equal(routerRejectsAMissingFeature, false);
  assert.equal(routerRejectsAMissingCoach, false);
});

test('an assembly that omits an optional dependency does not typecheck', () => {
  assert.equal(bundleMissingOneIsRejected, false);
  assert.equal(forwardMissingOneIsRejected, false);
  assert.equal(forwardMissingCoachIsRejected, false);
});

test('a named optional dependency may still be undefined; a core one may not', () => {
  assert.equal(undefinedIsALegalFeatureValue, true);
  assert.equal(undefinedIsNotALegalCoreValue, false);
});

test('an optional dependency present in the bundle reaches its route rather than 503', async () => {
  // `search` is used because the harness composes it by default and its route needs no engine, no
  // provider and no fixture. The claim under test is about forwarding, not about search.
  const h = await startHarness();
  try {
    const { token } = await h.makeUser('parityuser');
    const res = await h.json('GET', '/v1/search?q=parity', { token });
    assert.notEqual(
      res.status,
      503,
      'a composed dependency answered "not configured", so the bundle did not reach the router',
    );
  } finally {
    await h.close();
  }
});

test('an optional dependency the deployment did not compose still answers 503', async () => {
  // The other direction, and the reason these keys carry `| undefined` rather than being required
  // values: a bundle that names a key it has nothing for must degrade to 503 rather than crash or
  // pretend the feature exists.
  //
  // `analysis` rather than `coach`: the harness composes `coach` whenever any of the five
  // features it sequences is present, and `openingExploration` is composed unconditionally, so
  // `/v1/coach` answers 200 on a deployment with no engine at all. `analysis` is composed only
  // when the harness is handed one.
  const h = await startHarness();
  try {
    const { token } = await h.makeUser('parityuser2');
    const res = await h.json('POST', '/v1/analysis', {
      token,
      body: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', variant: 'standard' },
    });
    assert.equal(res.status, 503, 'an uncomposed feature must report itself unavailable');
    assert.equal(res.body.error.code, 'service_unavailable');
  } finally {
    await h.close();
  }
});
