# ADR-0132 — The published capability document must match what the routes will do

| Field      | Value                                                  |
|------------|--------------------------------------------------------|
| **Status** | Accepted                                               |
| **Date**   | 2026-08-23                                             |
| **Scope**  | `packages/api`, `packages/web`                         |

---

## Context

`GET /v1/capabilities` is how a client decides what to offer. The rule the codebase already states,
in the doc comment on `analysisEnabled` (`packages/web/src/app/capabilities-nav.ts`), is that an
unanswered question must not surface "a control whose every request would answer 503".

One flag broke that rule, and the deployment that breaks it is a checkbox in the shipped Helm chart.

`GET /v1/search` serves three modes from two independently-gated dependency sets. Keyword needs
`searchRepository`. Semantic and hybrid need `semanticSearchRepository` **and** `embeddingProvider`,
which `bootstrap.ts` gates on `SEMANTIC_SEARCH_ENABLED` rather than on `SEARCH_ENABLED`.
`deploy/helm/gambit/values.yaml` exposes that as `search.semanticEnabled`, and its own comment says
what happens: "Disabling leaves keyword search untouched and makes those two modes return 503."

The published contract had one boolean for all three modes:

```ts
search: deps.searchRepository !== undefined,
```

And the client rendered all three unconditionally — `SEARCH_MODES` in `search-mount.ts` is a module
constant gated on nothing. So on `semanticEnabled: false` the visitor got two radio buttons whose
every use answered `service_unavailable`, with the raw server message in the error slot.

This is the gap ADR-0131 recorded as *Not fixed here*: `capabilitiesView` takes a hand-written
`Pick`, so a feature never added to it is invisible to the document. That entry judged it "a narrower
failure than a 503 — the feature works for anyone who calls the route directly". That judgement was
wrong in this instance, and the reason is worth keeping: the failure is narrower only when the
*client* can still reach the feature. Here the client is the only caller, and what it lost was not
discovery but a working control.

## Decision

### 1. Publish `semanticSearch`, built from what the route actually requires

```ts
semanticSearch:
  deps.semanticSearchRepository !== undefined && deps.embeddingProvider !== undefined,
```

Both, in the order the route reads them. In production the two are composed and decomposed together
under one env var, so `&&` looks redundant — but `ApiDependencies` permits either alone, the route
requires both, and a flag is a claim about what the route will do rather than about how the
composition root happens to be written today. A flag built from either one would be the same
over-promise in a narrower window.

It is a required field on the wire, like every other flag in `CapabilitiesFlags`, and optional on the
client, like every flag added since `puzzleGeneration` — a server predating it omits the field, and a
missing flag must read as off rather than as permission.

### 2. Make skipping the classification impossible, rather than deriving it

ADR-0131 called this fix blocked on "deciding which optional dependencies are user-facing
capabilities, which is a judgement call rather than a derivation". The framing was the mistake. The
judgement genuinely cannot be derived — but *skipping* it can be made impossible, which is the
property actually wanted.

```ts
export type NotAPublishedCapability =
  | 'logger' | 'metrics' | 'tracer' | 'readiness'
  | 'antiCheatAnalysis' | 'botTimingSource'
  | 'graphql';

type EveryOptionalDependencyIsClassified =
  Exclude<
    import('./deps.js').OptionalDependencyKey,
    keyof Parameters<typeof capabilitiesView>[0] | NotAPublishedCapability
  > extends never ? true : never;
```

Add an optional dependency and this stops being `never`, so the initialiser fails with `TS2322` until
someone gives it a flag or writes it into the list with a reason. The decision is now mandatory and
reviewable instead of implicit and skippable.

The source set is read off `Parameters<typeof capabilitiesView>[0]` rather than restated. That is the
lesson ADR-0131 §6a paid for: an assertion that names a type separately guards the name, not the
code. The parameter cannot drift from the function because it *is* the function's parameter.

The reverse direction needs no assertion. A flag with nothing computing it is already `TS2741` on the
returned literal, because `CapabilitiesFlags` is the declared return type.

### 2a. The hand-written half is acceptable because it is fail-loud

`NotAPublishedCapability` is a list someone maintains, which is the shape of the defect this ADR
exists to remove — so it needs its own justification, and it is the same one `ConstructedHere` had in
ADR-0131 §1b: **drop a name from it and the assertion breaks immediately.** A wrong entry cannot
hide. That is the property an exclusion list would not have had in ADR-0131 §4, which is why one was
rejected there and this one is accepted here.

Each name is a decision:

- `logger`, `metrics`, `tracer`, `readiness` are infrastructure. `GET /v1/metrics` and `GET /v1/ready`
  are operator surfaces; no visitor control depends on them.
- `antiCheatAnalysis` and `botTimingSource` back moderator routes, and this document is public and
  unauthenticated. Publishing them would tell every caller which deployments can detect them. A
  moderator UI that needs this needs an authenticated capabilities surface, not a new key here.
- `graphql` already degrades on its own: `packages/web/src/api/graphql.ts` latches `available` from
  the first 503 and returns `null` thereafter, so callers fall back to `shortId` and no control is
  offered that cannot work. That is the outcome a flag would buy, reached without one.

### 2b. Being classified is not the same as being published

Decision 2 alone does not deliver what it promises, and the adversarial review of this branch proved
it. `keyof Parameters<typeof capabilitiesView>[0]` says a dependency appears in the presenter's
*parameter*; TypeScript is content for a parameter to carry a key the body never reads. A dependency
declared, composed, and added to the `Pick` — with no flag and no line in the function — compiled
clean and passed every test, reaching production unpublished. See mutation 12.

No type can express "this key is read", so the closing guard is behavioural and lives in
`packages/api/test/capability-parity.test.ts`: build a value for every capability source, remove them
one at a time, and require the published document to change. **A key whose removal changes nothing
publishes nothing.** The value table is itself a mapped type over `CapabilitySourceKey`, so a new
dependency has to appear there before the suite compiles, and then has to earn its place at runtime.

### 3. The client offers nothing until the server has said what it serves

Only an explicit `true` enables anything. Nothing is rendered and then withdrawn, because a control
that exists for 200ms is a control that can be used.

The two flags are a hierarchy, not two independent switches:

| `search` | `semanticSearch` | The visitor gets |
|---|---|---|
| `true` | `true` | all three modes |
| `true` | `false` | keyword alone |
| `false` | anything | an honest "search is unavailable" notice, and **no request** |

A deep link to a mode the deployment cannot serve falls back to keyword and rewrites the URL with
`history.replaceState`, not `pushState`: it must not become a back-button destination. A deep link
with `search` off rewrites nothing — there is nowhere better to send it.

The one cost is a server predating a flag, which omits it and therefore loses what it could have
served. That is the codebase's stated convention applied consistently, and it degrades toward the
mode that always works.

### 4. Keyword search waits for the answer, reversing an earlier decision in this increment

The first version let keyword search start immediately, on the reasoning that it was "served by the
dependency the `search` flag already describes" and should not pay for a question about the other two
modes. Both halves of that were wrong: nothing gated it on that flag, and `SEARCH_ENABLED=0` — the
chart's `search.enabled: false`, an absolute kill switch per ADR-0055 — leaves the repository
unconstructed and every mode answering 503, keyword included.

Knowing whether a request is pointless requires having asked. So keyword now waits too. The cost is
one memoised round trip on the first search of a visit; the alternative is a request guaranteed to
fail and a visitor shown the server's refusal. A 503 reads as *broken*, and a deployment with search
switched off is not broken — it is configured, and the notice says so.

### 5. The gate is on every entry point, not on the route

The route was never the entry point. The header search form lives in the nav, on every page, and is
a `<form>` rather than an `a[data-route]`, so `routesToRemove` cannot reach it — which is why the
first version of this ADR gated the mode selector and left a search box on a deployment with search
switched off. Gating `mountSearch` alone would have left that form navigating to a page that then
had to explain itself: the same one-level-away partial fix this increment exists to stop making.

So the form **ships `hidden` in `index.html`** and is revealed by `applySearchCapability` when
`search` is `true`. That is the opposite default from the nav links, which are removed only on an
explicit `false`, and deliberately so — the trade is stated in `routesToRemove`'s own comment: there
the cost of guessing wrong is hiding a link that works; here it is offering a control that cannot,
and one that *navigates*.

Three things now carry the same gate: the header form (hidden until revealed), the mode selector
(nothing rendered until the flags arrive), and the request itself (never issued when `search` is not
`true`). The submit handler in `main.ts` also declines a hidden form, which covers a programmatic
`submit()` rather than a visitor; **the `hidden` attribute is the gate, and that check is a backstop**
— it has no independent test, because `main.ts` has no test seam.

### 6. `SystemCapabilities` gains `moveExplanation` and `mistakePrediction` as well

ADR-0131 recorded these as missing from the client interface and "very likely deliberate". They were
not. `capabilities-nav.ts` has had working `moveExplanationEnabled` and `mistakePredictionEnabled`
predicates all along, reading through `capabilityFlags()`, which returns `Record<string, unknown>`
and so never consulted `SystemCapabilities` at all. The API has always emitted both. The interface
was simply incomplete, with no behavioural consequence — which is exactly why nothing caught it.

## Alternatives considered

**Derive the flag set from the dependency type.** Rejected: it assumes every optional dependency is a
user-facing capability, which is false for seven of them, and publishing the moderator ones would
leak deployment detail to unauthenticated callers.

**Let the client probe.** The GraphQL path does this and it works there, because one 503 settles the
question for a whole page of name lookups. Here the probe *is* the user's search, so the cost of
finding out is the failure being fixed.

**Infer semantic availability from `search`.** That is the current behaviour, and it is the bug.

**Leave the client alone and just publish the flag.** Half the fix. The published document would be
correct and the visitor would still get two broken buttons.

## Breaking changes

`CapabilitiesFlags.semanticSearch` is a **required** field, and the schema sets
`additionalProperties: false`. Any consumer constructing a `CapabilitiesFlags` value must add it.
Nothing outside `packages/api` constructs one; the package is 0.1.0 with no published consumers.

On the client, a server predating the flag now hides two search modes it can serve. Stated here
rather than buried, because it is a behaviour change for a mixed-version deployment and not only a
type change.

## Consequences

The capabilities document now describes the search surface accurately, and a deployment running
`search.semanticEnabled: false` shows one working mode instead of three, two of which fail.

More durably: a new optional dependency can no longer reach production unclassified *or* classified
but unpublished. `tsc` asks the first question — published, or explicitly not — and refuses the build
until it is answered. The suite asks the second, because no type can: a source that publishes nothing
fails the load-bearing test by name.

Both halves are needed, and the first without the second was not enough. An earlier draft of this
section claimed `tsc` alone settled it; the adversarial review of the branch showed that a dependency
listed in the presenter's parameter and read nowhere satisfied every compile-time guard here while
publishing nothing. See decision 2b and mutation 12.

## Mutation ledger

Twenty-four mutations run, twenty-three caught on the first pass. **One survived, and it was a real
finding rather than a weak test** — mutation 12 below, which closed by changing code.

Two others *appeared* to survive and had not been applied: the mutation script matched on `\n` while
the file is CRLF, so it rewrote nothing and the suite passed for the most boring possible reason. A
mutation that silently no-ops is indistinguishable from a weak test, and reads as the more
interesting of the two. The script now throws when an anchor does not match.

Mutations 13 and 14 exist because the CodeRabbit review of PR #155 named two assertions that could
not fail; 15 because the same review corrected the diagnostic code claimed for this direction, and
running it was cheaper than arguing about it. 16–21 attack the two halves of decision 5, because a
gate on two entry points is worth exactly as much as its weaker half.

**Mutation 20 is the one that nearly got away.** Removing `hidden` from the form in `index.html`
leaves every unit test green: the gate reads and writes `form.hidden` on a fake element that has its
own default, so the suite never learns what the real markup ships. The whole no-flash guarantee rests
on one HTML attribute that nothing was reading. `a11y.test.ts` already parsed the real `index.html`,
so the contract went there.

The totals appear here and in `PROJECT_STATE.md`'s summary sentence and nowhere else — ADR-0131's
entry carried a third copy in `ROADMAP.md` and drifted from it twice, which is the same failure these
increments exist to remove.

| # | Mutation | Caught by |
|---|---|---|
| 1 | Add an optional dependency to `ApiDependencies`, classify it as neither | `TS2322` on the classification assertion |
| 2 | Drop `graphql` from `NotAPublishedCapability` | `TS2322` — the fail-loud property of decision 2a |
| 3 | Revert the `semanticSearch` flag entirely: interface key, computation and `Pick` entry | `TS2322` — **this is the original defect, and it no longer compiles** |
| 4 | Compute `semanticSearch` from `searchRepository` — the conflation being fixed | the keyword-on/semantic-off behavioural test |
| 5 | Compute it from `semanticSearchRepository` alone, dropping `embeddingProvider` | the presenter test written for exactly this gap; nothing else sees it |
| 6 | Render every mode synchronously, reverting the client gate | 3 tests in `search-mount.test.ts` |
| 7 | `pushState` instead of `replaceState` on the deep-link fallback | the deep-link fallback test |
| 8 | Drop the `controller.isDisposed` guard before the late render | the post-disposal test |
| 9 | `semanticSearchEnabled` becomes `!== false` rather than `=== true` | 2 tests — the fail-closed cases |
| 10 | Collapse `OptionalDependencyKey` to `never`, making the guard vacuous | `TS2322` in the test — **and `packages/api/src` still compiles clean** |
| 11 | Publish the flag from the presenter but not from the OpenAPI schema | `openapi.test.ts:345`, which already existed and needed no change |
| 12 | Add a dependency, compose it, list it in the `Pick`, give it **no flag** | **SURVIVED the first version.** Now `TS2741` on `SourceValues`, then the load-bearing test |
| 13 | Rewrite the deep-link URL but skip the selector re-render | the fallback test's checked-radio assertion |
| 14 | Rewrite the URL on every path, not only the fallback | the keyword test's `pushed`/`replaced` assertions |
| 15 | Declare a flag on `CapabilitiesFlags` and compute nothing for it | `TS2741` on the returned literal — the reverse direction, confirmed rather than assumed |
| 16 | Drop `applySearchCapability` from `applyNavCapabilities` — the header gate unwired | the integration test, which is the only place a real `applyNavCapabilities` call has an answer |
| 17 | Header gate always reveals the form | 2 tests |
| 18 | `searchEnabled` always returns `true` — the whole surface ungated | **9 tests** |
| 19 | `semanticSearchEnabled` stops requiring `search` | the hierarchy test |
| 20 | Ship the header form **visible** in `index.html` | the markup-contract test in `a11y.test.ts` — and nothing else |
| 21 | Stop hiding the empty mode group before the flags arrive | the search-off test |
| 22 | Report an unanswered capability request as "switched off" | the explicit-false-vs-unanswered test |
| 23 | `searchExplicitlyDisabled` treats anything non-`true` as an explicit `false` | the same test, from the other side |
| 24 | Stop clearing stale results on reset | the delayed-flags navigation test |

Mutation 12 is the one this ADR should be read for, because the first version of these guards did not
catch it and the adversarial review of the branch did. `CapabilitySourceKey` reads the presenter's
*parameter*, and TypeScript is content for a parameter to carry a key the body never reads. So a new
dependency could be declared, composed in `bootstrap.ts`, and listed in the `Pick` while publishing
nothing — compiling clean and passing every test. That is this ADR's own defect, one level up from
where it was being fixed: **the guard proved the key was in the parameter, not that the key produced
a flag.**

It was caught the same way as ADR-0131 §6a's survivor, and needed the same care: the first attempt
appeared to fail, but on Increment 23's `OptionalDependencies` guard in `bootstrap.ts` rather than on
anything here — an accidental anchor. Composing the dependency removed it, and the mutation then
survived a full run.

No type can express "this key is read", so the closing assertion is behavioural: build a value for
every capability source, remove them one at a time, and require the published document to change.
A key whose removal changes nothing publishes nothing. Removal rather than addition because
`semanticSearch` needs two dependencies, so `embeddingProvider` supplied alone flips no flag and
would look like a dead key under the opposite test.

Mutation 10 is why the test carries `theClassifiedSetIsNotEmpty`. `Exclude<never, anything>` is
`never`, so a broken optional-key derivation in `deps.ts` satisfies the assertion in `presenters.ts`
while classifying nothing at all — the guard still present, still green, covering zero keys. Verified
rather than reasoned about: under that mutation `tsc -p tsconfig.json` reports **zero errors**, and
only the test file fails. An assertion that cannot distinguish "everything is classified" from
"there is nothing to classify" is not yet a guard.

Mutation 5 is the other one worth reading. Production composes the two semantic dependencies together
under a single env var, so a flag built from either alone behaves identically on every deployment
that exists today and no behavioural test could distinguish it — the harness cannot separate them
either. It is caught only because `capabilitiesView` is called directly with one dependency and not
the other. A guarantee that only holds because of how the composition root happens to be written is
not a guarantee; it is a coincidence with good timing.

## Suite flakiness observed during this increment

Recorded separately from the ledger because neither is this change's doing — both files are untouched
by it, and both pass in isolation — and because filing distinct symptoms under one cause is a mistake
made in ADR-0131 and corrected there.

- **`coach-route.test.ts`** failed once under `scripts/ci-local.mjs` with
  `TypeError: fetch failed` / `[cause]: Error: bad port`, thrown from `helpers.js` at the harness's
  first request. That is the documented `startHarness` flake: `server.listen(0)` occasionally draws a
  port undici refuses. Passed 7/7 three times in isolation and in every other full run.
- **`seek-concurrency.test.ts`** failed once in a full `npm test` at *file* level — `'test failed'`
  after 634ms with no assertion, no stack, no diagnostic, and none of its three tests reported.
  Passed 3/3 three times in isolation. **The cause is undetermined.** It shares the same signature as
  the `move-explanation-route` failure ADR-0131 recorded, which was also never explained. It is
  tempting to call it the port flake too, and there is no evidence for that: the port flake announces
  itself with a stack, and this produced none.

Both warrant a look at `startHarness`'s port acquisition in its own increment. Neither is a reason to
hold this change, and neither is claimed here to be understood.

## Not fixed here

- **The e2e harness composes no semantic search** (`packages/e2e-harness/src/harness.ts`), so the e2e
  environment now renders one search mode rather than three. That is correct — the harness genuinely
  cannot serve the other two, which is this defect reproduced in our own test environment — but it
  means no e2e spec exercises the semantic modes, and none did before either.
- **`puzzleGeneration` reports `false` while its route answers something other than 503.** The flag is
  `puzzleVariants.length > 0`; the route guards on `!service`. Investigated and left: when the list is
  empty every variant is unsupported, so `generate` throws `422 unsupported variant`
  (`packages/api/src/analysis/puzzle-generation-service.ts:111`) for all of them. The flag is honest —
  the feature can serve nothing — and only the status code a flag-ignoring client would see differs.
  A cosmetic mismatch, not a capability lie.
- **An authenticated capabilities surface for moderator features.** Named as the right shape for
  `antiCheatAnalysis` and `botTimingSource` above; not built, because nothing asks for it yet.
- ~~**Clicking a search mode discards text typed since the page loaded.**~~ `createModeInput`
  (`packages/web/src/app/search-mount.ts`) closed over `request.query`, captured when the route
  mounted, so `navigateToSearchMode` navigated with the old query and the mount then reset the input
  to match. Pre-existing — the closure was untouched by this ADR's change — and found by the
  adversarial review of this branch. **Fixed in a follow-up on `fix/m15-search-mode-stale-query`:**
  the query is now a `() => string` read when a mode is chosen rather than a string captured when the
  selector renders, falling back to the mounted query only where there is no header input at all.
  Recorded here rather than moved, so the trail from symptom to cause survives.
