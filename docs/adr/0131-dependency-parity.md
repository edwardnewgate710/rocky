# ADR-0131 — Compile-time dependency parity in the API composition root

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| **Status** | Accepted                                               |
| **Date**   | 2026-08-23                                             |
| **Scope**  | `packages/api`                                         |

---

## Context

`ApiDependencies` (`packages/api/src/deps.ts`) carries twenty-four optional keys: every feature that a
deployment may or may not configure, plus the four observability defaults. Those values flow through
two hand-written object literals before reaching a route:

1. `createPgDependencies` (`bootstrap.ts`) composes each feature and assembles the bundle.
2. `createApiServer` (`server.ts`) copies the bundle into `buildRouter`, whose parameter type is
   `RouteDeps` (`routes.ts`).

Because every one of those keys is optional in both types, **omitting one anywhere in that chain
compiles cleanly**. The build passes, the linter passes, the whole suite passes, and the feature
answers 503 from a deployment that configured it correctly.

This is not hypothetical. Increment 22 composed `TournamentCommentaryService` in `bootstrap.ts`,
declared it in both dependency types, wrote the routes, the presenters, the OpenAPI schemas, the
client, the controller, the view and sixty tests — and every call answered 503, because the one line
`tournamentCommentary: deps.tournamentCommentary,` was missing from the forwarding literal in
`server.ts`. Nothing in the toolchain said so. It was found by calling the endpoint.

### The same defect class, twice

`docs/ROADMAP.md` already records this failure mode under a different file:

> **`main.ts`'s controller-disposal list is manual, untested, and silently incomplete when a section
> is added.** … adding a section to `bootstrap` and forgetting to add it there compiles, passes every
> gate, and leaks. Increment 23 shipped exactly that omission for `LearningController` and it was
> caught in PR review, not by a test.

Both are a hand-maintained list running parallel to an authoritative type, where the type system stays
silent because the parallel entries are optional. ADR-0092 closed that one with
`Record<DisposableKey, true>`, keyed off `BootstrappedDisposables`. This ADR applies the same
principle to the two literals above.

## Decisions

### 1. Derive the forwarded key set from the two bundles rather than writing it out

```ts
export type ForwardedKey = Extract<keyof ApiDependencies, keyof RouteDeps>;
export type ForwardedDeps = { [K in ForwardedKey]: ApiDependencies[K] };
```

`Extract` yields a **union alias**, not `keyof ApiDependencies`. A mapped type over a union alias is
non-homomorphic, so TypeScript does not carry the `?` modifier across it: every key becomes required
while its value type still admits `undefined`. `analysis: deps.analysis` therefore still typechecks on
a deployment with no engine — but dropping the line is `TS2741`.

That distinction is the whole mechanism, and it is worth stating plainly because the homomorphic form
`{ [K in keyof ApiDependencies]: ... }` looks equivalent and does nothing: it preserves `?` and every
key stays omissible.

A new optional feature joins `ForwardedKey` the moment it is declared in both types. There is no list
to update, so there is nothing to forget.

### 1a. The requirement lives in `RouteDeps`, not in an annotation at the call site

The first version of this change put the guard in `const forwarded: ForwardedDeps = { ... }`. The
adversarial review of PR #154 pointed out what that leaves open, and it was right: **the annotation is
deletable.** Reverting `server.ts` to conditional spreads while leaving the type aliases defined
passes every test in `dependency-parity.test.ts`, because those tests assert properties of the
aliases rather than of the code that uses them. A guard you can switch off without a word from the
compiler is the same category of defect as the one being fixed.

So every optional feature on `RouteDeps` is now declared `key: T | undefined` rather than `key?: T`:

```ts
readonly tournamentCommentary: TournamentCommentaryService | undefined;
```

The value is exactly as optional either way — a deployment that composed nothing passes `undefined` —
but the **key** is mandatory, so the requirement is in `buildRouter`'s own signature and no call site
can opt out of it. Deleting the `: ForwardedDeps` annotation and then dropping a key is `TS2345` on
the `buildRouter` call, with or without the aliases.

`ForwardedDeps` is kept, because it names the set, gives the tests something to assert against, and
reports a missing key at the literal (where the fix is) rather than at the call (where it is not). It
is no longer what makes the guard work.

This is a **breaking change to an exported type** — see "Breaking changes" below. An earlier draft of
this ADR claimed it was not, on the grounds that only `server.ts` and `tournament/live.ts` consume
`RouteDeps`. That was the wrong question answered confidently: the CodeRabbit review of PR #154
pointed out that `packages/api/src/index.ts:13` does `export * from './routes'` and `package.json`
maps `.` to `dist/index.d.ts`, so `RouteDeps` is public type surface regardless of who imports it
inside the repo.

### 1b. A second assertion covers what an intersection cannot see

`ForwardedKey` is an intersection, so it is blind to a key added to `RouteDeps` **alone** — that key
would never be forwarded and its route would answer 503 for good, with the compiler silent. Also
raised by the adversarial review.

```ts
type ConstructedHere = 'auth' | 'info';

type EveryRouterDependencyIsSuppliable =
  Exclude<keyof RouteDeps, keyof ApiDependencies | ConstructedHere> extends never ? true : never;

export const everyRouterDependencyIsSuppliable: EveryRouterDependencyIsSuppliable = true;
```

Add such a key and `Exclude` stops being `never`, so the initialiser fails with `TS2322`.

The two-name list is the one hand-written thing left in this file, and it is kept rather than derived
because it is **fail-loud**: drop a name from it and the assertion breaks immediately. That is the
property an exclusion list in decision 4 would not have had, which is why one was rejected there and
this one is acceptable here.

### 2. Derive the optional-dependency set for the production bundle the same way

```ts
export type OptionalDependencyKey = {
  [K in keyof ApiDependencies]-?: {} extends Pick<ApiDependencies, K> ? K : never;
}[keyof ApiDependencies];

export type OptionalDependencies = { [K in OptionalDependencyKey]: ApiDependencies[K] };
```

`createPgDependencies` now assembles an `OptionalDependencies` and spreads it into the bundle, so a
feature composed above and forgotten below is a build failure.

`{} extends Pick<T, K>` is the optionality test rather than `undefined extends T[K]`, because the
latter would also match a *required* property whose declared type happens to include `undefined`.
There is no such property today; this way there need never be a reason to check.

### 3. Replace the conditional spreads with plain assignments

`bootstrap.ts` previously wrote `...(coach ? { coach } : {})` twenty times, which leaves a key absent
rather than present-and-`undefined`. Those become `coach,`.

Absent and `undefined` are interchangeable here, and this was verified rather than assumed:

- `packages/api/tsconfig.json` does not set `exactOptionalPropertyTypes` (`packages/web` does — noted
  because this pattern would need adjusting if it were ever applied there).
- No code in `packages/api` probes these bundles with `in`, `Object.keys` or `Object.entries`.
- Every consumer asks `!== undefined`, including `capabilitiesView`.
- `server.ts` already materialised explicit `undefined` for every unconfigured feature when it copied
  the bundle into `buildRouter`, so the router has always received this shape.

### 4. The `buildRouter` call spreads first and overrides after

```ts
const router = buildRouter({
  ...forwarded,
  auth,
  info,
  metrics,
  readiness: deps.readiness ?? (() => Promise.resolve()),
});
```

`metrics` and `readiness` are **required** on `RouteDeps` and optional on `ApiDependencies`, so they
follow the spread and the resolved values win over the raw ones `forwarded` carries. Ordering is
load-bearing, and because `RouteDeps` declares both required, the compiler enforces it: moving either
above the spread is `TS2783` plus `TS2322`, not a silent `undefined`.

The alternative was an exclusion list — `Exclude<ForwardedKey, 'metrics' | 'readiness'>` — and it was
rejected because it reintroduces the defect one level up: a wrong entry silently drops a key from the
forwarded set, and an optional key on `RouteDeps` draws no complaint. Spread-then-override needs no
such list.

### 4a. `RouteDeps.tracer` was removed, because mutation testing showed nothing could observe it

The tail above originally carried `tracer` as a third key, on the reasoning that it "defaults to
silent". A mutation that dropped the resolved override and let the raw `deps.tracer` through
**survived**: it compiled, and the whole suite passed.

The survivor was correct. `RouteDeps` declared `tracer?: Tracer` and **no route handler ever read
it** — the only consumers of `RouteDeps` are `buildRouter` and `createLiveTournamentHandler`
(`tournament/live.ts`), and neither touches it. The router's tracing comes from
`router.toListener({ ..., tracer })`, whose `RouterRuntime.tracer` is required and receives the
resolved value. So passing `tracer`, passing `undefined`, or passing nothing were all the same thing.

It is deleted rather than kept with a corrected comment, because a declared-but-unread optional
dependency is a fourth thing that can silently drift — which is the defect this ADR exists to remove.
Deleting it also removes it from `ForwardedKey` automatically: the first build after the deletion
failed with `TS2353` on `tracer: deps.tracer` in the forwarding literal, which is the derivation
working in the direction nobody usually tests.

A route that later wants a tracer re-declares it and gets forwarding for free. Like decision 1a this
narrows an exported type; both are covered under "Breaking changes" below.

### 5. `...deps` was considered and rejected

`buildRouter({ ...deps, auth, info, ... })` would forward everything automatically and need no type at
all. It is rejected because `ApiDependencies` also carries `hasher`, `tokens`, `emailSender` and
`logger`, and handing the password hasher and the token-minting service to every route handler is a
wider blast radius than a 503. The explicit literal is the boundary; the type is what keeps it complete.

### 6. The guarantee is tested, not merely asserted in a comment

`packages/api/test/dependency-parity.test.ts` pins both halves with type-level predicates:

```ts
type IsAssignable<A, B> = [A] extends [B] ? true : false;

const forwardMissingOneIsRejected: IsAssignable<
  Omit<ForwardedDeps, 'tournamentCommentary'>,
  ForwardedDeps
> = false;
```

If a guarantee is loosened the predicate flips to `true` and the initialiser stops typechecking. The
booleans are asserted at runtime too, so a failure is legible in a test report and the values are not
dead code a later cleanup deletes without understanding.

The first draft of this file used `@ts-expect-error` on `const x: T = { ...declaredButNotEmitted }`.
It typechecked and then crashed at runtime with `ReferenceError`, because `declare const` erases while
the spread that consumed it does not. Recorded because the failure is quiet in the type checker and
loud only when the test actually runs — which is the argument for running it.

Two behavioural tests cover what no type can observe: that a composed dependency reaches its route
rather than 503, and that an uncomposed one still degrades to 503. The second was written against
`/v1/coach` first and failed with 200 — `coach` is composed whenever any of the five features it
sequences is present, and `openingExploration` is unconditional, so `/v1/coach` answers on a
deployment with no engine at all. The test was wrong, not the code; it now uses `/v1/analysis`.

### 6a. The predicates read the router's parameter off `buildRouter`, not off `RouteDeps`

Third version of this test, and the third time the same mistake was caught: **the assertion sat one
level away from the thing it was guarding.**

Decision 1a moved the requirement into `buildRouter`'s signature. The tests then asserted on
`RouteDeps` *by name* — which is what that signature happens to say today, and nothing pins the two
together. The CodeRabbit review of PR #154 asked for `Parameters<typeof buildRouter>[0]` instead.

This was verified rather than argued. Widening the parameter so the feature keys become omissible
again, while leaving `RouteDeps` untouched:

```ts
export type LooseRouteDeps = Omit<RouteDeps, 'analysis' | 'coach' | 'tournamentCommentary'> &
  Partial<Pick<RouteDeps, 'analysis' | 'coach' | 'tournamentCommentary'>>;
export function buildRouter(deps: LooseRouteDeps): Router {
```

**survived a full run.** The guard was gone and every test passed.

One detail is worth recording because it nearly hid the result. The first attempt at that mutation
*was* caught — at `routes.ts:2201`, by `createLiveTournamentHandler(deps)`, which also takes
`RouteDeps` and was acting as an accidental anchor. Reading only "caught" would have dismissed a real
finding. Widening that consumer too isolated the question, and the mutation then survived. An
accidental anchor is not a guard: if `live.ts` ever stops taking `RouteDeps`, it silently disappears.

So:

```ts
type RouterArgument = Parameters<typeof buildRouter>[0];

const routerRejectsAMissingFeature: IsAssignable<
  Omit<RouterArgument, 'tournamentCommentary'>,
  RouterArgument
> = false;
```

`Parameters<typeof buildRouter>[0]` cannot drift from the function, because it *is* the function's
parameter. The same mutation is now `TS2322` in the test file itself rather than nowhere.

## Alternatives considered

- **A runtime list of optional keys, checked for exhaustiveness like `DISPOSABLE_TEARDOWN_MAP`.**
  Rejected: it would let a test enumerate the features and probe each route, but the list itself is a
  hand-maintained parallel to the type — exactly the thing being removed. `Record<DisposableKey, true>`
  is right for `lifecycle.ts` because teardown needs to *iterate* the keys at runtime. Nothing here
  does; the literal is written once and read by the compiler.
- **A CI static guard, like `scripts/check-variant-parity.mjs`.** That script exists because the
  supported-variant list spans TypeScript *and* SQL, and no type can reach across that boundary. Both
  bundles here are TypeScript, so the compiler is the stronger and cheaper gate.
- **Making the `ApiDependencies` keys themselves required.** Rejected: it is the public contract of
  the package, and it would break all four construction sites (`bootstrap.ts`, `test/helpers.ts`,
  `packages/e2e-harness/src/harness.ts`, `packages/api/src/scripts/generate-openapi.ts`) for no gain. The requirement belongs on
  the assembly literals, not on the bundle.

## Breaking changes

`RouteDeps` is exported from the package root — `packages/api/src/index.ts:13` re-exports
`./routes` wholesale, and `package.json` maps `.` to `dist/index.d.ts`. Two changes here narrow it:

1. **`tracer` is gone** (decision 4a). An external `buildRouter({ ..., tracer })` call is now
   `TS2353`.
2. **Twenty feature keys moved from `key?: T` to `key: T | undefined`** (decision 1a). An external
   `buildRouter` call must now name every one of them, passing `undefined` for what it has not
   composed. This is the larger of the two, and it is the change the guard is made of — there is no
   version of it that is not breaking, because "you may omit this key" is precisely the property being
   removed.

Taken deliberately:

- `buildRouter` is a composition-root primitive whose only sanctioned caller is `createApiServer`,
  in the same package. Nothing in this repository calls it from outside `packages/api`, and the only
  dependent workspace (`packages/e2e-harness`) goes through `createApiServer`.
- `createApiServer` and `ApiDependencies` — the actual supported entry points — are **unchanged**.
  Every optional key on `ApiDependencies` is still optional, and all four construction sites compile
  untouched.
- The package is at `0.1.0` and has no published consumers.

A caller who genuinely wants the old shape should be composing through `createApiServer`, which is
what the narrowing pushes them toward.

## Consequences

- Adding an optional dependency now requires naming it in `bootstrap.ts` and `server.ts`; forgetting
  either is `TS2741` at `npm run build`.
- The four `createApiServer` / `ApiDependencies` construction sites are unchanged — the public bundle
  keeps its optional keys.
- No runtime behaviour changes. 757 API tests and the whole monorepo suite pass unchanged.

## Not fixed here

- **`capabilitiesView` (`presenters.ts:988`) still takes a hand-written `Pick`.** A new optional
  feature that is never added to it is invisible to `GET /v1/capabilities` and therefore to the web
  app, and nothing complains. Presenter↔OpenAPI drift *is* already guarded, by
  `openapi.test.ts:346`; deps→presenter is not. It is a narrower failure than a 503 — the feature
  works for anyone who calls the route directly — and closing it means deciding which optional
  dependencies are user-facing capabilities, which is a judgement call rather than a derivation.
- **`SystemCapabilities` (`packages/web/src/api/models.ts:208`) omits `moveExplanation` and
  `mistakePrediction`,** which the API does emit. Both are surfaced inside the analysis sidebar and
  gated on `analysis`, so this is very likely deliberate; it is recorded rather than changed because
  confirming that is a web-side question.
~~A `RouteDeps` key with no `ApiDependencies` counterpart.~~ **Closed by decision 1b** after the
adversarial review raised it.

## Mutation ledger

Twenty-one mutations run, nineteen caught on the first pass, plus one control. **Two survived, and
both were real findings rather than weak tests** — decisions 4a and 6a above. Each was closed by
changing code, not by weakening a claim.

| # | Mutation | Caught by |
|---|---|---|
| 1–3 | Drop `tournamentCommentary` / `coach` / `analysis` from the `server.ts` forwarding literal | `TS2741` |
| 4–6 | Drop `tournamentCommentary` / `analysis` / `readiness` from the `bootstrap.ts` bundle | `TS2741` (+ `TS6133`) |
| 7 | Loosen `ForwardedDeps` back to optional keys | `TS2322` in the parity test |
| 8 | Loosen `OptionalDependencies` back to optional keys | `TS2322` in the parity test |
| 9 | Over-tighten `ForwardedDeps` to forbid `undefined` values | `TS2322` in the parity test |
| 10 | Replace the derived `ForwardedKey` with a hand-written union missing one key | `TS2353`, `TS2322`, `TS2339` |
| 11 | Drop the `{} extends Pick` optionality test from `OptionalDependencyKey` | `TS2740`, `TS2783` |
| 12 | Move the whole resolved tail above the spread | `TS2345` |
| 13 | Move `metrics` alone above the spread | `TS2783`, `TS2322` |
| 14 | Move `readiness` alone above the spread | `TS2783`, `TS2322` |
| 15 | Drop the resolved `tracer` override and forward the raw one | **SURVIVED** — see decision 4a |
| 16–17 | Delete the `: ForwardedDeps` annotation, *then* drop `tournamentCommentary` / `coach` | `TS2345` on the `buildRouter` call |
| 18 | Add a `RouteDeps` key with no `ApiDependencies` counterpart | `TS2322` on the suppliability assertion |
| 19–20 | Revert `RouteDeps.tournamentCommentary` / `.coach` to `?:` — the guard removed at its source | `TS2322` in `dependency-parity.test.ts` |
| 21 | Widen `buildRouter`'s parameter so the feature keys are omissible, leaving `RouteDeps` untouched | **SURVIVED** — see decision 6a; now `TS2322` in the test |
| control | Delete the annotation *alone* | compiles, as required — the guard is in the signature now |

Mutations 1–6 replay the defect this increment exists to close: each one is a real omission of the
kind that shipped in Increment 22, and each now fails `npm run build`. Mutations 7–11 attack the guard
itself, which is the part that would otherwise rot silently. Mutations 12–14 attack the spread ordering
decision 4 depends on.

Mutations 16–20 exist because of the adversarial review, and they are the ones that matter most:
16–17 prove the guard survives having its annotation deleted, 18 covers the blind spot in the
intersection, and 19–20 make the *test file* fail when the guard is removed at its source — which the
first version of these tests did not do.

Mutations 15 and 21 are the ones worth reading, and they survived for opposite reasons.

15 survived because the thing it broke was already dead — there was nothing to observe, and chasing
it produced a deletion.

21 survived because the test was genuinely looking in the wrong place: it asserted on `RouteDeps` by
name while the guard lives in `buildRouter`'s signature, and nothing tied the two together. That is
the third time in this increment that an assertion sat one level away from what it guarded — first
the annotation instead of the signature, then the in-repo importers instead of the exported surface,
now the type name instead of the parameter. The pattern is worth more than any of the three fixes:
**assert against the thing that enforces, not against the thing that currently agrees with it.**

**Flakes, not failures — three, in two shapes.** All were green on re-run and in isolation, and all
are in suites this change does not touch.

Two failed with `TypeError: fetch failed / bad port`, in whichever suite happened to hold a harness at
the time (`community-api` once, `achievements-api` once). `startHarness` calls `server.listen(0)`
and occasionally draws a port undici refuses.

The third (`move-explanation-route`) is **not the same thing and should not be filed as though it
were**: the file was marked failed at file level after 691ms having printed none of its fourteen
tests, with no assertion, no stack and no diagnostic in the log. Run alone it passes 14/14. The cause
is undetermined — the evidence needed to name it is not in the output.

Recorded rather than diagnosed. A test runner that can fail a file without saying why is worth its own
look, and `startHarness`'s port draw is worth fixing regardless; neither belongs in this increment.
