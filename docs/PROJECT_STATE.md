# Gambit — Project State (Engineering Handover)

> Living handover document. Anyone (human or AI) joining the project should be able
> to read **only this file** and continue immediately. Updated after every
> milestone and every significant architectural step.

_Last updated: 2026-08-24 — M15 Increment 26: server-authoritative Study Partner v1 production slice._

## M15 Increment 26 — Study Partner v1 productionization (ADR-0134)

Study Partner now has a private, durable, server-authoritative linear lifecycle. Five authenticated
routes create, read/resume, append a move, end idempotently, and hard-delete a session. The client
never supplies successive FENs or coaching policy: the service applies each move to the stored
position, derives the next FEN, invokes the hardened production `CoachService` exactly once, and
atomically stores the safe coaching projection with the position advance.

Migration `0024_study_partner.sql` adds normalized sessions and turns plus a durable turn-request
ledger. The ledger claims a bounded required `Idempotency-Key` before charging or expensive work,
so concurrent retries cannot purchase coaching twice; completed retries replay the stored turn.
Owner-scoped repositories make missing and foreign IDs the same 404, account/owner deletion
cascades, cancellation persists no partial turn, and completion never rewrites `completedAt`.
Deletion refuses a fresh claim and protects accepted work for one hour from a concurrent cascade;
after that window privacy deletion is allowed without replaying or reclaiming the accepted request.
Sessions are bounded to 20 turns and standard chess in v1; the latter avoids claiming FEN authority
for variants whose complete rule state does not round-trip through the current FEN codec.

Only versioned, tagged production coaching sections persist. Puzzle/endgame answers remain withheld,
and explanation provider/model metadata, prompts, raw provider responses, usage, and library
narrative are absent. OpenAPI and the typed web client expose exactly the five-route lifecycle; a
visual UI, listing, retention jobs, branching/undo/collaboration, Study integration, Voice Coach,
and recovery after ambiguous accepted requests remain deferred. Pre-charge claims are safely failed
after five minutes by the next turn claim, without a background job.

Detailed in `docs/adr/0134-study-partner-v1.md`.

## M15 Increment 25 — CoachPort extraction (ADR-0133)

`StudyPartner` and `VoiceCoach` no longer require the concrete library `Coach`. Both depend on the
one-method `CoachPort` their call sites actually use, while `Coach` satisfies that port structurally.
The public package export and both constructor contracts are pinned by compile-time tests; bare-port
fakes also drive each consumer, so restoring either dependency to `Coach` fails the build.

This is an enabling refactor, not production wiring. No second library `Coach` and no adapter were
added. `CoachService` deliberately does not satisfy the port: its section-withholding reasons,
puzzle-solution omission, and rate-limit acceptance callback cannot be bridged truthfully by a
structural adapter. Durable study-session persistence, ownership, routes, migration, and Voice Coach
speech providers remain deferred.

Detailed in `docs/adr/0133-coach-port.md`.

## M15 Increment 24 — Capability parity (ADR-0132)

The gap Increment 23 recorded, closed — and a live instance of it, found while confirming the gap was
worth closing at all.

`GET /v1/search` serves three modes from two dependency sets the server gates separately. Keyword
needs `searchRepository`; semantic and hybrid need `semanticSearchRepository` **and**
`embeddingProvider`, gated on `SEMANTIC_SEARCH_ENABLED` rather than `SEARCH_ENABLED`. The Helm chart
offers that as `search.semanticEnabled`, and `values.yaml` says what happens: "Disabling leaves
keyword search untouched and makes those two modes return 503."

The published contract had one boolean for all three, and the client rendered all three
unconditionally — `SEARCH_MODES` in `search-mount.ts` was a module constant gated on nothing. **On a
supported chart configuration the visitor got two buttons whose every use answered
`service_unavailable`,** with the raw server message in the error slot. That violates a rule this
codebase already states, on `analysisEnabled`: an unanswered question must not surface "a control
whose every request would answer 503".

**`semanticSearch` is now published,** built from both dependencies because the route reads both.
`ApiDependencies` permits either alone even though production composes them together, and a flag is a
claim about what the route will do rather than about how the composition root happens to be written.

**Skipping the classification is now impossible.** ADR-0131 called this blocked on "deciding which
optional dependencies are user-facing capabilities, which is a judgement call rather than a
derivation". The framing was the mistake: the judgement cannot be derived, but *skipping* it can be
made impossible, which is the property actually wanted.
`Exclude<OptionalDependencyKey, keyof Parameters<typeof capabilitiesView>[0] | NotAPublishedCapability>`
must be `never`, so a new optional dependency fails `TS2322` until someone gives it a flag or writes
it into the exclusion list with a reason. The source set is read off the presenter's own parameter,
not restated — ADR-0131 §6a's lesson. The hand-written half is acceptable for the same reason
`ConstructedHere` was: drop a name and the assertion breaks immediately.

**The client offers nothing until the server has answered, at every entry point.** The two flags are
a hierarchy: `search` gates the whole surface, `semanticSearch` gates the two extra modes on top of
it. Search off yields an honest unavailable notice and **no request at all**; search on with semantic
off yields keyword alone; both on yields three modes. A deep link to a mode the deployment cannot
serve falls back to keyword and rewrites the URL with `replaceState`, not `pushState`.

**The route was never the entry point.** The header search form lives in the nav on every page, and
being a `<form>` rather than an `a[data-route]` it is unreachable by `NAV_CAPABILITY_MAP` — so the
first pass gated the mode selector and left a search box on a deployment with search switched off.
Raised by the Qodo review of PR #155. The form now ships `hidden` in `index.html` and is revealed by
`applySearchCapability` only on an explicit `search: true`, which is the opposite default from the
nav links and deliberately so: there the cost of guessing wrong is hiding a link that works, here it
is offering a control that cannot, and one that navigates.

That also reversed this increment's own earlier decision to let keyword search start without waiting
for the flags. Knowing whether a request is pointless requires having asked. The cost is one memoised
round trip on the first search of a visit; the alternative is a guaranteed 503 shown to the visitor,
and a 503 reads as broken when the deployment is merely configured.

`SystemCapabilities` also gained `moveExplanation` and `mistakePrediction`. ADR-0131 recorded these as
missing and "very likely deliberate". They were not: `capabilities-nav.ts` has had working predicates
for both all along, reading through `capabilityFlags()`, which returns `Record<string, unknown>` and
so never consulted the interface. The API has always emitted them. The interface was incomplete with
no behavioural consequence, which is exactly why nothing caught it.

**Tests:** 5 in `capability-parity.test.ts` (four type-level predicates asserted at runtime; the
presenter called directly to pin that semantic search needs *both* dependencies; and two behavioural
— keyword-on/semantic-off says so and means it, and the reverse direction) and 13 in `search-mount.test.ts` plus 5 in
`capabilities-nav.test.ts` and a markup contract in `a11y.test.ts`, covering all three capability
states, both deep-link directions, missing and malformed flags, a rejected request, a resolution
landing after `dispose()`, and the header form at each end of its gate. Twenty-four mutations run,
twenty-three caught on the first pass; the survivor was a real finding and is closed by a code
change. Two more appeared to survive and had simply not been applied — the mutation script matched a
line-feed anchor against a CRLF file, rewrote nothing, and the suite passed for the most boring
possible reason — which is why it now throws on a missing anchor rather than passing quietly.

**The survivor is the one to read.** `CapabilitySourceKey` reads the presenter's *parameter*, and
TypeScript is content for a parameter to carry a key the body never reads — so a dependency declared,
composed in `bootstrap.ts` and added to the `Pick`, with no flag and no line in the function, compiled
clean and passed everything. That is this increment's own defect, one level up from where it was being
fixed: the guard proved the key was in the parameter, not that the key produced a flag. It needed the
same care as ADR-0131 §6a's survivor, too — the first attempt appeared caught, but by Increment 23's
`OptionalDependencies` guard rather than by anything here, an accidental anchor. No type can express
"this key is read", so the closing guard is behavioural: remove each source in turn and require the
published document to change.

The three others worth reading: fully reverting the `semanticSearch` flag no longer compiles, so the guard
would have caught the original defect; building the flag from one dependency instead of both is
caught only by the presenter test written for exactly that gap, because production composes the two
together and no behavioural test can separate them; and collapsing `OptionalDependencyKey` to `never`
leaves `packages/api/src` compiling **clean** while the classification covers zero keys — an
assertion that cannot tell "everything is classified" from "there is nothing to classify" is not yet
a guard, which is why the test pins the set as populated.

**Breaking, deliberately:** `CapabilitiesFlags.semanticSearch` is required and the schema sets
`additionalProperties: false`. Nothing outside `packages/api` constructs one. On the client, a server
predating the flag now hides two modes it can serve — the codebase's stated convention applied
consistently, degrading toward the mode that always works.

**Not fixed here:** the e2e harness composes no semantic search, so the e2e environment renders one
mode rather than three — correct, and this defect reproduced in our own test environment, but it
means no spec exercises the semantic modes. `puzzleGeneration` reporting `false` while its route
answers 422 rather than 503 was investigated and left: the flag is honest, only the status code a
flag-ignoring client sees differs.

Detailed in `docs/adr/0132-capability-parity.md`.


## M15 Increment 23 — Compile-time dependency parity (ADR-0131)

The known gap Increment 22 recorded, closed. `ApiDependencies` carries twenty-four optional keys, and
they passed through two hand-written literals — the bundle `createPgDependencies` assembles and the
copy `createApiServer` hands the router. Because every key was optional in both types, **omitting one
compiled cleanly**: the build passed, the linter passed, the whole suite passed, and the feature
answered 503 from a deployment that had configured it correctly. Increment 22 shipped exactly that,
for `tournamentCommentary`, and it was found by calling the endpoint rather than by any gate.

**Both literals are now exhaustive at compile time.** `ForwardedKey = Extract<keyof ApiDependencies,
keyof RouteDeps>` yields a *union alias*, so the mapped type over it is non-homomorphic and TypeScript
does not carry `?` across: every key becomes required while its value type still admits `undefined`.
`analysis: deps.analysis` still typechecks with no engine composed; dropping the line is `TS2741`.
The same derivation gives `OptionalDependencies` for the production bundle. Both sets derive from the
declarations, so a new feature joins them the moment it is declared and there is no list to forget.

This is the defect class ADR-0092 closed for `main.ts`'s disposal list, in a second file. The remedy
differs — `Record<DisposableKey, true>` is right there because teardown *iterates* the keys at
runtime, and nothing here does — but the principle is the same: derive the list from the authoritative
type so omission cannot compile.

The twenty conditional spreads in `bootstrap.ts` (`...(coach ? { coach } : {})`) became plain
assignments. That changes absent keys to present-and-`undefined`, which was verified to be
unobservable rather than assumed: `packages/api` does not set `exactOptionalPropertyTypes` (`packages/web`
does), nothing in the package probes these bundles with `in` or `Object.keys`, every consumer asks
`!== undefined`, and `server.ts` had always handed the router exactly this shape.

**The guard is in `buildRouter`'s signature, not in an annotation.** The first version put it in
`const forwarded: ForwardedDeps = { ... }`, and the adversarial review of PR #154 pointed out that an
annotation is deletable — reverting `server.ts` while leaving the aliases defined passed every test,
because the tests asserted properties of the aliases rather than of the code using them. Every optional
feature on `RouteDeps` is now `key: T | undefined` instead of `key?: T`: the value is exactly as
optional, the key is mandatory, and no call site can opt out. A second assertion covers what an
intersection cannot see — a key added to `RouteDeps` alone, which would never be forwarded.

**Tests:** 5 in `dependency-parity.test.ts` — three of type-level predicates asserted at runtime (the
router type rejects a missing feature key; an assembly omitting an optional dependency does not
typecheck; `undefined` stays legal for a feature and illegal for a core key) and two behavioural (a
composed dependency reaches its route; an uncomposed one still answers 503). Twenty-one
mutations run, nineteen caught on the first pass. Six replay the real omission in each literal and fail
`npm run build` with `TS2741`; the rest attack the guard itself rather than its behaviour — loosening
either mapped type back to optional keys, over-tightening one to forbid `undefined`, replacing a
derived key set with a hand-written union, reordering the spread, deleting the forwarding annotation,
adding a `RouteDeps` key nothing can supply, and reverting a `RouteDeps` key to `?:`. The numbered
table is in ADR-0131 and is not restated here.

**Both survivors were real findings.** The second: the parity predicates asserted on `RouteDeps` by
name while the guard lives in `buildRouter`'s signature, so widening that parameter — leaving
`RouteDeps` untouched — removed the guard with every test still passing. Verified by running it. They
now read `Parameters<typeof buildRouter>[0]`, which cannot drift from the function because it is the
function's parameter. Raised by CodeRabbit; it is the third assertion in this increment found sitting
one level away from what it guarded.

**The first survivor was also a real finding.** Dropping the resolved `tracer` override and forwarding the
raw one compiled and passed everything — correctly, because `RouteDeps` declared `tracer?: Tracer`
and **no route handler ever read it**. Tracing reaches the router through `router.toListener`, whose
runtime `tracer` is required. A declared-but-unread optional dependency is a fourth thing that can
silently drift, so it is deleted rather than kept with a corrected comment; the first build after
deleting it failed with `TS2353` on the now-unknown key in the forwarding literal, which is the
derivation working in the direction nobody usually tests.

No runtime behaviour changed; 757 API tests and the full monorepo suite pass unchanged.

**Breaking, deliberately:** `RouteDeps` is exported from the package root
(`index.ts:13` re-exports `./routes` wholesale), so both changes narrow public type surface — `tracer`
is gone, and twenty keys moved from `key?: T` to `key: T | undefined`. There is no non-breaking version
of the second: "you may omit this key" is the property being removed. `createApiServer` and
`ApiDependencies` — the supported entry points — are unchanged, nothing outside `packages/api` calls
`buildRouter`, and the package is 0.1.0 with no published consumers. An earlier draft claimed this
narrowed no external contract, having checked who *imports* the type in-repo rather than whether it is
*exported*; the CodeRabbit review of PR #154 caught it.

**Not fixed here — both RESOLVED in M15 Increment 24 (ADR-0132):** `capabilitiesView` still takes a
hand-written `Pick`, so a new optional feature never added to it is invisible to
`GET /v1/capabilities` — a narrower failure than a 503, and closing it means deciding which
dependencies are user-facing capabilities rather than deriving it. *That reasoning was wrong twice
over: the failure is narrower only when the client can still reach the feature, and semantic search
was already a live instance where it could not; and the judgement, while genuinely underivable, can
be made unskippable, which is the property actually wanted.* `SystemCapabilities` in the web client
omits `moveExplanation` and `mistakePrediction`, which the API does emit; both are gated on
`analysis` in the sidebar, so this is likely deliberate and is recorded rather than changed. *Also
wrong — the predicates read through an untyped record, so the interface was simply incomplete.*

Detailed in `docs/adr/0131-dependency-parity.md`.


## M15 Increment 22 — Tournament Commentary (ADR-0130)

The M9 `TournamentCommentator` had no route, no capability and no UI. It now runs through
`POST /v1/tournaments/:id/games/:gameId/commentary` and
`POST /v1/tournaments/:id/rounds/:roundIndex/recap`, with a commentary panel on the existing
tournament detail page.

**The caller names a resource; the server supplies every fact.** Both routes take path identifiers
and an *empty body* — a body carrying any field is a 422, not an ignored field. The library's
interface accepts the FEN, the players, the results and the standings from its caller, because in M9
its caller was a test; productionizing it is mostly the work of taking those parameters away. Without
that, anyone could have a model narrate a tournament that never happened in this platform's voice.

**A live game is never evaluated.** `GET /v1/tournaments/:id/live` is public and already publishes
the FEN of every game in progress; attaching an engine evaluation would turn a spectator endpoint
into a live engine for the players in it. An unfinished game is refused with 409 before an engine is
acquired — a refusal, not a redaction, because prose grounded in an evaluation that does not exist is
prose about nothing.

Terminality is read from the **durable event log**, not from the tournament's recorded result:
`TournamentResultReporter` records results asynchronously from a PubSub subscription, so a game can
be over in the log for some time before the aggregate knows. Membership — is this game part of this
tournament — still comes from the aggregate, whose game link is written at launch.
`DurableFinishedGameArchive` is the counterpart to `DurableTournamentLiveView`: same log, opposite
half.

**The engine looks at the position the final move was played from**, never the one it produced. A
move and the board it has already been played on do not belong together (the ADR-0129 §7 defect), and
a game's final position may be checkmate, where an evaluation is not a fact (ADR-0116).

**A round is recapped only when the aggregate says it is complete.** `isRoundComplete` is the
condition `tryAdvance` uses to advance a round, exposed rather than restated, and `tryAdvance` now
calls it — so "complete enough to recap" and "complete enough to pair the next round" cannot drift
apart. There is no partial recap; a narrative about three of five games under a heading that says
"after round 3" is a false account of a round. `standingsAfterRound` reports the table as it stood at
the end of *that* round, because by recap time a later round may already have decided games.

**Facts and prose never mix.** `results`, `standings` and `citation` are server-derived fields; the
narrative sits beside them and nothing in the response is derived from it. Byes, voids and double
forfeits have no spelling in the library's three-valued match vocabulary, so they are published in
`results` and withheld from the prompt, and `pairingsNarrated` says how many pairings the model was
actually given — the UI shows a note when it is fewer than the round contained.

**The library cannot reach an engine.** It is constructed with an `AnalysisProvider` that throws, so
a future edit that stopped supplying pre-computed analysis fails loudly rather than quietly running a
search this API never sized. Its other trap is a citation of `+0.00` at depth 0 when it has no
results — an authored number published as a measured one (ADR-0127) — and the service refuses with
503 before it can be reached.

**Cost:** one engine search and one provider call for a commentary, zero and one for a recap. That is
move explanation's bill, so `tournamentCommentary` gets move explanation's budget (10/min user,
30/min IP) and both routes share it. Charged after every free refusal and before the first expensive
call, so enumerating game ids costs nothing. Repeat requests hit the orchestrator's response cache
and the engine's LRU, both already composed; no store and no migration were added.

**Privacy:** only handles reach the provider, projected from the account row before it goes anywhere
else, and a handle that does not match the narratable shape is replaced by a label rather than
sanitised — renaming a real player in an official-sounding narrative is worse than declining to name
them. Both routes are authenticated: no route in this API that reaches an engine or a provider is
open to anonymous callers.

**Tests:** 19 service, 7 route, 7 controller, 13 view, 10 mount, 4 client — 60 in all.
Fifty-seven mutations run across thirteen rounds, fifty-seven caught. Five survived a first pass, and each exposed a test that could
not fail rather than a guard that was missing: an auth declaration flipped to `PUBLIC` still 401'd
through `requireAuth` while silently dropping the router's `WWW-Authenticate` challenge; a terminal
outcome was paired with empty lines, so the emptiness check did all the work; a fake declared the
client's own signature and could not observe a request body; a fixture registered players in
ascending id order, so encounter order already matched sorted order; and the body-rejection test
posted to one of the two routes. The ledger is in `docs/adr/0130-tournament-commentary.md`.

**Known gap, RESOLVED in M15 Increment 23 (ADR-0131):** `createApiServer` forwarded optional
dependencies to the router by hand, and the list was silently incomplete when one was added — this
service was wired everywhere else and still answered 503 until that line was written, and it compiled
the whole way. Same defect class as the `main.ts` disposal list resolved in Increment 25. **Closed in
Increment 23:** both that literal and the bundle `createPgDependencies` assembles are now typed by key
sets derived from the declarations, so omitting one is `TS2741` rather than a 503.

Deferred: live-game commentary, a durable store of generated prose, arena commentary, Study Partner
(needs a durable `StudySessionStore` and a `CoachPort` extraction — the library `Coach` is not what
production runs), Voice Coach, Chess960, `studies.variant` CHECK → FK.

> **The `CoachPort` half is done (ADR-0133).** `StudyPartner` and `VoiceCoach` now take a one-method
> `CoachPort` that the library `Coach` satisfies structurally, so neither is welded to the concrete
> class any more. **Study Partner and Voice Coach remain deferred**: this removed one blocker, not the
> list. A durable `StudySessionStore`, session ownership, routes and a migration are untouched, as are
> Voice Coach's speech providers — and `CoachService` deliberately does *not* satisfy the port, because
> its withholding, puzzle-solution and rate-charging contracts genuinely differ. ADR-0133 §3 records
> what a production adapter would take.

Detailed in `docs/adr/0130-tournament-commentary.md`.


## M15 Increment 21 — Coach Productionization (ADR-0129)

The last M8 feature reachable without a migration. `POST /v1/coach` coaches a position by
orchestrating the five feature services that already exist, and appears as a section of the existing
game analysis sidebar — coaching is about the position already on the board, which is what every
other sidebar section is about.

**The library `Coach` class is deliberately not what production runs.** Its constructor builds its
own `MoveExplainer`, `MistakePredictor`, `OpeningExplorer`, `PuzzleGenerator` and `EndgameTrainer`
on the raw engine port, which would route every request around all five services and therefore
around every policy they own — the standard-only opening gate and its ply ceiling (ADR-0127), the
finiteness guards and the `judged | terminal` union (ADR-0128), the terminal adjudication that
stopped checkmate reading as `+0.00` (ADR-0116), the answer withholding of ADR-0095. None of that
would fail loudly; it would produce plausible coaching with the guards missing.

**A section may never publish more than its own route does.** Four of the five render through the
feature's existing presenter, so there is no second projection to drift from the first, and the
OpenAPI section schemas `$ref` the same response schemas. The endgame section reaches the catalogue
through a new `EndgameTrainingService.identify(fen)` that shares `next`'s private `project()`,
closing a real back door: a learner with a training position open could otherwise have pasted its
FEN into `/v1/coach` and read the answer `/v1/endgames/next` withholds. The puzzle section is the
one deliberate narrowing — it drops `solutionMove` and `solutionLine`, because "there is a tactic
here" is a coaching prompt and "there is a tactic here and it is `c6d4`" is the answer.

**Degradation is per section**, each carrying an explicit reason rather than a null:
`not_requested`, `not_applicable`, `unsupported`, `unavailable`, `cancelled`. `unsupported` (never
built here) is kept apart from `unavailable` (failed this time) because only the second is worth
retrying, and the UI words them differently. The request fails only when nothing was delivered *and*
something is broken — "every section unavailable" is unreachable once three are `not_requested`, and
"nothing fired" would turn a genuinely quiet position into an error.

**Cost.** Four engine searches worst case, not five: mistake prediction and move explanation both
issue a byte-identical MultiPV 1 search of the position, and `RequestScopedAnalysis` collapses it —
keyed on the complete argument set, storing the promise so concurrent duplicates coalesce rather
than race. The engine's own LRU would collapse the sequential case but has no single-flight and is
configurable, so the bound would have depended on `cacheEntries`. Sections run in sequence, never
`Promise.all`. Its own bucket at 8/min per user, and composing the services internally charges none
of theirs — the services never touch the limiter, and `onAccepted` comes from the route. A test sets
each sibling bucket to one request and proves it is still unspent after two coaching calls.

**Cancellation is wired for the first time in the codebase.** `AnalysisRequest.signal` always
existed in the engine layer, but `RequestContext` carried no signal, no route observed client
disconnect, and `AnalysisService.analyze` accepted none. The router now derives one from the
response's `close` event — the response, not the request, whose `close` fires as soon as the body is
received — and `analyze` combines a caller's signal with its timeout via `AbortSignal.any`,
combined and never substituted, so a caller can shorten a search but never lengthen it past the
deterministic ceiling. Every other route ignores it, exactly as before.

`AnalysisPort` is extracted so a request-scoped decorator can stand where the concrete class was
named; TypeScript compares classes with private members nominally, so a structural look-alike would
not have been assignable. Types only.

**Tests:** 18 service, 6 route, 7 controller, 5 mount. Twelve mutations run, twelve caught — and two
of those mutations survived the first pass, exposing a cost test that played the engine's own best
move (so the duplicate search it existed to check was never issued) and a legality test asserting
the wrong property.

Deferred: Study Partner (needs a durable `StudySessionStore` — table, port, adapter, migration, and
it embeds a whole `CoachingResponse` per turn), Voice Coach, Tournament Commentator, the LLM
narrative, Chess960, `studies.variant` CHECK → FK.

Detailed in `docs/adr/0129-coach-orchestration.md`.


## M15 Increment 20 — Endgame Trainer Productionization (ADR-0128)

The M8 `EndgameTrainer` was library-complete with no importer, API, capability or UI. It now runs
through `POST /v1/endgames/next` and `POST /v1/endgames/attempt`, with a dedicated `/endgames`
route in the web app.

Its engine is load-bearing, unlike the Opening Explorer's, so this borrows the API-owned
`AnalysisService` exactly as the Puzzle Generator does and adds no pool. It is stateless — no table,
no migration — and no AI provider is composed, so the coaching narrative and everything that
accompanies it stays off the wire.

**The learner is not handed the answer.** `TrainingPosition` carries a full solution — best move,
best line, evaluation, mate distance — and serving it beside the exercise would put the answer in
the response that asks the question. That is the defect ADR-0095 fixed for lesson steps, in the same
shape. `/next` publishes the position and the objective only and makes **no engine call at all**;
the engine's figures are reachable exactly once, through `/attempt`, after the learner has moved.
`EndgameTrainer.nextPosition` is deliberately unused for that reason.

**No authored number is published as a measured one.** Each entry carries an authored goal, and for
a mate an authored distance that nothing cross-checks against the engine. The wire carries the
objective (`mate`/`win`/`draw`) and the engine's own `mateDistanceAfter`; the authored distance
never leaves the dataset. Same decision as the opening statistics in ADR-0127.

Server-owned policy: `/attempt` takes `{ id, move }` and looks the entry up itself, so a client can
neither choose the position nor the goal it is graded against; standard chess only; fixed depth and
time with MultiPV 1; a UCI shape check before any engine work; only `IllegalMoveError` becomes a
422; an empty engine result answers 503 rather than throwing on `results[0]`; and one
`endgameTraining` bucket at 20/user and 40/IP covers both routes, sized for the two searches an
attempt costs.

Two library traps are contained rather than inherited. `legacyCpLoss` returns `Infinity`, which
`JSON.stringify` turns into an untyped `null`, so the wire carries
`loss: {kind:'centipawns',value} | {kind:'decisive'}`. And `BundledEndgameDatabase.random` falls
back to the first entry when a filter matches nothing, so the service filters the catalogue itself
and answers 422 instead of serving an endgame nobody asked for.

The UI is its own route rather than a game-sidebar section: every existing sidebar section is about
the position already on the board, and the board there belongs to the live game. Coach, Study
Partner and Voice Coach remain deferred; Coach is unblocked by this increment.

## M15 Increment 19 — Opening Explorer Productionization (ADR-0127)

The M8 `OpeningExplorer` was library-complete with no importer, API, capability or UI. It now runs
through `POST /v1/openings/explore` and the game sidebar's **Identify opening** action.

It is the first M8 productionization that borrows nothing: no engine, no AI provider, no second
subsystem. `OpeningExplorer` is constructed with a database and neither optional port, so no path
through it can reach an engine or a completion, and the feature answers in full on a deployment
that has neither. `openingExplorer` is consequently the one capability flag that neither implies
nor is implied by `analysis`; it is derived from the composed dependency, and an empty bundled
dataset composes to `undefined` so the flag reports the truth rather than a constant.

**The bundled statistics do not reach the wire, and that is the point of the increment.** The
dataset's own header says its `games`/`whiteWins` figures are "approximate aggregate figures for
illustration … not sourced from a specific database". Publishing them would put invented numbers in
front of a reader with nothing on the page to say so. The service returns a projection with no
statistics field, `OpeningContinuationView` publishes `additionalProperties: false` over exactly
`move`/`san`/`eco`/`name`, and the projection lives in the service rather than the presenter so
that dropping them is a property of the only path to the wire.

Server-owned policy: `standard` only (`variant` is required, so another variant is refused with a
422 instead of silently receiving an answer about a different game); the standard start position
only, with `initialFen` optional-but-checked because the gateway snapshot carries no start position
and no creation route accepts one today; a 60-ply ceiling that refuses rather than truncates; a UCI
shape check before any position is constructed; and an ordinary 60/user, 120/IP bucket charged up
front, since there is no expensive phase to admit into. Only `IllegalMoveError` becomes a 422 — any
other throw is ours and stays a 500.

Transpositions are not identified: `BundledOpeningDatabase.lookup` matches an entry whose moves are
a prefix of the submitted sequence, so `1.Nf3 Nc6 2.e4 e5 3.Bb5` returns "no known opening" while
`1.e4 e5 2.Nf3 Nc6 3.Bb5` returns C60. Pinned by a test rather than widened — position-keyed lookup
is a different dataset, and it is the corpus question again.

The sidebar reads `GameController.moveSequence`, which returns the whole UCI ledger from ply 1 or
`null` when it is not a contiguous run from the start. Opening statistics, a real corpus, engine
evaluation, LLM narrative, a transposition-aware matcher, and Chess960 remain deferred.

## M15 Increment 18 — Production Email Delivery + Token-Logging Hardening (ADR-0126)

The production API now requires one Resend transport instead of silently falling back to
`ConsoleEmailSender`. `PUBLIC_WEB_ORIGIN` is validated at startup and produces the existing
`/password-reset#token=...` and `/email-verify#token=...` fragment links. Helm supplies the API key
only through an existing Secret or External Secrets Operator reference; missing production email
configuration prevents startup.

Delivery has a bounded timeout and emits only fixed-purpose/outcome/latency metrics. Provider
bodies, credentials, recipient addresses, raw tokens and completed token URLs never reach logging
or metric inputs. The development console sender likewise prints only a suppression marker.

Reset and registration responses no longer await provider I/O. Reset stays externally identical
for existing and missing accounts even when delivery fails; registration stays successful after
the account transaction commits. Authenticated `POST /v1/auth/email/verification/request` provides
a rate-limited recovery path, and replacement issuance atomically invalidates prior unused tokens
of the same user/kind, including under concurrent Postgres requests. A durable outbox/queue remains
deferred.

## M15 Increment 17 — Puzzle Generator Productionization (ADR-0125)

The M8 `PuzzleGenerator` was library-complete but had no production importer, API, capability or
UI. It now runs through `POST /v1/analysis/puzzle` and the game sidebar's **Find tactic** action.

Production composition reuses the API-owned `AnalysisService` and engine pool. Each accepted
request makes exactly one fixed MultiPV-3 analysis call (at most one pool acquisition; a shared
cache hit can avoid fresh engine work), with depth 16 and a 1,000 ms wall-clock bound, and no AI
provider call. The client can send only FEN and variant; the 200 cp uniqueness rule and mate policy
are server-owned. A separate 20/user/minute and 40/IP/minute bucket is charged only after cheap
validation, variant support and terminal checks pass.

The response is a JSON-safe `puzzle | no_tactic | insufficient` union. Finite centipawn gaps and
mate relations are tagged separately; absent/invalid moves are `null`; partial engine output is
insufficient rather than being called quiet. No `Infinity`, `NaN` or `"(none)"` reaches JSON.
`puzzleGeneration` plus `puzzleVariants` makes availability agree with the configured engine set
and stays off when deployment ceilings cannot honor the fixed evidence policy.

The sidebar coalesces repeat clicks, does not retry the engine POST, and binds a result to exact
variant + FEN. Position changes abort and invalidate it; disposal suppresses stale completion and
remount clears persistent DOM state. Puzzle libraries, ratings, sharing, spaced repetition,
user-created puzzles, LLM hints/themes, voice, Chess960 and new engines remain deferred.

## M15 Increment 12 — Pinned Stockfish 16 in Production Images (ADR-0121, amended)

### Production was running an engine no test had ever exercised

Increment 11 pinned Stockfish 16 in CI. It left the production images installing whatever
`apt-get install stockfish` resolved to, which meant:

| | Stockfish version | chosen by |
| --- | --- | --- |
| CI, since Increment 11 | **16** | pinned release + digest |
| Production images, before this increment | **15.1-4** | Debian bookworm, at build time |
| Production images, once `node:22-slim` follows Debian to trixie | **17-1** | the same, with no commit of ours |

`node:22-slim` resolves to `22/bookworm-slim` → `FROM debian:bookworm-slim`; bookworm carries
`stockfish 15.1-4`, trixie carries `17-1`. So the engine behind `POST /v1/analysis`, the engine bot
and anti-cheat auto-analysis was both different from the tested one and a base-image bump away from
changing again on its own.

Both images now take the binary from a dedicated `stockfish` artefact stage pinning exactly what CI
pins — release `sf_16`, asset `stockfish-ubuntu-x86-64.tar`, archive SHA-256
`efca1c60ec11fd9628425f3ee40644ad1618535ddf881c16385a86f7fc9e0983`. Digest verified before
extraction, one member taken by exact path, `chmod` after that, `id name Stockfish 16` asserted in
the stage. Runtime stages take `COPY --from=stockfish` only, so the 41.6 MB archive never reaches a
shipped layer. `STOCKFISH_PATH` moves from `/usr/games/stockfish` to `/usr/local/bin/stockfish`.

**Redistribution is the one place the images do not copy CI.** CI *uses* the binary; `release.yml`
*publishes* the images to GHCR, and the Debian package being replaced carried its own licence
material. `Copying.txt`, `AUTHORS`, `README.md` and the corresponding `src/` tree are copied to
`/usr/local/share/stockfish/` beside the binary, for about 0.7 MB.

**A `docker-images` CI job now builds both images before merge** and, inside each, asserts the
binary runs, `ldd` resolves with no `not found`, the engine reports `id name Stockfish 16`, and the
licence material is present. `release.yml` builds these images only on a `v*` tag, so until now
nothing checked them until a release was already being cut. The job is gated on `Dockerfile*`,
`package(-lock).json` and `.github/workflows/`, since application code is compiled by `build-test`
already.

`scripts/check-engine-pin-parity.mjs` holds the four copies of the pin together — CI workflow, both
Dockerfiles, ADR-0121 — because the failure worth catching is a partial upgrade, which is exactly
the state described above.

**Measured on the built images** (`docker-images` job): `gambit-api` 275 MB and `gambit-gateway`
276 MB in total, of which Stockfish is 38.6 MB of binary plus 0.8 MB of licence and source — 39.4
MB against Debian's declared 46.2 MB `Installed-Size`, so roughly 6.8 MB smaller. The old images
were not rebuilt to weigh them, so that comparison is a measurement against package metadata
rather than like-for-like, and no exact total-image saving is claimed. `ldd` resolves every
library inside both images with no `not found`; `libstdc++6` is already present in `node:22-slim`,
so nothing had to be installed to replace what the Debian package used to pull in.

**Rollout note:** 15.1 → 16 is a real behavioural change in production, made deliberately to align
it with the tested version. Evaluations may legitimately differ between engine versions; no claim is
made that they will not. What is asserted is capability — MultiPV, `cp`/`mate` scores, UCI principal
variations, `movetime` honoured — which is what the analysis composition depends on.

Fairy-Stockfish remains out of production, unchanged.

## M15 Increment 11 — Deterministic Stockfish Installation in CI (ADR-0121)

### One step in one job was costing more than everything it enabled

`analysis smoke (real Stockfish + Fairy-Stockfish)` installed its two engines by different means:
Fairy-Stockfish from a pinned, checksummed release asset; Stockfish from `apt-get install`, with no
version pin, no integrity check and no identity assertion. Measured over the thirty runs before this
change:

| statistic | `Install Stockfish` (apt) | `Install Fairy-Stockfish` (pinned) |
| --- | --- | --- |
| median | 18.5s | 0–1s |
| mean | 184s | ~0.5s |
| p90 | 460s | 1s |
| max | 2060s (34m, cancelled by hand) | 1s |
| over 60s | 10 / 30 runs | 0 / 30 |
| over 180s | 8 / 30 runs | 0 / 30 |
| total | 92.2 minutes | ~20s |

The test that step exists to enable takes **ten seconds**. The failure mode is not a fast crash but
unbounded tail latency, and the job inherited GitHub's six-hour default timeout, so a stall burned
Actions minutes until a human noticed — which is exactly what the Increment 9 infrastructure
exception below records.

Stockfish now arrives the way Fairy already did: release `sf_16`, asset
`stockfish-ubuntu-x86-64.tar`, SHA-256
`efca1c60ec11fd9628425f3ee40644ad1618535ddf881c16385a86f7fc9e0983`, one member extracted by exact
path, `chmod` only after verification, then `id name Stockfish 16` before the suite runs. `sf_16` is
the same version the mirror was serving (`stockfish 16-1build1`), so the engine under test is
unchanged — only how it arrives. See [ADR-0121](adr/0121-deterministic-engine-install-in-ci.md).

Two details worth keeping: all three `sf_16` Linux assets are **byte-for-byte the same size**, so the
digest is the only thing distinguishing the baseline build from the `-modern` and `-avx2` ones (the
archive member name is a second, independent guard); and the NNUE net `nn-5af11540bbfe.nnue` is
embedded in the binary, so there is no second download.

The job also takes an explicit `timeout-minutes: 15` — about twelve times a healthy 72-second run,
wide enough not to trip on a cold cache, narrow enough that a future stall cannot consume hours.

`apt-get` no longer appears in any executable line of any workflow. `Dockerfile.api` and
`Dockerfile.gateway` still install Stockfish through apt and are deliberately untouched — but the
precise reason matters, and an earlier draft of this section got it wrong. `ci.yml`, the workflow
that runs on pull requests and on `main`, does not build those images, so they were never part of
the measured failure path. `release.yml` **does** build both, on a `v*` tag push, and those builds
still run the apt layers. `chaos.yml` builds no image at all. So the mirror dependency survives in
the release path; it is out of scope here because it is a different workflow on a different
trigger with its own rollout and image-size trade-offs, not because it does not exist. Raised in
the Qodo review of PR #142.

## M15 Increment 10 — Variant List Parity Guard

### The set of supported variants is written out seven times and nothing derived from anything

Increment 9 added `studies.variant`, and with it a seventh independent copy of the same eight
variant codes:

| # | Location | Form |
| --- | --- | --- |
| 1 | `packages/chess-core/src/types.ts` | `Variant` union — **the root**, what the engine branches on |
| 2 | `packages/api/src/domain.ts` | `VARIANTS` array |
| 3 | `packages/studies/src/model.ts` | `StudyVariant` union |
| 4 | `packages/ai-features/src/mistake-predictor.ts` | `SUPPORTED_VARIANTS` set |
| 5 | `packages/web/src/api/models.ts` | `VARIANTS`, documented as "matches the server's enum" |
| 6 | `packages/persistence/migrations/0001_init.sql` | `variants` lookup table rows |
| 7 | `packages/persistence/migrations/0022_study_variant.sql` | `CHECK (variant IN (...))` |

The sharp edge is #7 against #6. Every other variant column in the schema is
`variant TEXT NOT NULL REFERENCES variants(code)`, so once a row exists in the lookup table the
**database** accepts that value in the games and ratings columns. `studies.variant` alone uses an
inline `CHECK`, so the same row does nothing for studies. This is a claim about storage only —
the application declarations (#1 to #5) still need their own updates either way; the lookup row
settles what Postgres will hold, not what the platform will offer.

**The type system does not catch this, and neither did anything else.** Measured, not assumed: a
ninth variant was added to all five TypeScript sites, to `VARIANT_LABELS`, and to the `variants`
lookup table, leaving only the `CHECK` untouched. `npm run build` exited 0 and `npm run lint` was
clean. The test suite then reported exactly **one** failure, and it was the wrong one:
`openapi.json` was stale. That says "regenerate me", not "the database will reject this" — so a
developer runs `npm run openapi`, which is the obvious next step, and on the following run the
API suite passed at 579 tests with nothing left red anywhere. The variant would then fail as a
constraint violation in production, on the first study created with it.

`scripts/check-variant-parity.mjs` compares all six mirrors to the root and names each
disagreement. It runs in CI beside the other static guards and in `scripts/ci-local.mjs`, and
costs milliseconds.

Two properties it needs, both raised in the Qodo review and both pinned by
`scripts/test/check-variant-parity.test.mjs`:

- **The SQL sources are replayed, not read as files.** Applied migrations are checksummed and
  immutable (`pg/migrate.ts`: "history is immutable"), so a ninth variant arrives in a *new*
  migration and 0001 and 0022 never change. A guard that compared against those two files
  directly would fail forever on a correct change, and could only be satisfied by editing an
  applied migration — which aborts migration on every existing deployment. Both are therefore
  accumulated across the whole directory: lookup rows summed in applied order, the study
  constraint taken from the last migration to define it. Verified end to end — adding the variant
  through a new `0023` and replacing the constraint in a new `0024` satisfies the guard with 0001
  and 0022 untouched. "Applied order" means `pg/migrate.ts`'s own plain lexicographic `.sort()`,
  not a numeric one: the two coincide under this repository's zero-padded names, but sorting
  numerically would replay `9_x` before `10_y` and model a database that never existed. A test
  asserts the runner still sorts that way, so the two cannot drift apart quietly.
- **Only statements naming `studies` decide the study constraint.** Testing each migration file as
  a whole let any other table move the answer — a `variant` CHECK on some other table would
  overwrite it, and a `REFERENCES variants(code)` elsewhere in the same file (how games and ratings
  are already declared) would clear it, silently dropping the mirror. Detection is per statement,
  scoped to `CREATE TABLE studies` / `ALTER TABLE studies`, with a quote-aware splitter so a `;`
  inside a string literal does not end a statement. Raised in the CodeRabbit review.
- **Comments do not count.** Matching quoted tokens in raw source treated a commented-out entry as
  live, so `// 'atomic',` in the API list left the guard green while the array no longer held it.
  Every region is comment-stripped first, with string literals respected so a `--` or `//` inside
  one is not mistaken for a comment.

If a later migration converts `studies.variant` to `REFERENCES variants(code)`, that mirror stops
being an independent list and the guard skips it rather than demanding one — so the deferred
conversion below needs no change here when someone makes it.

Two lists are deliberately **not** checked, because they are not independent copies:
`packages/api/openapi.json` is generated (`enum: [...VARIANTS]`) and already pinned by
`openapi-nullability.test.ts`; `OFFERED_VARIANTS` in the web client is a deliberate subset
(ADR-0099 withholds `chess960`) pinned by `create-game-prefs.test.ts`. Requiring equality of
either would fight a decision already made.

### Decided and not done: `studies.variant` stays a CHECK, for now

Converting it to `REFERENCES variants(code)` would make studies consistent with games and ratings
and remove copy #7. It was considered and deferred, because **it does not fix the failure mode**:
adding a variant to the types without adding the `variants` row still fails at runtime, a foreign
key rejecting it exactly as the `CHECK` did. The guard is what closes that, and it covers the
lookup table either way. A schema migration on a table that shipped days ago, for a consistency
gain the guard already secures, is not worth the rollout risk in this increment. Recorded as a
candidate rather than carried out.

### Post-merge CI exception carried over from Increment 9

The `analysis smoke (real Stockfish + Fairy-Stockfish)` job on merged `main` (`cbe6bce`) did not
complete. It stalled in the Ubuntu `apt-get` / package-mirror step on both the original job
(`96156044656`) and a single-job rerun (`96200357632`), the rerun cancelled after ~34 minutes to
stop burning Actions minutes. Both stalls happened **before** Fairy-Stockfish was installed,
before any real-engine smoke test, and before any Increment 9 code executed — the other seven
jobs passed.

This is recorded as a **post-merge CI infrastructure exception, not a project-code failure**. The
pre-merge exact-HEAD gates were clean (Qodo and CodeRabbit both on `127cbda`, CI green), and the
real Fairy-Stockfish smoke was independently validated locally against Fairy-Stockfish 14, 5/5,
with the pinned artifact checksum verified from a fresh download. Increment 9 was **not** modified
to work around the mirror. Removing the `apt` dependency is tracked separately; see ROADMAP.

## M15 Increment 9 — Lossless Three-check FEN and Fairy-Stockfish Interoperability (ADR-0120)

### Review follow-up: the variant now survives study persistence and coaching composition

CodeRabbit identified that a canonical Three-Check FEN could still lose its counters after entering
a study: the study model, PostgreSQL row, `PositionReader`, PGN import and append paths carried no
variant. Migration `0022_study_variant.sql` adds a constrained `variant` column with a `standard`
default for existing data and mixed-version inserts. Study creation, chapter validation, append,
PGN import/export, REST, GraphQL and OpenAPI now use the persisted rule set. Regression tests append
`Re1+` to a `3+3` study position and require `2+3` after both the in-memory and PostgreSQL paths.

`CoachRequest` also carries the variant through mistake prediction, move explanation, puzzle
generation and model grounding; `CoachingResponse` retains it for Voice Coach's FEN parsing and UCI
verbalisation. The CI Fairy-Stockfish download already uses `curl --fail` and verifies the release
asset against the SHA-256 pinned in ADR-0120.

Increment 8 stopped `Position.snapshot()` losing the three-check counters. This makes the FEN
carry them, and closes the engine defect the missing field had been causing.

### Fairy-Stockfish reads a missing counter field as "one check remaining", not "none delivered"

Measured against **Fairy-Stockfish 14**, the release the plugin already declares as its minimum:
a bare six-field three-check FEN is understood as `1+1` — either player wins with a single check.
The Italian Game under `3check` came back **`score mate 1`** on the six-field FEN and a real
six-ply line on the canonical one. Every three-check evaluation the platform could produce was
reporting a forced mate that does not exist.

Not reachable in production, and the reason is worth recording rather than assuming: no deployment
sets `FAIRY_STOCKFISH_PATH`, the images install only vanilla Stockfish, and `configuredPlugins()`
registers only engines with a configured binary — so `threecheck` currently answers `422
unsupported variant`. The defect was waiting for the day someone deployed Fairy.

### The contract

The canonical field is `N+M`, in **field five** between the en-passant square and the halfmove
clock, counting **remaining** checks down from three, White first. That is what the engine emits;
it was read off the real binary rather than assumed. `toFen` now emits it for `threecheck` and
leaves the other seven variants at six fields. `parseFen` accepts the canonical form, the trailing
`+N+M` delivered form Fairy also takes, and the legacy six-field form (meaning none delivered),
and canonicalises on output. Malformed or out-of-range counters throw rather than falling through
to the legacy reading, which would shift the clocks one position and rewrite the fifty-move state.

Internal state still counts checks **delivered**; the FEN counts **remaining**. That inversion
lives in one module, `packages/chess-core/src/check-counters.ts`, so `3 - x` appears nowhere else.

`AnalysisService` re-serialises three-check FENs before they reach a provider. `toFen` alone was
not enough — the analysis API takes a FEN *from the caller* and forwarded it verbatim, so a client
sending the legacy form would still have reached Fairy as `1+1`.

### Rolling deployment, mapped rather than assumed

The canonical field shifts the clocks right, and an older parser reads `N+M` as the halfmove clock.
Game events remain safe because no production path supplies a custom `initialFen`; the start
position reads to a byte-identical state under the old parser. Studies now persist their variant,
so rollout order is migration, all API instances, then non-standard study creation. The additive
column defaults old rows and old-process inserts to `standard`. Gateway pub/sub forwards FENs
without parsing, repetition keys use fields 0-3 plus their own counter component, and the web study
helper uses the transported variant to distinguish canonical, legacy and trailing Three-Check
layouts. A guard test fails the build if another file starts indexing FEN clock fields unnoticed.

### Consequences

Three-check analysis-cache entries stored under the old counterless FEN become unreachable — they
held evaluations made with the wrong counters, so that is the point. `fenHash` now changes when a
check is delivered, where a repeated board previously hashed identically. Stored FEN columns remain
`TEXT` and need no rewrite; migration `0022` only adds the study variant with a `standard` default.
Production Fairy deployment stays out of scope; CI provides the binary so the contract is tested.

### Guards

- `packages/chess-core/test/threecheck-fen.test.ts` — round trips for every delivered pair, clock
  positions in all three spellings, canonicalisation on output, refusal of malformed and
  out-of-range counters, and the other seven variants unchanged.
- `packages/chess-core/test/fen-field-index-guard.test.ts` — no new file may read FEN field 4 or 5
  by index without joining an audit list that must stay accurate.
- `packages/api/test/threecheck-engine-fen.test.ts` — what leaves the service, cache-key
  separation, and the validator still refusing malformed counters and newline injection.
- `packages/realtime-gateway/test/threecheck-fen-hash.test.ts` — a delivered check changes the
  position hash even with the board unchanged.
- `packages/api/test/analysis-fairy-threecheck-smoke.test.ts` — the real binary, env-gated like the
  Stockfish smoke test, asserting semantic engine state rather than centipawn values.
- Verified by mutation: ten mutants, all caught by tests rather than by the compiler.

## M15 Increment 8 — Three-check State Preserved Across `Position.snapshot()`

A one-line production change that fixed a wrong game result, and a correction to three documents
that had recorded the bug as harmless.

### A three-check game could be drawn while a player was one check from winning

`repetitionKey` in `packages/chess-core/src/repetition.ts` folds the delivered-check counters into
the key for `threecheck`, and it is right to: a player wins on the third check, so two identical
boards are different positions if one side is two checks closer to winning. But the key is built
from `Position.snapshot()`, which round-tripped through FEN — and FEN is the six standard fields,
which do not include the counters. Every three-check position therefore reported `0+0`, and the
counters could never tell two keys apart.

The result was a lost game, not a lost annotation. From `4k3/8/8/8/8/8/8/3R3K w - - 0 1`, the line
`Re1+ Kf8 Rd1 Ke8 Re1+ Kf8 Rd1 Ke8` returns the board to its start three times while White delivers
two checks. The three occurrences are genuinely different positions — `0+0`, `1+0`, `2+0` — but all
three keys read `0+0`, so the game was declared a **threefold draw** with White one check from
winning. It now continues, and White wins **1-0 on the third check**. Both the live path
(`Game.playMove`) and the replay reducer build the key from the same snapshot, so both were wrong
together, and both are now right together.

### The fix, and what it deliberately does not do

`Position.snapshot()` returns `cloneState(this.state)` — the existing authoritative deep copy in
`packages/chess-core/src/fen.ts` — instead of `parseFen(this.fen(), variant)`. No field is
hand-copied and no second clone helper was introduced, so the one place that knows what a
`PositionState` contains stays the one place that has to be updated when it gains a field.

Serialising the counters into FEN is **not** part of this. That needs a seventh field, a decision
between the "checks delivered" and "checks remaining" conventions, and agreement with
Fairy-Stockfish, which is an external interoperability question. It is deferred to M15 Increment 9
so a live wrong-result bug did not have to wait on it.

### The documentation was wrong, and is corrected rather than quietly rewritten

ADR-0099 §4, `docs/ROADMAP.md` and this file all recorded the loss as "latent, not live", reasoning
that a repetition key uses only the first four FEN fields. It does not, and had not since
2026-07-13 — three weeks before the Increment 33 audit that wrote that sentence. The audit read
`repetition.ts`'s summary docblock, which said the first four fields; its code appended the
counters three lines further down. That docblock now says what the code does, and says why the
distinction matters. The original assessment is left in place in ADR-0099 with a dated correction
beneath it.

### Guards

- `packages/chess-core/test/snapshot.test.ts` — the counters survive a snapshot; every
  `PositionState` field is present, asserted against the field list so a new field that is not
  cloned fails here; the snapshot is detached, proven by writing over `board`, both pockets and
  both counters and re-reading the position; and all eight variants round-trip.
- `packages/game/test/threecheck-repetition.test.ts` — `0+0` / `1+0` / `2+0` produce three distinct
  keys; identical boards with identical counters still collide, so repetition remains reachable; the
  reproduced line no longer draws and is won on the third check; a knight shuffle with no checks
  still draws by threefold; and replay reproduces the live counters, result and repetition map.
- Verified by mutation: reverting `snapshot()` to the FEN round-trip, zeroing the counters in the
  clone, aliasing the counters, aliasing the Crazyhouse pockets, and dropping the counters from
  `repetitionKey` are each caught. A sixth composite mutant weakens the headline key assertion *and*
  reintroduces the defect, and is still caught by the game-path tests — the regression does not rest
  on a single assertion.

## M15 Increment 7 — Deterministic PostgreSQL Concurrency Synchronisation (ADR-0119 follow-up)

Test-infrastructure hardening. No production code changed: the limiter, the port, the SQL and the
HTTP contract are untouched.

The bucket-creation-race test from Increment 6 sequenced its race with `setTimeout(…, 300)`. A
sleep cannot fail loudly — if the losing statement had not reached the server before the holder
committed, the race did not happen and the test passed anyway, because both orderings end with the
same stored row and the same refusal. The test written to prove the snapshot fix could go green
without exercising it, and would be likeliest to do so under CI load. Raised as a nitpick in the
CodeRabbit review of PR #137 and carried forward deliberately rather than dropped.

It is now sequenced on PostgreSQL itself. `packages/api/test/pg-observer.ts` polls
`pg_stat_activity` from a third connection and resolves only when the backend running the
admission is reported blocked, on a `transactionid` lock, **by the backend holding the row** —
all three, since `wait_event_type = Lock` alone would match a lock the test never created. The
conflict is a transaction-id lock rather than a row lock, which is what PostgreSQL actually
exposes and was verified against 16.14 rather than assumed. The limiter runs on a `max: 1` pool so
the backend under observation is known by identity instead of guessed.

The wait is bounded by a ceiling outside the polling loop — checking the clock only between polls
bounds nothing when a poll itself hangs, which `pg-observer.integration.test.ts` pins by occupying
the observer pool's only connection so no poll can return. It throws with diagnostics: expected
backend, expected blocker, last observed state, elapsed, polls, and deliberately without query text
or connection strings, so a CI failure prints no credentials. The bound is a ceiling, not a
duration: the blocked state becomes visible in 2-3 ms, on the first poll, so the test also got
faster than the sleep it replaced.

**Proof it has teeth.** Seven breaking mutations are caught (deleting the wait; an observer that
returns without observing; watching the wrong backend; committing before observing; treating the
timeout as success; moving the ceiling back inside the polling loop; dropping the requirement that
the lock row be visible). Two controls survive on
purpose, and the second is the finding: with no
synchronisation and the holder committing before the admission is issued — the race made
impossible — the test still passes. That is direct evidence the sleep-based version could report
success having proved nothing.

Verified against a real PostgreSQL 16.14 server: 25 consecutive clean runs, 8 more under
deliberate CPU contention, and no leaked sessions or idle-in-transaction rows afterwards.

## M15 Increment 6 — Contract and Rate-Limit Correctness (ADR-0119)

A hardening increment, no new product surface. Two cross-cutting defects, both of which every
existing test passed straight through because in each case the tests asserted the behaviour the
defect did not change.

### 1. The published contract described 47 fields as non-nullable, and sent them null

`packages/api/openapi.json` says `"openapi": "3.1.0"`, and 47 of its fields carried
`nullable: true` — an OpenAPI **3.0** keyword. 3.1 is JSON Schema 2020-12, which has no such
keyword and ignores it, so the document was not describing those fields as nullable; it was
describing them as strictly non-null with an annotation nobody reads. A generated client typed
`PublicUser.country` as `string` and was wrong for every user without one, and
`MistakePredictionResponse.centipawnLoss` as `integer` — the very field ADR-0118 had gone to
trouble to make honestly nullable on the server.

Two of the 47 were wrong twice over: `LiveBoard.status.winner` and `TeamDetailView.viewerRole` are
nullable **enums**, and `enum` is an independent constraint rather than a refinement of `type`, so
`{type: ['string','null'], enum: ['w','b']}` still rejects `null`. Widening the type alone would
have moved the lie rather than removed it.

Fixed by removing `nullable?: boolean` from the `JsonSchema` interface entirely — the keyword is
now **unrepresentable**, and `tsc` is the guard — and replacing it with one `nullable(schema)`
builder in `packages/api/src/openapi/types.ts`: type union for a typed schema, `null` appended to
the enum where there is one, `anyOf: [ref, {type: "null"}]` for a `$ref`. All 47 sites converted,
`openapi.json` regenerated by `npm run openapi` and never hand-edited. No `required` array moved:
optional and nullable are different axes, the document contains all four combinations, and the
generated diff was verified key by key to be exactly the type-union rewrite.

Also closed: nothing had ever verified that the committed `openapi.json` matched what the server
serves. It does now, by test.

### 2. Multi-bucket rate limiting charged the first bucket before asking the second

`RateLimiter.check(key, limit)` decided and consumed in one step, so a route guarded by two
buckets called it twice — and a request the second bucket refused had already spent the first
one's quota. Six routes had that shape: `/v1/auth/login`, `/v1/auth/password-reset/request`,
`/v1/auth/webauthn/login/options`, `/v1/analysis`, `/v1/analysis/mistake-prediction` and
`/v1/ai/move-explanation`.

The victim is concrete: on a shared NAT the per-IP bucket saturates from collective traffic, and
every co-located account then burns its own private quota at full speed on requests that never
run. Reversing the order only moves the victim — one abusive account would drain the shared bucket
before its own limit stopped it.

Fixed by replacing `check` with `admit(requests)`, which takes every bucket at once. **`check` was
deleted, not kept alongside**: with no single-key consuming method on the port, sequential
multi-bucket consumption is not expressible — the same structural move ADR-0118 used to make a
second engine pool unrepresentable. `InMemoryRateLimiter.admit` is synchronous, which is where its
atomicity comes from; `PgRateLimiter.admit` uses one transaction with **sorted** keys (row locks
taken in a total order, so concurrent requests wait instead of deadlocking) and rolls back if any
bucket refuses. A single bucket keeps the one-statement path — already atomic, and
`/v1/auth/refresh` is the hottest limited route.

On Postgres each bucket is a *conditional* upsert whose WHERE clause lets the write happen only if
the request fits, so a refusal returns no rows and stores nothing; the transaction sets lock and
statement timeouts so a stuck admission cannot hold a pooled client indefinitely. A key may appear
at most once in one admission — the earlier per-entry charging rule was not order-independent when
the two entries carried different limits.

`Retry-After` on a multi-bucket refusal is now the **longest** wait among the buckets that
refused: order-independent, and it does not send the client back to a second refusal. Status
codes, error codes and body shapes are unchanged.

A third instance turned up in the same audit and was fixed with it: `/v1/analysis` charged quota
**above** its body parsing, so malformed requests that reach no engine still cost a slot. It now
validates first, like the two endpoints written after it. `/v1/auth/register` keeps its charge
above validation deliberately — bounding attempts from an address whether or not they parse is the
point of a registration limit, and it is single-bucket.

### Guards added

- `packages/api/test/openapi-nullability.test.ts` — zero `nullable` keys in the served document,
  each shape pinned, all four optional/nullable combinations asserted, every nullable schema
  checked in bulk with the count pinned at 47, and the committed artifact asserted equal to the
  generator output.
- `packages/api/test/rate-limit-atomicity.test.ts` — all-or-nothing in both directions, order
  independence, longest-wait retry, concurrent race for the final slot, and the defect end-to-end
  on `/v1/auth/login` and `/v1/analysis`.
- `packages/api/test/rate-limit-structure.test.ts` — one `rateLimiter.admit` call site, no handler
  admits twice, each multi-bucket route names both buckets in one call, expensive routes parse
  before they charge.
- `packages/api/test/pg-security.integration.test.ts` — the same properties against a real
  PostgreSQL server under concurrency, including the opposite-order key pair that would deadlock
  without the sort.

## M15 Increment 5 — Mistake Prediction (ADR-0118)

Took the M8 `MistakePredictor` — library-only since it was written, with no importer outside its own
two test files — and made it a product: `POST /v1/analysis/mistake-prediction` plus an "Assess last
move" control in the Engine panel, beside "Explain last move".

### Six defects the investigation found, four of them correctness

- **The variant never reached the rules engine.** `Position.fromFen(request.fen)` with no variant,
  while `variant` went separately to the engine. Legality, the resulting FEN and any adjudication ran
  under *standard* rules on Atomic, Horde and Racing Kings positions the engine was analysing as
  themselves. One request, two disagreeing opinions about which game was being played.
- **Delivering checkmate was classified as a `blunder`.** It always ran a post-move search; a decided
  position answers with the ADR-0116 `{ cp: 0, depth: 0 }` placeholder; negated and subtracted from a
  winning `evalBefore`, mate-in-one scored as a several-hundred-centipawn loss.
- **`centipawnLoss` could be `Infinity`**, which `JSON.stringify` renders as `null` — the same
  absence with none of the intent, and no way to tell it from a field never set.
- **Legacy `chess` vocabulary**, which `parseVariant` rejects and no engine pool matches. Its tests
  asserted `chess` too, so the suite was evidence *for* the defect rather than against it.
- Classification thresholds were caller-supplied, and grounding was built twice — the `MoveExplainer`
  defect removed in ADR-0115, still present here.

Plus two structural: `engine` was a **required** option, so the class could not be composed without
one; and `resultsBefore[0].evaluation` was indexed unguarded, which compiles because this package has
no `noUncheckedIndexedAccess` and throws at runtime on an empty result set.

### No AI provider, deliberately

"Explain last move" already ships in the same panel, reads the same target, and already writes
engine-grounded prose about that exact move. A second paid completion producing a second paragraph
six pixels away is duplicate spend with no distinct role — so the coaching call is dropped and
**provider calls per request is 0**. The payoff is reach rather than saving: the capability now
depends on the engine alone, so any deployment with an engine gets the whole feature, where Move
Explanation needs both halves and goes dark without either.

### Contract

- `classification`: `ok | inaccuracy | mistake | blunder`, thresholds fixed server-side at 50/100/300
  cp with no request field and no env override. No `brilliant`/`great`/`excellent` — those are claims
  about *why* a move is good that no centipawn difference supports.
- `after` is tagged `evaluation | terminal` (ADR-0116). `centipawnLoss` is `number | null`, never
  `Infinity`. **A draw is the one terminal result with a real measure** — zero is exactly where the
  engine's own scale puts an equal game — so throwing away +5.00 into stalemate is a 500 cp blunder
  while holding a draw from −8.00 reads as `ok`. A win and a loss report no number rather than an
  invented one. "Already being forcibly mated" outranks everything but winning: the move cost nothing
  when every move loses.
- `bestMove` is nullable, never `(none)`. Equality with `move` is how "you found the engine's own
  choice" is expressed — no second boolean that could disagree with it.
- **Cost: 0 engine searches rejected, 1 when the move ends the game, 2 otherwise.** All three pinned
  by tests. Quota charged after validation and before any search. Its own bucket, 20/min per user and
  40/min per IP. No capacity claim.
- Under `/v1/analysis/` rather than `/v1/ai/`, because the prefix is a claim about what serves the
  request and no provider does.

### UI

One control, one panel, no new route, no second capability fetch. The verdict is rows of structured
fields and **no prose at all** — nothing is parsed out of a sentence, because no sentence is fetched.
**The classification is a word, never a colour**, following DESIGN.md's worked example for
achievement tiers; a blunder in particular never borrows Ember, which means the *application* failed.

`ExplainController` and `AssessController` now share one `MoveRequestController`, and both read one
`lastMoveTarget()`. The single defect the independent review of PR #135 found was a copy-paste
divergence between two hand-maintained copies of that lifecycle; a third copy would have been a third
chance at it.

- **Tests**: request shape (three fields, nothing else), previous-FEN targeting, promotion suffix,
  classification and terminal rendering, the capability gate, the variant-gate race, signed-out,
  429/503/422 as muted states, stale suppression on a further move, resync invalidation, disposal,
  remount non-stacking, repeat-click deduplication, CSS contract for the aligned figure column and
  the word-not-colour rule, and Explain still working alongside Assess.
- **API tests** pin the 0/1/2 search counts, FEN injection reaching no engine, an already-decided
  position costing nothing, the legacy `chess` rejection, policy fields rejected by `strictObject`,
  quota charged after validation, and no engine detail in any error body. One test drives the same
  position and move under three variants and gets three different answers.

Not covered: no arbitrary past-move assessment, no whole-game accuracy summary, no cost dashboard, no
capacity claim, no client-disconnect cancellation. Repetition is still not adjudicable from a bare
FEN. The other seven M8 features remain library-only.

_Prior: 2026-08-18 — M15 Increment 4: terminal-position semantics, and Move Explanation in the UI._

## M15 Increment 4 — Terminal semantics + Move Explanation UI (ADR-0116, ADR-0117)

Two pieces, in order: fix a correctness defect the merged Increment 3 exposed, then build the UI on
top of the fixed contract.

### Decided positions are results, not `+0.00` (ADR-0116)

A position with no legal moves gives a UCI engine nothing to score, so it answers `bestmove (none)`
with no `info` line and `assembleResults` substitutes a placeholder `{ cp: 0, depth: 0 }`. Sound
internally; a lie once served. **Checkmate was reported as `+0.00`, dead level** — by `POST
/v1/analysis` since ADR-0113, and by Move Explanation, which grounded its prose in the same number.
Found in the independent review of the merged PR #134.

- **Adjudicated at the API boundary**, delegating to `Position.status()` — already authoritative and
  variant-aware. `EngineResult` semantics are untouched, because anti-cheat and the bot mover consume
  them too.
- **No second terminal implementation.** "Zero legal moves" would look equivalent and is not: a King
  of the Hill win with material on the board is over *and* has legal moves, and standard rules call
  the same position ongoing. A test pins that pair.
- **Explicit discriminator, no sentinel.** `AnalysisResponse.terminal` (with `lines: []`), and a
  tagged `citation.moveOutcome` (`evaluation` | `terminal`). `reason` mirrors core's `GameStatus`;
  `result` is the existing `ResultString`. This changed the `citation` shape ADR-0115 published hours
  earlier — correctness over preserving a false evaluation.
- **The cost contract is now conditional:** 0 searches rejected, **1** when the move ends the game,
  **2** otherwise. All three pinned by tests; ADR-0115's flat "exactly two" is superseded.

### Explain last move (ADR-0117)

The endpoint became reachable: a single control in the existing Engine panel, no new route and no
second capability-fetch mechanism.

- **Evidence above prose, in separate elements.** Every number comes from `citation`; a test feeds
  contradictory numbers in the prose and asserts the evidence still matches the engine.
- **The promotion suffix is kept.** `onLastMove` drops it because a highlight needs two squares, and
  reusing that is the obvious way to build this — but `e7e8q` and `e7e8n` are different moves, and a
  bare `e7e8` is not legal UCI at all.
- **Known limit:** only moves the client itself replayed can be explained. The snapshot is
  authoritative at its own ply and `MoveView` carries no per-move FEN, so joining mid-play has
  nothing to explain until the next move. Accepted rather than worked around — the alternative is a
  parallel move-history model or a starting position Chess960 does not have.
- Same lifecycle as the analysis panel: generation guard, `AbortController`, `settle()` before
  terminal callbacks, reset at mount, stale results withdrawn.

Not covered: arbitrary past-move navigation, streaming, cost display, the other seven M8 features.

_Prior: 2026-08-17 — M15 Increment 3: Move Explanation productized as an API capability._

## M15 Increment 3 — Move Explanation API (ADR-0115)

Turned `MoveExplainer` from library code into a reachable product capability:
`POST /v1/ai/move-explanation`, authenticated, rate-limited per user, engine-grounded.

**The starting position was worth recording.** M8 is marked complete in the ROADMAP and shipped eight
AI features — as a *library*. Before this increment nothing outside `@chess-platform/ai-features`
imported it, `new AiOrchestrator` appeared only in that package's own tests, and there was no
env-driven AI configuration anywhere in the repo. The roadmap entry was true about the domain layer
and silent about composition. ADR-0115 records the distinction; `FEATURE_PARITY_AUDIT.md` had already
said "Library/test implementation only" and needed no correction.

- **No second engine pool.** The service calls the existing `AnalysisService` from ADR-0113,
  inheriting its limits policy, FEN validation, timeout, queue and pool. `MoveExplainer` is composed
  **without an engine at all** (`engine` is now optional), so a second pool is not discouraged — it
  is unrepresentable.
- **Two defects fixed in the M8 library.** Grounding was applied *twice*: the explainer built grounded
  messages and also passed `grounding`, which `AiOrchestrator.complete` renders again. The covering
  assertion was `systemMessages.length >= 1`, true of one copy and of two. And `EngineGrounding`
  carried no variant, so the model was never told which rules applied and two variants sharing a
  FEN + move + eval collided on one cached explanation. Both fixed at the owning layer; both
  mutation-verified. The other seven features have the same grounding shape and remain library-only —
  a known follow-up, not a discovery.
- **Three-field request body.** `fen`, `variant`, `move`. `strictObject` rejects everything else, so
  no caller can reach a model, provider, temperature, token count, cost ceiling, latency budget,
  depth or movetime. All are fixed at composition time, each env var clamped to the compiled default
  as a ceiling. `side` is derived from the FEN, never accepted.
- **The move is analysed, not just the position.** The first cut validated the requested move and
  then analysed the *unchanged* position, so with `multiPv: 1` the citation described whatever the
  engine would have played — a quiet move showed the eval of a tactic never made, a blunder showed
  the eval of the best reply. Grounded, in facts about a different move. `Position.play` already
  returned the resulting position and the code discarded it. Each request now runs **two** searches,
  before and after, both normalised to the mover's perspective (mate scores included); the gap
  between them is the judgement. Raised by Qodo on PR #134.
- **Bounded amplification.** Two engine searches and at most `maxFailoverAttempts` provider calls
  (default 2), each under a 15s budget. Auth, variant support, FEN validity and **authoritative move
  legality** (`Position.play`) resolve before either subsystem is touched, and the rate limit is
  charged *between* them via an `onAccepted` seam — so a malformed or illegal request costs a move
  generation and none of the caller's 10/min budget.
- **Opaque provider failures.** Every `toHttpError` branch returns a fixed string; `AiError.message`
  is built from the vendor's response body and is never forwarded. All map to 503, including
  `auth_failed` — a rejected key is our misconfiguration, and 401 would be a false claim about the
  caller's credentials.
- **Composition does no I/O.** Capabilities are registered statically rather than discovered over
  HTTP, so boot cannot depend on a vendor being reachable; a test fails if `fetch` is called during
  composition. No `AI_*` variables means nothing is composed — there is no fallback vendor.
- **Capability implies analysis.** `moveExplanation` is true only when both halves exist; "AI but no
  engine" composes nothing rather than degrading to an ungrounded opinion. Its servable variants are
  exactly `analysisVariants`, asserted rather than duplicated.

Not covered: no UI (Inc 4), no cost accounting, no client-disconnect cancellation, no capacity
claims, no paid provider in CI, and the other seven M8 features stay library-only.

## M15 Increment 2 — Engine Analysis UI (game sidebar)

Design mode: **Operate** (ADR-0114) — the visitor is reading an evaluation with a game in front of
them, so scanability and staying out of the board's way outrank expression.

Made `POST /v1/analysis` reachable from a browser. Increment 1 shipped the endpoint with no UI, so
the capability existed and nothing consumed it. This is analysis visualisation and interaction only —
no AI feature, and no board preview of the principal variation.

- **Surface (`packages/web/index.html`, `game-mount.ts`)**: a panel in the existing game sidebar
  rather than a new route. The board, the live FEN and the variant are already there —
  `GameController` exposes `get fen()` and an `onPosition` callback — so analysis needs no new state
  source, no router change and no second board. `bootstrap.ts` gains only wiring; the logic lives in
  the mount.
- **Deliberately no board PV preview.** The panel never touches the board, which is a stronger
  guarantee that analysis cannot mutate authoritative game state or submit a move than any
  reversibility mechanism would be. Principal variations render as UCI text; converting to SAN would
  need a rules engine the web client deliberately does not have (ADR-0003).
- **Evaluation is converted to White's perspective (`analysis-format.ts`)**: the API returns it from
  the side to move, and every chess interface shows it White-relative. Rendering the raw value would
  invert the sign on every Black-to-move position, so the eval would appear to swing by twice its
  value each half-move and a player would read the wrong side as better. The sign is the only cue —
  colouring an advantage would need a second accent in a system that has one.
- **Reached is never presented as requested.** `applied` (what was enforced) and `lines[].depth`
  (what the search reached) are rendered as separate, separately labelled lines, because the
  wall-clock ceiling routinely cuts a search short of its depth limit.
- **Lifecycle (`analysis-controller.ts`)**: a generation guard plus an `AbortController`. A repeat
  request while one is pending is **ignored, not superseded** — the server cannot observe a client
  disconnect (ADR-0113), so aborting would not free the engine worker and superseding would double
  real engine load while merely looking responsive. A position change is the opposite case: it
  aborts and discards, and deliberately does not re-run, or every half-move of a blitz game would
  put a request on the wire unasked. A remount resets the panel, because its DOM outlives any single
  mount and a fresh controller has no way to know the rows on screen belong to the previous game.
- **Gating**: the panel is revealed only on an explicit `analysis: true` from `GET /v1/capabilities`
  — a missing key or a failed request leaves it hidden, because an unanswered question must not
  surface a control whose every request would 503. `loadCapabilities` is now a shared memoised read
  exported from `capabilities-nav.ts`; a second unmemoised caller would have refetched on every SPA
  navigation, the exact behaviour that memo already existed to prevent. Signed-out visitors see the
  panel with the control disabled and an explanation, never a dead button.
- **Limits cannot be widened from the client**: the only control is a line-count `<select>` offering
  1/3/5, all at or below the server's published MultiPV maximum, and the click handler accepts only
  those values. There is no depth or time input at all.
- **Harness (`packages/e2e-harness`)**: composes an `AnalysisService` over a deterministic
  `FakeAnalysisProvider`, so the browser suite exercises the real product path without depending on
  a Stockfish binary CI does not install for the Playwright job and without a different evaluation
  on every run. Engine reality stays covered by the env-gated smoke test against a real binary.
- **Tests**: request contract, MultiPV rendering and ordering, White-relative sign, reached-vs-limits
  separation, 429 and 503 as muted states rather than errors, stale-result supersession, disposal
  during a pending request, SPA remount non-stacking, keyboard reachability, and CSS contract
  assertions for the tabular eval column and the desktop sidebar scroll. Plus a real-browser
  `analysis.spec.ts` against the live endpoint. Mutation-verified: removing the request-dedup guard,
  the generation bump, or the mount-time reset each fails a test.

**Not covered**: no Move Explainer, Puzzle Generator, Mistake Predictor, Opening Explorer, Endgame
Trainer, Coach or voice features; no board PV preview; no client-disconnect router plumbing.

Prior: _Last updated: 2026-08-17 — M15 Increment 1: engine analysis endpoint on a dedicated pool (ADR-0113)._

## M15 Increment 1 — Engine Analysis Endpoint on a Dedicated Pool (ADR-0113)

Gave users a way to ask the engine a question. `@chess-platform/engine` has been complete since M5
and composed in production since ADR-0102 (the gateway hosts an `EngineManager` for the bot mover and
anti-cheat), but nothing exposed analysis: there was no `/v1/analysis` among the API's route
prefixes, and `packages/ai-features` still has no importer outside its own tests. This increment
ships the primitive every one of those features needs — evaluate this position, return the lines —
and nothing feature-specific. No UI.

- **Dedicated pool (`packages/api/src/analysis/composition.ts`)**: analysis gets its own
  `EngineManager`, never the gateway's gameplay pool. `JobPriority` orders bot moves ahead of
  analysis, but ordering is not isolation — dispatched analysis jobs still occupy workers and
  scheduler aging promotes waiting ones, so sharing would degrade bot latency by design. Only engines
  with a configured binary are registered, so a variant this deployment cannot serve is refused as
  unsupported (422) rather than failing to spawn and reporting the engine broken (503).
  `minWorkers: 0`, so no subprocess exists until the first request.
- **The wall-clock ceiling (`packages/api/src/analysis/limits.ts`)**: `AnalysisLimits` lets a caller
  bound a search by depth, nodes **or** time, so a request carrying only `depth: 30` has no
  wall-clock bound at all. `applyAnalysisLimits` injects `timeMs` on every request whether or not the
  caller mentioned time. Enforced in three layers — 422 at the route, a clamp in the service, and an
  `AbortController` backstop — and configuration may tighten limits but never loosen them past the
  built-in ceilings. `Threads` and `Hash` are stated explicitly so the CPU bound is
  `maxWorkers × threads` by our configuration rather than by an engine default.
- **Boundary FEN validation (`packages/api/src/analysis/fen-validator.ts`)**: UCI is
  newline-delimited and `buildPositionCommand` interpolates the FEN, so a terminator in a FEN is an
  injected engine command — `setoption name Threads value 128` defeats every ceiling above at once.
  `AnalysisService` validates at the boundary the API owns, not only inside `EngineManager`, because
  ADR-0113 Decision 2 plans to replace that manager with a remote worker. A king-count check runs
  too, with counts read from each variant's `Position.initial(...)` so Horde (no white king)
  validates; `parseFen` decodes but does not adjudicate.
- **Route (`packages/api/src/routes.ts`)**: `POST /v1/analysis`, authenticated, per-user **and**
  per-IP rate limited before any work, behind the established optional-dependency → capability
  pattern (`analysis` in `GET /v1/capabilities`). Transient engine failures reuse the closed
  `ErrorCode` union's `service_unavailable`, distinguished by message; engine-internal failures
  return a fixed generic message because `HttpError` messages reach clients.
- **Composition (`packages/api/src/bootstrap.ts`, `scripts/serve.ts`, `Dockerfile.api`,
  `docker-compose.yml`)**: `createPgDependencies` builds the subsystem and returns a
  `shutdownAnalysis` handle wired into SIGTERM, so engine subprocesses are drained rather than
  killed. The API image installs Stockfish. Review found this wiring missing entirely on the first
  pass — the endpoint would have answered "analysis is not configured" forever while the image
  shipped an engine — so `packages/api/test/bootstrap-analysis.test.ts` now asserts the production
  composition produces the dependency.
- **Cache correctness (`packages/engine/src/manager.ts`)**: `CacheMeta.limits` is documented as the
  limits a search *achieved*, but the manager stored the ones it was *asked for*, so a depth-20
  request cut short at depth 8 was filed as depth 20 and served to the next depth-20 caller.
  `achievedLimits` derives depth and nodes from the results. This increment was the first consumer
  to enable a real cache, which is why nothing had noticed.
- **Tests & ADR**: hermetic coverage via `FakeEngineTransport` and provider doubles, plus one
  env-gated smoke test driving the real production composition against a real Stockfish binary in a
  dedicated `analysis-smoke` CI job — asking for the platform's `standard`, the exact mapping
  ADR-0102 records fifty green engine tests failing to cover. Eight mutants, each proven to fail and
  be restored. Recorded in `docs/adr/0113-analysis-endpoint.md`.

**Not covered**: no UI, no AI features, no remote worker service, no durable cache (ADR-0003 and the
`DATABASE.md` contract untouched), and no cancellation on client disconnect — `RequestContext`
exposes neither an `AbortSignal` nor the raw request, so abandonment is unobservable at the route
layer. No capacity claims: the defaults are chosen to be obviously affordable, not tuned.

Prior: _Last updated: 2026-08-16 - M14 Increment 48: email-verification web UI (ADR-0112)._

## M14 Increment 48 - Email-Verification Web UI (ADR-0112)

Made the second half of the identity surface reachable from a browser. `POST /v1/auth/email/verify`
and the optional register `email` field have existed since M4 (ADR-0026) with no way to supply an
address or act on a verification link. No backend, OpenAPI, or token semantics changed.

The registration form gained one optional email field, and `AuthController.register` includes the
`email` key only when the trimmed value is non-empty, so an email-less registration sends exactly the
request it sent before. Sign-in is deliberately not gated by it: the form carries `novalidate` and
validation runs per action - register validates the whole form, sign-in validates only handle and
password - because a malformed address left in an optional field must not stop an existing user from
signing in. Passkey sign-in is unchanged.

`/email-verify` is public and accepts `#token=...` as an entry transport only. **The token rides the
URL fragment, and this increment moved `/password-reset` off the query string with it.** ADR-0109's
query-string transport could not be made safe client-side: a query string is part of the request
line, so `?token=...` reached the web tier on the first navigation before any script parsed, and
nginx's default access log retained a live credential that `replaceState` could not retract. A
fragment is never transmitted, so the secret now arrives without having touched the server. Both
flows moved together rather than leaving the older one exposed. No delivered link breaks, because
at the time nothing in the repository composed these URLs. M15 Increment 18 (ADR-0126) now composes
both fragment forms from the validated deployment-owned public origin.

The token is still captured and the fragment cleared with `history.replaceState` before app
composition, the capabilities request, or session restoration; that now protects the location bar and
history rather than the wire. The capture-and-strip mechanism is one helper shared with
`/password-reset` rather than two copies. Inside the client the token lives only in route-local memory
and is never rendered, logged, persisted, or interpolated into error copy - the transient-failure
message is fixed text, and a controller test drives a 500 whose server envelope deliberately contains
the token to prove the surface copy does not echo it. Query-string transport is tested against, not
merely unused: a bootstrap test drives `?token=...` and asserts no request is issued. The server's
hashed, 24-hour, atomic single-use behaviour is preserved and not duplicated client-side.

`EmailVerificationController` mirrors `PasswordResetController`'s dual-generation guards across
pending, success, invalid/expired/already-used, missing-token, and transient-failure states. Success
and 401 are terminal and release the token, so a consumed or rejected token cannot be replayed by the
mounted route; only a transient failure retains it and offers a retry, and an in-flight guard stops
retries stacking. `emailVerification` is its own named disposable covered by ADR-0092 exhaustiveness;
disposal is idempotent and terminal, and a completion after disposal invokes no callback. The surface
reuses the existing auth visual system; the only new CSS is one scoped rule holding the retry control
at the system's existing 44px touch target, which the shared `@media (pointer: coarse)` rule does not
reach on a narrow desktop window.

That delivery limitation was closed in M15 Increment 18 (ADR-0126): production now requires Resend
and exposes an authenticated resend-verification API. Opening a real delivered message remains
release/manual QA, and no verification status is surfaced in the UI. Terraform, cloud provisioning,
and 100k-user cluster validation remain deferred.

## M14 Increment 47 - Local Two-Gateway WebSocket Load Baseline (ADR-0111)

Added an on-demand k6 baseline against the real two-gateway Compose topology without changing
production limits or contracts. The default room opens 34 sockets (one player and 16 spectators per
node), plays a deterministic 32-ply line, and requires exact counts for 34 joins, 1,088 authoritative
deliveries, zero protocol errors, cross-node position agreement, and exactly 16 Redis-forwarded
commands. The measured 2026-08-16 workstation run passed those checks; its latency trends are
informational observations, not a WebSocket SLO or capacity statement.

The harness stays beneath the gateway's production per-IP connection and message limits, validates
its mirrored defaults against the gateway source, rejects configurations that cannot exercise
forwarding, and cancels pending joins/ply barriers when the room closes. Setup access tokens remain
in k6 memory: the WebSocket runner bypasses k6's secret-bearing built-in summary export and writes a
contract-tested metrics-only artifact. CI runs the pure planning/protocol/security contract tests;
the real Docker load run is intentionally on demand. Terraform, distributed generation, sustained
soak, and 100k-user cluster validation remain deferred.

## M14 Increment 46 - Account Security: Session Visibility and Revocation (ADR-0110)

Added `DELETE /v1/auth/sessions/:id` and an Active sessions list in the self-profile
account-security panel, completing a surface that had a list endpoint since M4 and no way to act on
it. `AuthService.revokeSession` resolves the path id *within* `sessions.listForUser(userId)`, so
another user's id is structurally unreachable and answers 404 rather than 403 — a 403 would confirm
that the id names a live session somewhere on the platform. Revoking an already-revoked session
returns 204, which also makes two concurrent revocations of one id both succeed rather than one
losing a race.

Current-session semantics follow from the existing token design rather than being invented: access
tokens are stateless HMACs whose `jti` is a fresh per-token id, so neither the server nor the client
can identify which session the caller's own token belongs to. Nothing is marked as "current", and
revocation is uniform. It ends the session's refresh capability; an access token already issued
stays valid until it expires, because `authenticate` verifies by signature alone without consulting
the session table. The UI states that in one line rather than implying an instant cutoff.

`SessionsController` mirrors `PasskeysController`'s generation guards, is created and disposed
alongside it, clears its rows on sign-out so a previous account's devices and addresses do not
remain on screen, and drops a duplicate revoke for an id already in flight. The view lists only
sessions that are neither revoked nor expired, so the heading stays true and revocation shows as the
row leaving. `SessionView` gained its first schema/presenter coupling test. The IDOR protection, the
active-session filter, the in-flight dedupe and the route disposal were each mutation-checked
against deliberately broken code. Corrected the `FEATURE_PARITY_AUDIT.md` row that claimed a
revocation API already existed. No routes, DOM IDs, UI behaviour outside the new section, or
contracts changed beyond the new endpoint.

## POST-AUD-001 - Lobby Route-Lifetime Remediation

Resolved a verified pre-existing lobby lifecycle defect that AUD-008J had mechanically preserved. The lobby controller now suppresses refresh, seek, and bot-game completions after disposal, cannot restart polling once disposed, and runs a single idempotent route cleanup hook. The lobby mount owns and removes its delegated seek-list click listener and guards create-game, bot-game, error, navigation, and session-update callbacks after route exit. Focused controller, mount, and browser regressions cover repeated remounts, deferred refresh and seek acceptance, stale bot-game navigation, active-route success behavior, and idempotent disposal. No routes, DOM IDs, UI behavior, API/OpenAPI contracts, or named `Bootstrapped` fields changed.

## AUD-008M - Web Composition Root Cleanup

Completed AUD-008M, the final web composition-root cleanup across `packages/web/src/app/bootstrap.ts` following the AUD-008A through AUD-008L route mount extractions. Reduced `bootstrap.ts` to a clear, minimal composition root responsible for URL route parsing, secret password-recovery token extraction and URL stripping, shared application graph and auth/theme composition, top-level route surface visibility, dispatch into the extracted route mounts, and backward-compatible `Bootstrapped` handle assembly. Removed stale comments, duplicate password-reset route checks, and redundant legacy type-import aliases without introducing framework abstractions, registries, or behavior changes. Preserved the public `bootstrap` signature and named result properties, ADR-0092 teardown exhaustiveness (`BootstrappedDisposables` and `DisposableKey`), auth/session restore ordering, WebSocket ownership and cleanup, and compatibility exports (`renderEmpty`, `formatClock`, `formatTimeControl`, `EmptyStateOptions`, and `extractGameId`). Completes the entire AUD-008A through M route extraction and composition-root cleanup series.

## AUD-008L - Game Route Mount Extraction

Extracted the `/game/:id` route DOM composition from `packages/web/src/app/bootstrap.ts` into the focused `packages/web/src/app/game-mount.ts` module. The mount preserves exact behavior for `GameSync` initialization, authoritative move oracle creation, board mounting, clock/status/metadata/presence/live-announcement updates, action controls (draw, claim flag, resign, abort with inline confirmations, double-click protection, and error display), immediate authenticated WebSocket startup when a token is provided, and deferred spectator/authenticated startup when waiting for asynchronous session restoration (with rejection swallowing and route-exit cancellation). Preserves the single `GameController.start()` invocation, `window` `online`/`offline` connectivity listener registration and teardown in `connectivity.dispose()`, teardown ordering, and named `Bootstrapped` result handles (`board`, `controller`, `connectivity`). Route-scoped action click listeners are tracked and idempotently unbound in `connectivity.dispose()` to prevent handler stacking across SPA route remounts. Focused mount regressions cover immediate and restore-deferred socket startup, reject handling, premature disposal cancellation, online/offline browser listeners, action/confirmation wiring, and disposal unbinding.

## AUD-008K - Profile Route Mount Extraction

Extracted the `/profile` and `/profile/:handle` route DOM composition from `packages/web/src/app/bootstrap.ts` into the focused `packages/web/src/app/profile-mount.ts` module. The mount preserves exact behavior for `ProfileController` (self and public profiles, ratings, games, empty/error states, and stale-response protection), `SocialController` (followers, following, friends, blocks, relationship actions, privacy/unavailable states, busy protection, and profile-to-message SPA navigation), `AchievementsController` (summary, list, unavailable, reset, and error presentation), and self-profile `PasskeysController` (list, register, delete, WebAuthn adapter injection, click-handler ownership, and lifecycle unbinding/disposal). Preserves session-restore ordering, same-user deduplication, sign-out and account-switch private-state clearing (disclosure prevention), and public-profile session-change social refreshes without profile data reloading. Focused mount regressions cover session restoration, deduplication, disclosure protection, passkey disposal, social refresh, SPA messaging navigation, and achievements handling.

## AUD-008J - Lobby Route Mount Extraction

Extracted the lobby route's seek-list rendering, create-game panel, play-vs-computer dialog, and delegated seek actions from `packages/web/src/app/bootstrap.ts` into the focused `packages/web/src/app/lobby-mount.ts` module. `bootstrap(document, dependencies)` and its named `lobby` result still expose the same `LobbyController`; auth restoration, seek polling, game navigation, storage selection, DOM IDs, accessibility, styling, and API contracts are unchanged. Focused mount regressions cover seek states and actions, auth gating, create-game and bot-game submission, error presentation, navigation, and injected preference storage.

## AUD-008I - Password-Recovery Route Mount Extraction

Extracted the `/password-reset` route's DOM composition from `packages/web/src/app/bootstrap.ts` into the focused `packages/web/src/app/password-recovery-mount.ts` module. The early URL-token capture and `history.replaceState` stripping remain in `bootstrap` before application composition or background requests. The mount preserves route-local token lifetime and post-success replay prevention, local session clearing, persistent form ownership, pending-request disposal, idle-state restoration, DOM IDs, accessibility, styling, and the named `passwordReset` lifecycle disposable. Focused mount regressions plus the existing controller and Playwright coverage protect successful reset, invalid/expired-token retry, and stale completion suppression.

## M14 Increment 45 - Password-Recovery Web UI (ADR-0109)

Delivered full password-recovery web UI flow in `@chess-platform/web` over the existing M4 server contracts (`POST /v1/auth/password-reset/request` and `POST /v1/auth/password-reset/confirm`).
- **Typed Web Client & Models (`packages/web/src/api/client.ts`, `models.ts`)**: Added typed request interfaces `PasswordResetRequest` and `PasswordResetConfirmRequest` to `models.ts` and `requestPasswordReset` and `confirmPasswordReset` methods to `AuthApi` in `client.ts`. Backend API contracts remain completely unchanged.
- **SPA Routing & Surface Discoverability (`packages/web/src/app/router.ts`, `index.html`)**: Added SPA route `/password-reset` (accepting optional `?token=...` query parameter) and a discoverable "Forgot password?" link (`#auth-forgot-password`) on the signed-out auth surface.
- **Form Orchestration & Session Cleanup (`packages/web/src/app/password-reset-controller.ts`, `bootstrap.ts`)**: Managed by DOM-free `PasswordResetController` with client validation (8..1024 char password length and matching confirmation), loading/disabled/aria-busy states, duplicate submission guards, and generic success messaging to prevent handle enumeration. On successful password reset confirmation (204), clears local auth session state (`auth.clearLocalSession()`).
- **Token Secrecy & Lifecycle Hygiene (`packages/web/src/app/bootstrap.ts`, `lifecycle.ts`)**: Strips secret reset tokens from the visible URL via `history.replaceState` before any background network requests run, preventing token leakage in `Referer` headers. The token is held only in route-local memory and released after success or route teardown. Integrated into `BootstrappedDisposables` and `DISPOSABLE_TEARDOWN_MAP` for leak-free route teardown.

## M14 Increment 44 - WebAuthn Passkeys Real Browser Web Flow (ADR-0108)

Delivered full WebAuthn passkey authentication and management in `@chess-platform/web` over all six published server endpoints.
- **Server Contract & OpenAPI Alignment (`packages/api/src/auth/service.ts`, `schemas.ts`)**: Changed registration options from `residentKey: 'preferred'` to `residentKey: 'required'` to ensure discoverable credentials for real browser flows. Updated OpenAPI schemas (`authenticatorSelection.residentKey` in registration, `allowCredentials` optional in login) and regenerated `packages/api/openapi.json` with 0 spec drift.
- **Typed Web Client & Browser WebAuthn Adapter (`packages/web/src/api/client.ts`, `ports/webauthn.ts`)**: Added 6 typed methods to `AuthApi` (`listPasskeys`, `deletePasskey`, `registerPasskeyOptions`, `verifyPasskeyRegister`, `loginPasskeyOptions`, `verifyPasskeyLogin` with session adoption and `credentials: 'include'`). Built injectable `NativeWebAuthnAdapter` wrapping native WebAuthn L3 JSON APIs (`parseCreationOptionsFromJSON`, `create`, `parseRequestOptionsFromJSON`, `get`, `toJSON`).
- **Global Sign-in Surface Integration**: Added `Sign in with passkey` button to `#auth-form` accepting handle alone, sharing session adoption logic with password auth and returning generic error copy to prevent handle enumeration.
- **Self-Profile Account Security Surface**: Added `#passkeys-self` section under profile (`/profile` only) using standard `.panel-list`/`.panel-row` 2-child composition and compact row action (`padding: 2px 10px`, `Label` type). Managed by DOM-free `PasskeysController` with request generation counter, stale load guards, lifecycle teardown, and cleanup on logout.
- **Next**: The documented next bounded web item is the password-recovery UI. Increment 44 does not implement it.

## M14 Increment 43 - SPA Leaderboard Page (ADR-0107)

Exposed the already-existing typed leaderboard API as a real, accessible SPA page (`/leaderboard`).
- **Product-Offered Variants Selection**: The variant selector populates options exclusively from `OFFERED_VARIANTS` and labels from `VARIANT_LABELS` isolated in `src/app/variant-labels.ts` to keep `api/models.ts` framework-independent. Intentionally omits hollow `chess960`.
- **Stale Request Guard & Composite Lifecycle Teardown**: `LeaderboardController` maintains a `requestGeneration` counter. Late async responses from older variant selections are ignored (`isCurrent(generation)` check), preventing out-of-order overwrites. Navigating away triggers `dispose()`. Bootstrap uses a reusable DOM `bindVariantSelector` helper to bind change handlers. On teardown, the route composite disposable invokes `unbind()` followed by `leaderboardCtrl.dispose()`, keeping event listeners from leaking without controller/DOM coupling.
- **UI Architecture & Accessibility**: Enforces strict two-child composition per result row (`.row-main` containing rank plus player node, and `.count` for ratings) inside a `.panel-row`. Employs dynamic accessible roles: the results container switches to `role="status"` during the empty state to avoid invalid list ownership, and restores to `role="list"` when entries populate as `role="listitem"`.

## M14 Increment 42 - Horde and Racing Kings perft coverage and rule fixes (ADR-0098)

Completes the perft suite for the remaining two chess variants (`horde` and `racingkings`), sourcing six reference positions from official `lichess-org/scalachess` perft resources (`horde.perft` and `racingkings.perft`) rather than golden-master outputs. Resolves two variant-rule defects in `@chess-platform/core`.

- **Horde Pawn Double-Push & En-Passant (`packages/chess-core/src/movegen.ts`)**: White Horde pawns on ranks 1 and 2 (rank indices 0 and 1) are eligible for a two-square initial move. Updated `generatePseudoLegal` to allow White pawns on rank index 0 to double push to rank index 2 when both intermediate and destination squares are empty, and restricted `epSquare` creation in `applyMove` to double pushes from standard starting ranks (rank index 1 for White, 6 for Black). Brings `horde-start`, `horde-open-flank`, and `horde-en-passant` into 100% agreement across depths 1..4.
- **Racing Kings Goal & Turn Semantics (`packages/chess-core/src/position.ts`)**: Corrected `racingKingsResult()` so that when White reaches rank 8, Black receives one final move on `turn === 'b'` to also reach rank 8 (for a draw). `racingKingsResult()` inspects `this.legalMoves()` to detect whether Black has any legal king move reaching rank index 7; if Black has no such move, White wins immediately. If both kings land on rank 8, `racingKingsResult` returns `variant_draw`. Brings `racingkings-start`, `occupied-goal`, and `near-discovered-check` into 100% agreement across all published depths.
- **Perft Test Coverage & Behavioral Regression Tests (`packages/chess-core/test/perft.test.ts`, `packages/chess-core/test/rules.test.ts`)**: Added data-driven test cases for all six reference positions (`horde-start`, `horde-open-flank`, `horde-en-passant`, `racingkings-start` depths 1..5, `occupied-goal`, `near-discovered-check`) with EPDs completed by `0 1` fields and unified through a single `assertPerftCase` assertion helper. Added behavioral regression tests in `rules.test.ts` verifying Horde rank-1 pawn double pushes (confirming en-passant square remains `-`) and Racing Kings goal-reach win/draw semantics, plus regressions confirming `perftDivide()` exposes no root branches from a variant-terminal position and callers cannot mutate the memoized legal-move array used by perft. `racingkings-start` depth 5 (`9472927`) is verified 100% against official scalachess and included in automated perft coverage.
- **Documentation (`docs/adr/0098-variant-perft.md`, `docs/ROADMAP.md`, `docs/PROJECT_STATE.md`)**: Amended ADR-0098 with independent sources, defects found, rule fixes, and consequences; updated `docs/ROADMAP.md` follow-up to resolved; added M14 Increment 42 entry to `docs/PROJECT_STATE.md`.

## M14 Increment 39 - Capabilities-driven navigation (ADR-0106)

Top-level navigation links in `packages/web/index.html` advertised optional features (`/courses`, `/studies`) regardless of whether the subsystem was configured in the current deployment. Clicking "Learn" yielded a 503 error ("Learning service unavailable.") — violating `DESIGN.md`'s retryability principle (*"An explanation is the state; a disabled button that can never enable is not"*).

- **Backend Capabilities Endpoint (`packages/api/src/routes.ts`, `schemas.ts`, `presenters.ts`)**: Added public `GET /v1/capabilities` reporting boolean status for all optional repositories (`learning`, `studies`, `achievements`, `search`, `social`, `messaging`, `community`), derived strictly from `deps` (never `process.env`). Added `Capabilities` component schema to OpenAPI and presenter-schema coupling test in `openapi.test.ts`.
- **Frontend Navigation & Flash Prevention (`packages/web/index.html`, `packages/web/src/app/capabilities-nav.ts`, `bootstrap.ts`, `client.ts`, `models.ts`)**: Optional nav links start `hidden` in static HTML (`index.html`). `bootstrap` fetches capabilities once (`GambitClient.capabilities()`). Mapped links with `true` capability have `hidden` removed; links with `false` capability are removed from the DOM.
- **Fail-Open Policy**: If `GET /v1/capabilities` fails (network error, 500, timeout), all mapped links are revealed (`hidden` removed) so a transient network issue never permanently strips navigation affordances.
- **Tests & Documentation (`packages/api/test/capabilities.test.ts`, `packages/web/test/capabilities-nav.test.ts`, `docs/adr/0106-capabilities-driven-navigation.md`)**: Unit tests verify dependency-driven capability reporting in API, nav DOM removal/revelation, fail-open behavior, and OpenAPI schema coupling. Documented in `docs/adr/0106-capabilities-driven-navigation.md`.

## M14 Increment 37 - Live clock countdown UI interpolation and web container build chain (ADR-0103)

A player watching their own game saw a frozen clock that only updated when a move landed, remaining unchanged while sitting and thinking and across page reloads. The server timing was authoritative and correct; the browser never rendered the passage of time between moves. Additionally, adding `@chess-platform/realtime-gateway` to web exposed a container build chain defect in `Dockerfile.web`.

- **Anchor in snapshot (`packages/realtime-gateway/src/protocol.ts`, `authority.ts`, `packages/web/src/net/ws-protocol.ts`)**: `StateView` now carries `readonly turnStartedAt: number | null` (populated from `snap.clock.turnStartedAt`), allowing clients joining mid-game or reloading to anchor countdown interpolation.
- **Clock skew in WebSocket client (`packages/web/src/net/ws-client.ts`, `game-sync.ts`)**: `WsClient` calculates skew on `pong` messages using `estimateSkewMs(msg.ts, msg.serverTs, rtt)` and exposes it via a `skew` getter.
- **Single pure helper implementation re-exported through barrel (`packages/realtime-gateway/src/index.ts`)**: Re-exported latency functions explicitly in `index.ts`. `packages/web` imports `estimateSkewMs` and `interpolateRemaining` directly from `@chess-platform/realtime-gateway`, ensuring exactly one interpolation implementation exists in the repo without requiring Vite alias rules.
- **Injectable clock timer with second-granularity DOM throttling (`packages/web/src/app/game-controller.ts`)**: `GameController` ticks an injectable timer on live games to emit interpolated remaining time. `updateClockDisplay` suppresses callbacks unless the rounded second value (`Math.floor(ms / 1000)`) changes, reducing DOM updates by ~90%, while authoritative state updates (`handleState`) emit immediately with zero lag.
- **Web image build chain & build-order gate expansion (`packages/web/package.json`, `package.json`, `Dockerfile.web`, `scripts/check-docker-build-order.mjs`)**: Moved `@chess-platform/realtime-gateway` to `dependencies` in `packages/web/package.json`, added root `build:web` script in `package.json`, updated `Dockerfile.web` to delegate to `build:web`, and extended `scripts/check-docker-build-order.mjs` into a parameterized gate checking both `server` and `web` container build chains.

## M14 Increment 36 - The dev server had no API proxy, and the bot had no engine (ADR-0102)

Two defects from running the platform locally: registering answered `HTTP 404`, and the computer opponent never moved. Unrelated causes; each reproduced before being fixed.

- **Dev proxy (`packages/web/vite.config.ts`)**: `resolveEndpoints` derives the API origin from `location.origin`, so under `vite dev` the app called `/v1/...` on the dev server, which served nothing. `preview` already had a proxy for e2e; `server` had none. Added for `/v1` and `/ws`, defaulting to the Compose ports, overridable with `GAMBIT_DEV_API_URL` / `GAMBIT_DEV_WS_URL`.
- **Engine bot (`Dockerfile.gateway`, `docker-compose.yml`)**: `serve.ts` requires `ENGINE_BOT=1` **and** a binary at `STOCKFISH_PATH`. Compose set neither and the image installed no engine, and the failure is a log warning rather than a crash. The image now installs Stockfish at `/usr/games/stockfish`; Compose sets `ENGINE_BOT` by default. *(Superseded in M15 Increment 12: the image no longer uses apt, and the binary is a pinned Stockfish 16 at `/usr/local/bin/stockfish`.)*
- **Variant routing (`packages/engine/src/plugin.ts`, `pool.ts`)**: the platform calls ordinary chess `standard`, UCI calls it `chess`. `variantSetup` accepted `standard` all along, but `expectedVariants` omitted it and `supportsVariant` consulted only discovered capabilities when warm — so a bot game threw `NoEngineForVariantError`. Both plugins now declare `standard`, and `supportsVariant` returns the union of declared and discovered names.
- **Why the suite missed it**: all 50 engine tests routed by `variant: 'chess'`, the engine's vocabulary rather than the platform's. New tests route `standard` warm and cold; both fail against the unfixed code. `packages/web/test/dev-proxy.test.ts` pins server/preview proxy parity, since nothing tested `vite.config.ts` at all.
- **Documented** in `docs/RUNNING.md`: a front-end dev-server section, and the two requirements for Play vs Computer with the `EngineBotMover is enabled` log line that confirms them.

## M14 Increment 35 - The promotion picker rendered blank tiles (ADR-0101)

A design pass over `packages/web/src/style.css`, opened as token-compliance work, found a user-facing rendering bug. The promotion dialog was drawing four identical blank tiles.

- **Cause**: each choice carries `.cb-promo-choice` plus the shared `.cb-p-*` class, and `.cb-p-*` supplies only a `background-image`. `.cb-promo-choice` set `background: var(--promo-tile)` — the shorthand resets `background-image` to none, and at equal specificity the later rule won. Confirmed by reading the computed style, not by inference.
- **Fix**: `background-color` on the rule and its `:hover`, plus `background-size` / `background-repeat` / `background-position`, which `.cb-piece` carries for board pieces and this button does not inherit. Removed the dead `font-size`, the dead `color`, and the unused `--promo-tile-ink` token — all fossils of the Unicode-glyph picker that preceded the Cburnett SVG set.
- **It existed twice.** PR #98 review found `button:not(:disabled):hover` using the shorthand as well; at (0,2,1) against `.cb-p-*` at (0,1,0) it outranked the artwork, so the piece disappeared on hover even though a later `.cb-promo-choice:hover` rule reset the fill. Both generic `button` rules now use `background-color`.
- **Pinned** in `packages/web/test/style-contract.test.ts`, which asserts across every selector that can match a promotion tile — nothing else could catch either instance, since markup, classes and DOM were all correct and every test passed. The first version checked only the two obviously-named rules and missed the hover case. Mutation-verified against both.
- **DESIGN.md** gains a Promotion picker component entry: the shorthand rule, where the sizing lives, and why the near-white tile reads for both colours (the Cburnett white pieces carry a heavy black outline — the previous comment credited "dark glyphs", which described the retired Unicode version).
- **Token drift closed**: a second `border-radius` and three font sizes off the documented ramp are back on their steps; the Impeccable detector reports zero findings across `style.css`, `index.html` and `src/app`.

## M14 Increment 34 - Per-variant timeout material rules (ADR-0100)

`endByTimeout` in `packages/game/src/game.ts` called `canMate(fen, winner)` without the variant, so `parseFen` defaulted to `standard` and the classical lone-king / K+N / K+B material test was applied to every variant — including the ones where checkmate is not the win condition.

- **Live on variants the lobby offers**: a bare king in King of the Hill or Racing Kings, a queen held in a Crazyhouse pocket, and K+N in Three-check or Atomic were all reported as unable to win, so a timeout win became a draw.
- **Fix**: `canMate(fen, color, variant)`; each variant answers its own question, with the reasoning recorded per variant in ADR-0100 §1. Standard and Chess960 unchanged; the default argument keeps existing callers correct.
- **Mutation-verified**: dropping the `variant` argument fails the King of the Hill timeout test.
- **Untouched**: `Position.hasInsufficientMaterial` already guarded itself to `standard` and `chess960`, so in-play draws were never affected.

## M14 Increment 33 - Chess960 withheld from the lobby, and a variant audit (ADR-0099)

Chess960 was selectable in the lobby with no implementation behind it. `Position.initial('chess960')` returns the standard array, and `packages/game/src/game.ts:92` uses it for any seek without an explicit FEN; `generateCastles` in `packages/chess-core/src/movegen.ts` pins the king to e1/e8 and looks for rooks at fixed offsets, so castling generates for exactly one of the 960 start positions — the one that is standard chess.

- **Withheld, not deleted**: `VARIANTS` still mirrors the server enum; a new `OFFERED_VARIANTS` in `packages/web/src/api/models.ts` is what the lobby renders. They were the same array, which is why a hollow variant stayed selectable — there was no way to withhold one without misstating the contract. Restoring it is one line, and the test says so.
- **Audit of all eight variants**: Chess960 was the only hollow one. `horde` and `racingkings` start correctly and enforce their win conditions; the rest were verified in Increment 32.
- **Corrections worth keeping**: `racingkings` first looked broken — the probe position had both kings on rank 8, which is genuinely a draw. `threecheck` first looked as though it never counted checks — the reading was taken through `snapshot()`, which round-trips via FEN and drops `checkCount`.
- **Found, not fixed**: `Position.snapshot()` loses three-check counters. Recorded at the time as latent, since its only production callers build repetition keys, which were believed to use only the first four FEN fields. That belief was wrong — the key already included the counters for `threecheck`, so this was a live wrong-result bug. Corrected and fixed in M15 Increment 8; see that section and the correction note in ADR-0099 §4.
- **Open**: implementing Chess960 properly — 960-position generation, castling from arbitrary squares, Shredder/X-FEN, UCI king-takes-rook encoding, SAN, perft against published values.

## M14 Increment 32 - Perft coverage for the chess variants (ADR-0098)

All five perft cases in `packages/chess-core/test/perft.test.ts` ran `standard`, while `packages/chess-core/src/movegen.ts` branches on the variant in six places — seven rule sets had no perft verification.

- **Discipline (ADR-0098 §1)**: no expected value was taken by running this implementation. Recording current output as `expected` is a golden master — it captures the bugs of the day it was written and passes forever. Values trace to the published Chess Programming Wiki counts already in the file, or to arithmetic over the starting array.
- **Equality invariant**: `chess960`, `kingofthehill`, `threecheck` match the published standard counts exactly (movegen unchanged; only castling arrangement or terminal condition differs), bounded to depths where the variant cannot terminate early.
- **Divergence assertions**: `atomic` must differ at depth 4 (captures explode); `crazyhouse` with a pawn in hand must give `perft(1) = 52` = 20 moves + 32 drops on the empty squares of ranks 3-6.
- **Mutation-verified**: adding `kingofthehill` to the no-castling list, and disabling crazyhouse drops, each fail a test. Suite 16 → 24 tests, 2.4s.
- **Found and left open**: Chess960 castling-by-file is broken — `packages/chess-core/src/fen.ts` silently discards Shredder-FEN rights (`HAha` on kiwipete gives `perft(1) = 46`, the same as no rights, vs 48 for `KQkq`). Recorded under the Milestone 1 follow-ups; it is a source fix with its own tests.
- **Still uncovered**: `horde` and `racingkings`, pending published reference values. Inventing them was refused.

## M14 Increment 31 - Delete the speculative `AttemptResult.message` (ADR-0097)

Closes the last open item in the ROADMAP follow-up list. `AttemptResult` in `packages/learning/src/model.ts` declared `readonly message?: string`, and no implementation ever set it — the declaration was the only occurrence of the field in the repository. The presenter omitting it dropped nothing.

- **Domain (`packages/learning/src/model.ts`)**: field deleted. Populating it would have meant writing the wording of a feedback feature that has never existed, which is a product decision; deleting is the reversible direction, and the domain can regain the field the day something produces a value.
- **Contract test (`packages/api/test/openapi.test.ts`)**: `AttemptResultView` was the last presenter without a schema/presenter coupling test — the divergence found three times before (ADR-0088, Increments 28 and 30), each time surviving because every route test reads the response and none read the schema. Its assertion differs from its neighbours: `completedAt` is genuinely optional on both sides, so declared properties are checked against the union of both branches while `required` is checked against the always-present keys.
- **Stale marker corrected (`docs/ROADMAP.md`)**: Increment 1 still read `🚧` while all five acceptance artifacts exist and its criteria are met. Now ✅.
- **Known gap, not closed**: a wrong quiz answer yields `Try again` and nothing else — a quiz step has no author-written explanation field, and ADR-0095 removed `correctIndex` from the learner view. A move step still carries its author-written `hint`. Recorded in ADR-0097 §2 as a design task.

## M14 Increment 30 - Team join-request moderation (ADR-0096)

Implements the owner/admin moderation panel for private team join requests in the web UI and adds server-side status filtering before pagination across all repository layers and API routes.

- **Server-side Status Filtering (`packages/community/src/repository.ts`, `packages/persistence/src/pg/community.ts`)**: Widened `listJoinRequests` signature to accept an optional `status` parameter (`PageOptions & { status?: JoinRequestStatus }`). Filter is applied in the SQL `WHERE` clause and in-memory list before applying pagination (`paginate`), ensuring pending requests beyond page 1 of team history remain visible to moderators.
- **API Route & OpenAPI (`packages/api/src/routes.ts`, `packages/api/openapi.json`)**: Updated `GET /v1/teams/:id/join-requests` to accept an optional `status` query parameter, validating it against allowed domain values via `oneOf` (returning 422 on invalid input). Added `statusParam()` helper to OpenAPI route documentation and regenerated `packages/api/openapi.json`.
- **Web UI & Moderation Panel (`packages/web/src/app/bootstrap.ts`, `packages/web/src/app/render-helpers.ts`, `packages/web/src/app/teams-view.ts`, `packages/web/src/app/teams-controller.ts`, `packages/web/src/api/client.ts`, `packages/web/src/api/models.ts`, `packages/web/index.html`)**: Extracted `appendPanelRow` and `RowAction` to `render-helpers.ts` for reuse. Added `JoinRequestView` and `JoinRequestList` models and `joinRequests` / `respondToJoinRequest` methods to `TeamsApi`. Added `#join-requests-heading` and `#join-requests` elements to `index.html` section `#team`, rendered via pure DOM helper `renderJoinRequests`. Hidden for non-admin viewers.
- **Tests & ADR (`packages/community/test/community.test.ts`, `packages/persistence/test/community.integration.test.ts`, `packages/api/test/community-api.test.ts`, `packages/web/test/teams-controller.test.ts`, `packages/web/test/a11y.test.ts`, `packages/web/e2e/teams.spec.ts`, `docs/adr/0096-join-request-moderation.md`)**: Added unit/integration tests for server-side filtering before pagination, status query param validation (422), non-admin zero-fetch assertion, a11y DOM tests, Playwright E2E spec for owner moderation flow, and documented in ADR-0096.

## M14 Increment 29 - Learner-scoped lesson step view (ADR-0095)

Implements a learner-scoped step projection (`LearnerStepView` / `learnerStepView`) on public step read routes (`GET /v1/lessons/:id/steps` and `GET /v1/steps/:id`), omitting `expectedSan` and `correctIndex` for learners and anonymous callers while preserving full step details for course authors.

- **Presenter & Projection (`packages/api/src/presenters.ts`)**: Added `LearnerStepView` interface and `learnerStepView` function built directly from the `LessonStep` domain object without mutating or deriving from `stepView`.
- **Routes & Authorship Resolution (`packages/api/src/routes.ts`)**: Updated `GET /v1/lessons/:id/steps` and `GET /v1/steps/:id` to check whether the actor is the course author via repository calls (`repo.getLesson` / `repo.getStep` → `repo.getCourse`). Returns `stepView` if author, `learnerStepView` otherwise.
- **Repository (`packages/learning/src/repository.ts`, `packages/learning/src/in-memory-repository.ts`, `packages/persistence/src/pg/learning.ts`)**: Added `getStepWithCourse` / `listStepsWithCourse`, returning the course the plain `getStep` / `listSteps` already load to enforce visibility and then discard. `getStep` and `listSteps` delegate to them. Without this the authorship check doubled both public step routes from 3 SQL queries to 6; they now cost exactly one repository call, held there by a counting-proxy test in `packages/api/test/learning-api.test.ts`.
- **OpenAPI Specs (`packages/api/src/openapi/schemas.ts`, `packages/api/openapi.json`)**: Added `LearnerStepView` and `LearnerStepList` schemas and updated the 200 response types for routes 16 and 17. Regenerated `packages/api/openapi.json` via `npm run openapi`.
- **Web Client Comments (`packages/web/src/api/models.ts`)**: Updated comments on `MoveStepView` and `QuizStepView` to reference ADR-0095 and state that the server no longer sends `expectedSan` / `correctIndex` to learners.
- **Tests & ADR (`packages/api/test/learning-api.test.ts`, `packages/api/test/openapi.test.ts`, `docs/adr/0095-learner-step-view.md`)**: Added contract tests covering anonymous, non-author, and author requests on both public read routes, schema declaration checks, and documented decisions in ADR-0095.

## M14 Increment 28 - Fix JoinRequestView OpenAPI contract (ADR-0088)

Corrects the published `JoinRequestView` OpenAPI schema in `packages/api/src/openapi/schemas.ts` to match `joinRequestView` presenter output and `FriendRequestView` schema pattern.

- **OpenAPI Schema & Spec (`packages/api/src/openapi/schemas.ts`, `packages/api/openapi.json`)**: Replaced `updatedAt` with `respondedAt` (nullable `dateTime`, retained in `required` array) in `JoinRequestView` schema. Regenerated `packages/api/openapi.json` using `npm run openapi`.
- **Contract Tests (`packages/api/test/community-api.test.ts`, `packages/api/test/openapi.test.ts`)**: One response-shape test across all three routes that return a join request, plus a test asserting the served schema declares exactly the keys the presenter emits. The second is the one that pins the defect: with only response-shape tests, reverting the schema alone left the whole suite green.
- Closes the tracked roadmap debt for `JoinRequestView` OpenAPI divergence.

## M14 Increment 27 - Search hits carry their own display metadata (ADR-0094)

Removes the search N+1: a page of ten results cost up to **12 requests** (one query, up to ten per-result entity fetches, one batched player resolve) and painted only after every one of them settled. Now one request, one pass.

- **Domain (`packages/search`)**: `SearchableDocument` and `SearchResult` gain optional `display` (`type`, `title`, `subtitle`) — separate from `fields`, whose values are canonicalized lowercase for exact-match filtering, and from `text`, which is a recall-tuned match corpus.
- **Security asserted, not restated**: `display` reuses only fields each projection already indexed. A test pins the whole serialized player document, so a leak under any field name fails it — holding the SECURITY note in `projections.ts` to account. (A first version scanned for forbidden substrings; a handle may legitimately contain `hash` or `flag`, so it was replaced during PR review.)
- **API**: the OpenAPI `SearchResult` exposes `display` as optional, because a document indexed before the field existed still matches and must still be returned.
- **Web**: hydration deleted; `HydratedHit` renamed `SearchRow`. A controller test pins the change with a client whose `tournaments.byId` / `games.byId` / `resolvePlayers` throw on contact — a request count, since the rendered output looks the same either way.
- **Frontend (Impeccable audit, 16/20, detector clean)**: removed the counterfeit `.panel-row` "Loading…" placeholder in favour of the already-wired `aria-busy`, and renamed `.tournament-link` → `.row-link` across six call sites. Both recorded in `packages/web/DESIGN.md`.

## M14 Increment 26 - PGN suffix annotations reach the tree (ADR-0093)

Fixes silent data loss on PGN import: a move annotated in the suffix form (`Nf3!`, `Qh5!!`, `c5?!`) lost that annotation entirely — it survived neither in the stored SAN nor in `nags`, and nothing errored.

- **Parser (`packages/studies/src/pgn-parse.ts`)**: the trailing `[!?]+` run is captured whole and mapped to its NAG (`! → $1` … `?! → $6`). Capturing the run rather than a single character is what keeps `!!` a single `$3`. `+`/`#` remain part of the SAN, and an explicit `$n` following a suffix is preserved alongside it.
- **Unrecognised runs reject with a located error** rather than importing the move stripped of its annotation. Import is atomic, so this fails the file loudly instead of half-applying it.
- **Both adapters covered by one change** — `packages/persistence/src/pg/studies.ts:24` imports `parsePgn` from `@chess-platform/studies`. Checked deliberately: ADR-0091 §10 found these two had silently diverged on import ordering, so shared-vs-duplicated is verified rather than assumed.
- Closes the tracked follow-up opened during Increment 24.

## M14 Increment 25 - Structural bootstrap teardown & disposal exhaustiveness (ADR-0092)

Eliminates manual route controller teardown in `main.ts` and fixes latent memory/subscription leaks by making un-disposed route controllers a compile error.

- **Types & Exhaustiveness (`bootstrap.ts`, `lifecycle.ts`)**: Separated `BootstrappedDisposables` from `Bootstrapped`. Derived `DisposableKey = keyof BootstrappedDisposables`. `DISPOSABLE_TEARDOWN_MAP` is typed strictly as `Record<DisposableKey, true>` so omitting a disposable controller fails TypeScript compilation (`TS2741`).
- **Lifecycle Unit & Main Entry (`lifecycle.ts`, `main.ts`)**: Extracted the run and teardown loop into `createLifecycle` in `packages/web/src/app/lifecycle.ts`. `main.ts` becomes a thin DOM entry point delegating run and theme state management to `createLifecycle`.
- **Verb Normalisation & Socket Leak Fix (`game-controller.ts`, `board.ts`)**: Normalised teardown verb to `.dispose()` across all disposables (`MountedBoard.dispose()`, `GameController.dispose()`). Cascaded `GameController.stop()` to `gameSync.stop()`, unsubscribing game socket listeners when navigating away from `/game/{id}` routes.
- **Tests & Documentation (`lifecycle.test.ts`, `0092-bootstrap-teardown.md`)**: Added unit tests covering teardown order before next bootstrap, null disposable skipping, and type-level `@ts-expect-error` exhaustiveness guard. Documented in `docs/adr/0092-bootstrap-teardown.md`.

## M14 Increment 24 - Viewer-facing Studies UI (browse, chapters, move tree) (ADR-0091)

Exposes the M10 studies backend (21 routes under `/v1/studies`, previously no UI at all) as a viewer UI: browse public/collaborative studies, view chapter lists, and analyze chapter move trees on a read-only board.

- **Routing & Client (`packages/web/src/app/router.ts`, `packages/web/src/api/client.ts`, `models.ts`)**: Added `/studies`, `/studies/:id`, and `/studies/:id/chapters/:chapterId` routes to `router.ts`. Added `StudiesApi` class and `GambitClient.studies` with `permanentStatuses: [503]` retry suppression. Added REST models for studies, chapters, tree nodes, collaborators, and chapter details.
- **Notation Pane & Read-Only Board (`studies-view.ts`, `studies-helpers.ts`)**: Move tree renders as inline wrapping move text (`1. e4 e5 2. Nf3 Nc6`) with indented variation blocks, one step per nesting level, with no bullets or list markers. Selecting a move sets board position via stored `fenAfter`. Board mounts with `setTurn(false)`. Topbar navigation adds `Studies` as a 7th plain-text nav entry.
- **Typography & Accent Rules (`DESIGN.md`)**: Mainline typography retains normal weight without bold emphasis (`font-weight: 600` is reserved for clock numeric time). Selected move uses Grandmaster Teal (`--sel`). Moves are focusable `<button class="notation-move">` controls with accessible `aria-label` attributes and a 44px coarse pointer touch target.
- **NAG Mapping & Comments**: PGN NAG codes 1–6 map to annotation symbols (`1 → !`, `2 → ?`, `3 → !!`, `4 → ??`, `5 → !?`, `6 → ?!`), fusing to moves (`Bb5!`). Out-of-range NAGs render as empty strings to avoid unestablished font glyphs. Move comments wrap as prose in the muted `.count` voice (`#8f8f8c`).
- **503 Latching & Controller (`studies-controller.ts`)**: GETs pass `permanentStatuses: [503]`, and `StudiesController` latches on `ServiceUnavailableError` for the view duration. On 503, the Studies surface degrades quietly with a plain sentence (`Studies service unavailable.`). `main.ts` disposes `previous.studies` on SPA navigation.
- **Domain Fix (`packages/studies/src/repository.ts`)**: Fixed PGN import move ordering in `buildTreeFromMovetext` so mainline moves are appended before their variations, ensuring the mainline receives `orderIndex 0` and variations receive `orderIndex >= 1` (matching `exportPgn` and reader expectations).
- **Harness & Bridge Route (`packages/e2e-harness/src/harness.ts`)**: Wired `studiesRepository` as the 8th `ApiDependencies` field in `packages/e2e-harness` and added bridge route `POST /e2e/studies` to seed public studies with chapters, mainline >= 4 moves, 1 variation, 1 comment, and 1 NAG in 1–6 range.
- **Tests & ADR**: Unit tests in `studies-helpers.test.ts`, `studies-controller.test.ts`, and domain test `studies.test.ts`, Playwright E2E spec in `studies.spec.ts`. Documented in `docs/adr/0091-studies-viewer.md`.

## M14 Increment 23 - Learner-facing Learning UI (courses, lessons, steps) (ADR-0090)

Exposes the M10 learning backend (23 routes under `/v1/courses`, `/v1/lessons`, `/v1/steps`, previously no UI at all) as a learner UI: browse published courses, view course lessons, and work through steps.

- **Routing & Client (`packages/web/src/app/router.ts`, `packages/web/src/api/client.ts`, `models.ts`)**: Added `/courses`, `/courses/:slug`, and `/lessons/:id` routes to `router.ts`. Added `LearningApi` class and `GambitClient.learning` with `permanentStatuses: [503]` retry suppression. Defined REST models including `StepView` discriminated union.
- **Learner Interaction & Read-Only Board**: Move steps render positions on a read-only board (`setTurn(false)`) and accept SAN move attempts via a text input field, evaluated server-side by `POST /v1/steps/:id/attempt`. All steps of a lesson render on one scrolling page. Navigation adds `Learn` as a 6th topbar nav entry matching existing link styling.
- **Per-step progress survives a reload (`learning-helpers.ts`)**: `loadLesson` seeds per-step state from `GET /v1/courses/:id/progress/details` via `deriveStepAttempts`, so a step completed in an earlier session still reads `Done` on first paint. Without it the page contradicted itself after a reload — the summary read `1 / 3 steps completed` while every step showed no status. The e2e spec reloads and re-asserts.
- **503 Latching & Controller (`learning-controller.ts`)**: GETs pass `permanentStatuses: [503]` so an unconfigured deployment is not retried, and the controller latches on `ServiceUnavailableError` for the rest of that view — not the session, since `bootstrap` re-runs per SPA navigation and builds a fresh controller (ADR-0090 §7, which also corrects the same overstatement in ADR-0089). On 503, the Learn surface degrades quietly with a plain sentence in the muted `.count` voice (`Learning service unavailable.`).
- **Harness & Bridge Route (`packages/e2e-harness/src/harness.ts`)**: Wired `learningRepository` into `packages/e2e-harness` (`ApiDependencies`) and added bridge route `POST /e2e/courses` to seed published courses with lessons and steps.
- **Tests & ADR**: Unit tests in `learning-helpers.test.ts` and `learning-controller.test.ts`, Playwright E2E spec in `learning.spec.ts`. Documented in `docs/adr/0090-learning-ui.md`.

## M14 Increment 22 - Achievements UI (ADR-0089)

Exposes the M10 achievements backend (3 routes) as a section on the profile page. The plumbing is ordinary; the substance is that DESIGN.md and PRODUCT.md both name "badge walls, streak counters, and noisy gamification" as an explicit anti-reference, so the increment had to settle where that line falls before it could render anything.

- **The design decision (packages/web/DESIGN.md)**: the prohibition is about treatment, not subject matter. The section is the one List Row treatment every other list uses and adds no colour, icon, radius or accent. Tier is a word in the muted .count voice, never three metal colours; there is deliberately no progress bar. The Don't now carries that qualification and points at the component spec, so the next reader does not conclude the section violates the rule it was designed around.
- **Helpers (packages/web/src/app/achievements-helpers.ts)**: pure progressLabel and summaryLabel. unlockedAt is the only authority on an unlock, never progress >= target - the two disagree in both directions when a catalogue target moves. An absent target counts to 1, matching resolveAward's `definition.target ?? 1`, rather than rendering every one-shot achievement as "0 / undefined". Four rules, each mutation-verified against the broken version.
- **Controller and view**: requestGeneration stale-response guard as with teams and forum. A 503 hides the section rather than painting an error on every profile, because the award worker is opt-in behind ACHIEVEMENTS_ENABLED (services/gateway/src/serve.ts) and its absence is a deployment configuration, not a fault; other failures do show.
- **Client (packages/web/src/api/client.ts)**: AchievementsApi.forPlayer and .summary, keyed by player id and sending no token, because both routes are public and their answer does not vary by viewer. GET /v1/achievements is deliberately not exposed - the per-player list already carries every visible definition joined with progress.
- **Harness (packages/e2e-harness/src/harness.ts)**: wired InMemoryAchievementsRepository as achievementsRepository, the sixth optional ApiDependencies field the harness has needed. POST /e2e/achievements calls the repository's real award(), the same method the production worker calls, so the unlock follows the production rule rather than a fixture.
- **Responsive fix found by measuring, not guessing**: at 320px the trailing "bronze · 0 / 50" wrapped to three lines and took the row from 32px to 51px, so .achievement-standing refuses to shrink. A teams row with a comparably long name measures the same 51px, so multi-line rows at that width are incumbent behaviour, not a regression.
- **Rename**: .team-row-main to .row-main across teams-view, forum-view, style.css and DESIGN.md. It is a generic row-leading primitive and achievements is a third consumer with nothing to do with teams.
- **Tests & docs**: achievements-helpers.test.ts, client and a11y tests, packages/web/e2e/achievements.spec.ts covering an award that unlocks and one that does not. ADR-0089, and the DESIGN.md component spec written through the impeccable skill.

## M14 Increment 21 - Team forums UI (ADR-0088)

Exposes the M10 team forum backend (7 routes) as a usable slice: read a team's threads, open one, start a thread, reply. Increment 20 deliberately left this as its own increment.

- **Published contract corrected (packages/api/src/openapi/schemas.ts + openapi.json)**: ForumPostView listed updatedAt as required and never mentioned editedAt, while forumPostView in presenters.ts has always emitted editedAt. The spec described a field the server never sends and omitted one it always does; MessageView in the same file was already right. Regenerated with npm run openapi, not hand-edited. Pre-existing defect from M10 inc 4, fixed here because this increment is its first consumer.
- **Client (packages/web/src/api/client.ts)**: threads, thread, createThread, posts, createPost on the existing TeamsApi - the forum routes are nested under a team, so a second class would have split one resource in two.
- **Decision logic (packages/web/src/app/forum-helpers.ts)**: pure canStartThread and canReply returning a reason when they refuse. Starting a thread needs membership (403 otherwise); replying needs membership AND an unlocked thread (403 for either). A non-member on a locked thread is told about membership, because that is the obstacle that survives the thread reopening. membershipOf is reused from teams-helpers.
- **Tombstones and ordering**: postDisplayBody and threadDisplayTitle return placeholders for deleted content; sortThreads puts pinned first then most recent. The sort applies to the returned page only, which the ADR states as a limit rather than hiding.
- **Controller and views**: ForumController loads thread, posts and members together because the reply decision needs all three, maps NotFoundError to a not-found state so a private team never reads as forbidden (ADR-0069), and both routes defer their load on restorePromise so a reload does not show a member the non-member state.
- **Tests & docs**: forum-helpers.test.ts (truth table, ordering, tombstones - mutation-verified against dropping the lock check and against leaking a deleted body), client, router, a11y, and packages/web/e2e/forum.spec.ts covering two members through start-thread and reply. ADR-0088, and the DESIGN.md forum component spec written through the impeccable skill.

Prior: _Last updated: 2026-08-04 - M14 Increment 21: Team forums UI (ADR-0088)._

Prior: _Last updated: 2026-08-04 - M14 Increment 20: Teams UI (browse, view, join, leave) (ADR-0087)._


## M14 Increment 20 - Teams UI (browse, view, join, leave) (ADR-0087)

Exposes the M10 community backend (20 routes under /v1/teams/*) in the web frontend as the smallest usable slice: discover teams, view one with its members, join a public team, leave one.

- **Harness (packages/e2e-harness/src/harness.ts)**: composes InMemoryCommunityRepository as communityRepository. This is the fifth optional ApiDependencies field the harness has needed; without it every /v1/teams/* route answers 503 under GAMBIT_E2E_BACKEND=1. Still unwired: semanticSearchRepository, achievementsRepository, studiesRepository, learningRepository.
- **Client & types (packages/web/src/api/client.ts, packages/web/src/api/models.ts)**: TeamsApi with list, byId, members, join and leave, exposed as client.teams. leave resolves undefined because the shared HTTP client already returns undefined for a 204 or empty body. Team types narrow visibility and role to literal unions matching packages/community/src/model.ts rather than the presenter bare string.
- **Action logic (packages/web/src/app/teams-helpers.ts)**: pure teamAction over (team, members, viewer id) returning join, leave, or none with a reason. Encodes three server behaviours the UI can predict: joining a private team is 403, joining twice is 409, and the owner leaving is 409. Ownership is read from the viewer membership row, never team.createdBy, because ownership transfers and the creator may no longer be the owner.
- **Controller & views (teams-controller.ts, teams-view.ts)**: requestGeneration stale-response guard and dispose(), one batched resolvePlayers per render with shortId fallback, and a dedicated not-found state so a private team the viewer cannot see renders as missing rather than forbidden (ADR-0069 Existence Oracle protection). Detail load defers on restorePromise so a reload does not show a signed-in user the signed-out affordance.
- **Tests & ADR**: packages/web/test/teams-helpers.test.ts covers the full action truth table and is mutation-verified against both reading ownership from createdBy and offering join on private teams; plus api-client, a11y and packages/web/e2e/teams.spec.ts (browse, join, appear in members). Recorded in docs/adr/0087-teams-ui.md.

Prior: _Last updated: 2026-08-04 — M14 Increment 19: In-memory search index in E2E harness & search hit assertion (ADR-0086)._


## M14 Increment 19 — In-memory search index in E2E harness & search hit assertion (ADR-0086)

Wires `InMemorySearchRepository` into the backend harness (`packages/e2e-harness`) under `GAMBIT_E2E_BACKEND=1` and exposes a test-only bridge route (`POST /e2e/search-index`) to seed search fixture documents in E2E specs, closing tracked test debt from ADR-0083 §7.

- **Harness Search Index Wiring (`packages/e2e-harness/src/harness.ts`, `package.json`)**: Instantiated `InMemorySearchRepository` (from `@chess-platform/search`) and passed it to `deps.searchRepository` in `createHarness()`. Added `"@chess-platform/search": "file:../search"` to `packages/e2e-harness/package.json` dependencies.
- **Bridge Route `POST /e2e/search-index` (`packages/e2e-harness/src/harness.ts`)**: Implemented test-only bridge route to project and index player (`playerToDocument`), game (`gameToDocument`), and tournament (`tournamentToDocument`) inputs. Responds `201` with `{ indexed: <count> }` or `400` on malformed input / empty payload.
- **E2E Spec Hit Assertion (`packages/web/e2e/search.spec.ts`)**: Added E2E test that registers a user via `POST /v1/auth/register`, seeds the search index with the user's handle via `POST /e2e/search-index`, navigates to `/search?q=<handle>`, and asserts that `#search-results` renders a result row displaying the resolved handle via GraphQL hydration.
- **Documentation (`docs/adr/0083-search-ui.md`, `docs/ROADMAP.md`, `docs/adr/0086-e2e-search-index.md`, `docs/PROJECT_STATE.md`)**: Updated ADR-0083 §7, marked tracked roadmap debt resolved, created ADR-0086, and updated handover state.

Prior: _Last updated: 2026-08-04 — M14 Increment 18: Direct Messaging UI (ADR-0085)._

## M14 Increment 18 — Direct Messaging UI (ADR-0085)

Exposes the direct messaging backend (M10) in the web frontend with an inbox, conversation thread view with message sending, and profile entry point.

- **Harness Wiring (`packages/e2e-harness/src/harness.ts`, `package.json`)**: Wired `InMemoryMessagingRepository` into `deps.messagingRepository` so `/v1/messages/*` endpoints do not 503 under `GAMBIT_E2E_BACKEND=1`. Added `"@chess-platform/messaging": "file:../messaging"` dependency to `e2e-harness/package.json`.
- **Types & Client (`packages/web/src/api/models.ts`, `client.ts`)**: Added `ConversationView`, `MessageView`, `ConversationSummary`, `ConversationList`, `MessageList`, and `ConversationReadState`. Added `MessagesApi` class with `listConversations`, `messages`, `send`, `markRead`, and `openWith` methods (all `auth: true`).
- **Controller & Pure Helpers (`packages/web/src/app/messages-controller.ts`, `messages-helpers.ts`)**: Built DOM-free `MessagesController` with `requestGeneration` stale-response guard, open thread polling interval (5000ms), `markRead` call on thread load (quiet failure), single-batch player handle hydration (`client.graphql.resolvePlayers(ids)`), and pure helpers for participant derivation and tombstone rendering.
- **Views (`packages/web/src/app/messages-view.ts`)**: Pure DOM render helpers (`renderInbox`, `renderThread`) using `.panel-row` inside `.panel-list` (without `role="list"`), tombstone placeholder rendering (`"[Message deleted]"`), escaped text nodes, and `renderEmpty` states.
- **Routing, Profile & Wiring (`packages/web/src/app/router.ts`, `bootstrap.ts`, `main.ts`, `index.html`)**: Added `/messages` and `/messages/:id` routes, nav link, `#messages` and `#conversation` sections with `aria-label`s and `role="alert"` errors, composer `<form>` with `.sr-only` label, profile "Message" action calling `openWith` + SPA navigation, and controller disposal in `main.ts`.
- **Styles (`packages/web/src/style.css`)**: Added CSS rules for messaging layout, message thread items, own-message styling, composer input, and coarse-pointer touch targets according to DESIGN.md.
- **Tests & ADR**: Unit tests in `packages/web/test/messages.test.ts`, client tests in `packages/web/test/api-client.test.ts`, a11y tests in `packages/web/test/a11y.test.ts`, Playwright E2E spec in `packages/web/e2e/messages.spec.ts`, and architectural record in `docs/adr/0085-direct-messaging-ui.md`.

Prior: _Last updated: 2026-08-04 — M14 Increment 17: Playwright E2E suite stability & per-game bot RNG (ADR-0084)._

## M14 Increment 17 — Playwright E2E suite stability & per-game bot RNG (ADR-0084)

Stabilizes local E2E testing by introducing a worker concurrency ceiling and ensures bot move choice determinism across concurrent games.

- **Worker Concurrency Ceiling (`packages/web/playwright.config.ts`)**: Added `workers: Math.max(1, Math.min(4, Math.floor(cpus().length / 2)))` to clamp worker parallelism on high-core machines. Resolves severe resource contention against the single shared `e2e-harness` process and Vite preview server (which caused global test flakiness ranging from 638ms to 200,621ms on static specs).
- **Per-Game Bot RNG (`packages/e2e-harness/src/rng.ts`, `packages/e2e-harness/src/bot.ts`)**: Added `seedFrom(seed, key)` FNV-1a helper in `rng.ts` and updated `BotPlayer` in `bot.ts` to derive a dedicated RNG stream for each registered game using `createRng(seedFrom(this.seed, gameId))`. Move selection is now isolated per game ID and no longer depends on interleaved message timing under concurrency.
- **Unit Tests (`packages/e2e-harness/test/bot.test.ts`)**: Added unit tests proving that interleaved games do not perturb each other's move sequences and that different game IDs generate distinct move streams. The stubs build real `StateView` and `ApplyResult` values with no `any`; the authority stub is still cast at the construction site (`as unknown as GameAuthority`) because `GameAuthority` is a class and the bot only calls two of its members. The interleaving test was run against the previous shared-RNG implementation and fails there, so it demonstrably catches the defect it describes.
- **Documentation & ADR**: Recorded findings, benchmarks, timing rationale, and scope bounds in `docs/adr/0084-e2e-worker-cap.md` and updated `docs/ROADMAP.md` follow-ups.

Prior: _Last updated: 2026-08-03 — M14 Increment 16: Search UI (ADR-0083)._

## M14 Increment 16 — Search UI (ADR-0083)

Exposes the search backend (M11) in the web frontend with a dedicated search interface, header search bar, mode selector, and per-result hydration.

- **Types (`packages/web/src/api/models.ts`)**: Added `SearchMode` (`'keyword' | 'semantic' | 'hybrid'`), `SearchResult` (`{ id, score }`), and `SearchResults` (`{ total, results }`).
- **Client (`packages/web/src/api/client.ts`)**: Added `SearchApi` class exposed as `readonly search` on `GambitClient` with `query({ q, mode, limit, offset })` method (`auth: 'optional'`).
- **Pure Helpers (`packages/web/src/app/search-results.ts`)**: Created `parseSearchHit` (splitting namespaced entity IDs `game:<uuid>`, `player:<uuid>`, `tournament:<uuid>` on first colon without throwing on unknown/unprefixed IDs), `parseSearchMode`, and `HydratedHit` interface.
- **Controller (`packages/web/src/app/search-controller.ts`)**: Built DOM-free `SearchController` with `requestGeneration` stale-response guard, parallel `Promise.all` hydration of tournaments and games, and single-batch player ID resolution (`client.graphql.resolvePlayers(ids)`), with per-row `shortId` fallbacks for failed hydrations.
- **Views (`packages/web/src/app/search-view.ts`)**: Pure DOM render helpers (`renderSearchResults`, `renderSearchPrompt`) using `.panel-row` inside `.panel-list` (without `role="list"`), entity type labels, resolved names, links for valid `href`s, and `renderEmpty` prompt/empty states.
- **Routing & Wiring (`packages/web/src/app/router.ts`, `bootstrap.ts`, `main.ts`, `index.html`)**: Added `/search` route, header search form with `role="search"`, `#search` section with mode selector (`.cg-seg` segmented control), SPA pushState+popstate navigation, and controller disposal lifecycle in `main.ts`.
- **Styles (`packages/web/src/style.css`)**: Added styles for `.nav-search`, `.search`, and `.sr-only` complying with DESIGN.md tokens and 320px responsiveness.
- **Tests & ADR**: Unit tests in `packages/web/test/search-results.test.ts`, updated `packages/web/test/api-client.test.ts`, `packages/web/test/tournament-routes.test.ts`, and `packages/web/test/a11y.test.ts`, Playwright E2E spec in `packages/web/e2e/search.spec.ts`, and architectural record in `docs/adr/0083-search-ui.md`.
- **Deferred (search API enrichment)**: `GET /v1/search` returns `{ id, score }` only, so every result row costs a second call to resolve its display metadata. ADR-0083 §2 records the gap; the mitigations shipped are page size 10, parallel entity fetches, and one batched `resolvePlayers`. A response carrying entity type, title and snippet would remove the secondary lookups. The contract is intentionally unchanged in this increment. Tracked under "Known follow-ups (tracked)" in `docs/ROADMAP.md`.
- **Deferred (search test infrastructure)**: the E2E environment indexes no documents, so `packages/web/e2e/search.spec.ts` asserts navigation, deep links, prompt state and history behaviour — never that a query returns hits. ADR-0083 §7 records this. Functional result assertions need fixture indexing in the `e2e-harness` or direct seeding of the search tables; neither exists. Tracked in `docs/ROADMAP.md`.
- **Pre-existing debt observed, not caused, here**: the backend-gated Playwright game/seek specs flake on first attempt and pass on retry. Not introduced by this increment — those specs are untouched by its diff. Tracked in `docs/ROADMAP.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 15: Tournaments UI (read-only) (ADR-0082)._

## M14 Increment 15 — Tournaments UI (read-only) (ADR-0082)

Exposes the tournament system (M9) in the web frontend with a read-only interface for listing tournaments, viewing tournament details, standings, and live games broadcast.

- **Types (`packages/web/src/api/models.ts`)**: Added `TournamentFormat`, `TournamentState`, `TournamentSummary`, `TournamentDetail` (discriminated union on `format`: `ArenaTournamentDetail` | `SwissOrRoundRobinTournamentDetail`), `TournamentStanding` (union: `ArenaStanding` | `SwissOrRoundRobinStanding`), `TournamentLiveBoard`, and `TournamentLive`.
- **Client (`packages/web/src/api/client.ts`)**: Added `TournamentsApi` class beside `SeeksApi` and exposed `readonly tournaments: TournamentsApi` on `GambitClient`. Four methods (`list`, `byId`, `standings`, `live`), all `auth: 'optional'`.
- **Controller (`packages/web/src/app/tournament-controller.ts`)**: Pure DOM-free controller mirroring `ProfileController`'s `requestGeneration` stale-response guard and `LobbyController`'s injectable timer (`setInterval`/`clearInterval`). Manages `loadList`, `loadDetail` (branches on `detail.state === 'running'` to call `live` instead of redundant `/standings`), `startLive`, `stopLive`, `dispose`. Resolves player IDs using `client.graphql.resolvePlayers(ids)`.
- **Rendering (`packages/web/src/app/tournament-view.ts`, `packages/web/src/app/render-helpers.ts`)**: Pure DOM render functions (`renderTournamentList`, `renderTournamentDetail`, `renderStandings`, `renderLiveBoards`). Uses `.panel-row` rows inside `.panel-list`, extracted shared render helpers into `render-helpers.ts` to avoid circular dependencies, player names resolved with fallback to `shortId(id)`, links to `/tournaments/:id` and `/game/:gameId`, and format-specific standing column rendering ("Tiebreak", "🔥 On fire").
- **Routing & Markup (`packages/web/src/app/router.ts`, `index.html`)**: Added `/tournaments` and `/tournaments/:id` to `Route` union, `parseRoute`, and `routeToPath`. Added nav link and `#tournaments` / `#tournament` sections with proper `aria-label`s and `role="alert"` error elements (without `role="list"` on list containers).
- **Wiring & Styles (`packages/web/src/app/bootstrap.ts`, `style.css`)**: Exported `renderEmpty`, `formatClock`, `formatTimeControl`, `EmptyStateOptions` from `render-helpers.ts`. Wired section visibility (`showTournaments`/`showTournament`), heading update on detail load, and route handlers in `bootstrap.ts`. Added section layout styles in `style.css` matching design scale.
- **Tests & ADR**: Added `packages/web/test/tournament-routes.test.ts`, updated `packages/web/test/api-client.test.ts` and `packages/web/test/a11y.test.ts`, added Playwright E2E spec `packages/web/e2e/tournaments.spec.ts`. Documented design decisions in `docs/adr/0082-tournaments-ui.md` and updated `docs/ROADMAP.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 14: "Play vs Computer" in the Gambit lobby (frontend only) (ADR-0081)._

## M14 Increment 14 — "Play vs Computer" in the Gambit lobby (frontend only) (ADR-0081)

Adds a frontend UI dialog in the Gambit lobby for starting unrated games against engine computer opponents.

- **Types (`packages/web/src/api/models.ts`)**: Added `BotLevel` (`'novice' | 'club' | 'master'`) and `CreateBotGameRequest` (`level`, `variant`, `timeControl`, `color?`).
- **Client (`packages/web/src/api/client.ts`)**: Added `createVsBot(body: CreateBotGameRequest): Promise<GameSummary>` method to `GamesApi` (`POST /v1/games/bot`, `auth: true`).
- **Shared DOM Helper (`packages/web/src/app/dom.ts`)**: Extracted `el()` element creation helper from `create-game-panel.ts` into a pure shared module.
- **Pure Module (`packages/web/src/app/bot-levels.ts`)**: Defined `BotLevelOption`, `BOT_LEVELS` array (`novice`, `club`, `master`), `DEFAULT_BOT_LEVEL` (`'club'`), and `parseBotLevel(raw)` function.
- **Dialog Component (`packages/web/src/app/play-bot-dialog.ts`)**: Built native `<dialog>` component (`PlayBotDialog`) with difficulty selection (radios with hints), color choices (`♔`, `½`, `♚`), time control presets from `time-presets.ts`, unrated game notice, submit/cancel actions, error display, and auth gating (`setAuthenticated`, `setPending`).
- **Lobby Controller (`packages/web/src/app/lobby-controller.ts`)**: Added `createBotGame(params)` method calling `this.client.games.createVsBot(...)`, gated by `isAuthenticated`.
- **Wiring & Markup (`packages/web/src/app/bootstrap.ts`, `packages/web/index.html`)**: Added `#play-bot-mount` element in `index.html`. Wired `PlayBotDialog` in `bootstrap.ts` to call `createBotGame` with standard variant and navigate to `/game/${gameId}` on success. Updated auth state handlers for the play-bot button.
- **Styles (`packages/web/src/style.css`)**: Added `.pb-dialog` dialog styling reusing existing selection vocabulary (`.cg-chip`, `.cg-seg`, `.cg-field`, etc.), CSS custom properties, backdrop styling, and responsive layout.
- **Tests & ADR**: Added `packages/web/test/bot-levels.test.ts`, updated `packages/web/test/api-client.test.ts` and `packages/web/test/a11y.test.ts`, added Playwright E2E spec `packages/web/e2e/play-vs-computer.spec.ts`. Created `docs/adr/0081-play-vs-computer-ui.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 13: wire engine bridge into live play ("play vs computer") (ADR-0080)._

## M14 Increment 13 — Wire engine bridge into live play ("play vs computer") (ADR-0080)

Wires `@chess-platform/engine` into live backend play, exposing "play vs computer" against 3 engine bot levels without UI changes.

- **Bot Users DB Seed**: `packages/persistence/migrations/0021_engine_bots.sql` inserts 3 credential-less bot users (`gambit-novice`, `gambit-club`, `gambit-master`) with fixed v7 UUIDs and `flags = '{"bot": true}'::jsonb`. Security property: credentials live in a separate table, so credential-less rows can never authenticate.
- **Bot Catalogue**: `packages/api/src/bot/catalogue.ts` exports `BotLevel`, `BotAccount`, `BOT_ACCOUNTS`, `botAccountByLevel`, `botAccountByUserId`, mapping levels to ELO ratings (`novice` -> 1350, `club` -> 1750, `master` -> 2200). Re-exported via `@chess-platform/api`. Checked in `packages/api/test/bot-catalogue.test.ts`.
- **GameStarter Port**: Defined `GameStarter` in `packages/persistence/src/repositories.ts`, `PgGameStarter` in `packages/persistence/src/pg/repositories.ts` (`BEGIN...COMMIT`, returns `false` on unique violation), `InMemoryGameStarter` in `packages/api/src/fakes.ts`. Added `gameStarter` to `Repositories` interface in `deps.ts`, wired in `bootstrap.ts` and `fakes.ts`. Tested in `bot-game-route.test.ts` and `pg.integration.test.ts`.
- **REST Endpoint**: Added `POST /v1/games/bot` in `packages/api/src/routes.ts` (`AUTHED`). Validates `level`, `variant`, `timeControl`, `color`. Resolves unknown level with 400 listing valid levels. Resolves `color: 'random'` deterministically from hex parity of generated `gameId`. Sets `rated: false` unconditionally. Persists via `gameStarter.start()`, returns 409 conflict on duplicate gameId. Updated `CreateBotGameRequest` in `packages/api/src/openapi/schemas.ts` and `packages/api/openapi.json`.
- **Realtime Gateway Hook**: Added optional `onGameLoaded?: (gameId: string, state: StateView) => void` parameter to `RealtimeGateway` (`packages/realtime-gateway/src/gateway.ts`), guarded against repeat calls per game. Tested in `packages/realtime-gateway/test/gateway.test.ts`.
- **EngineBotMover**: Created `EngineBotMover` in `services/gateway/src/engine-bot.ts`. Executes bot moves via `CommandRouter.route(gameId, botUserId, cmd)` (respecting Redis multi-node sharding per ADR-0010, never `authority.apply`). 300ms think time, `JobPriority.BotMove` (priority 0). Caps in-flight `play()` to 1 per game via `Map<gameId, Promise>`. Safe error handling logs warnings and increments failure counter without crashing process. Emits `gateway_bot_moves_total`, `gateway_bot_move_failures_total`, `gateway_bot_move_seconds`. Tested in `services/gateway/test/engine-bot.test.ts`.
- **Gateway Hosting**: Wired `ENGINE_BOT === '1'` in `services/gateway/src/serve.ts`. Shares single `AnalysisProvider` instance between anti-cheat auto-analyzer and engine bot mover. Passes `onGameLoaded` callback to `RealtimeGateway`. Graceful shutdown calls `engineBotMover.stop()` and `sharedEngineProvider.shutdown()`.
- **Architectural Record**: Created `docs/adr/0080-engine-bot-opponent.md` (Date: 2026-08-03), updated `docs/ROADMAP.md` and `.env.example`/`docs/RUNNING.md`.

Prior: _Last updated: 2026-08-03 — Verification hygiene: an ADR claim-drift guard, and a flaky test that hid its own failure (ADR-0079)._

## Verification hygiene — ADR claim drift + the e2e-harness flake (ADR-0079)

M14 increment 11 found ADR-0010 §7 specifying six ownership metrics that had **never been
implemented** — ownership was unobservable in production for months because prose is not executable.
This closes the mechanical half of that gap.

- **`scripts/check-adr-claims.mjs`** (`npm run check:adr-claims`, wired into CI's `build-test` job)
  fails when an ADR names a repo-relative path, a metric, an `npm run` script, or a sibling ADR that
  does not exist. It is the check that would have caught ADR-0010 §7 on the day it was written.
- **It cannot tell you an ADR is TRUE.** ADR-0010 §6 was a false sentence with no missing identifier;
  only executing the system finds that, which is what ADR-0077's chaos suite is for. Env vars and
  bare filenames were deliberately left unchecked — the regexes match Redis commands and prose, and a
  noisy guard is one people switch off.
- **The audit found the corpus healthy**: 3 stale references across 78 ADRs, two of them created by
  our own ADR-0075 `nginx.conf` → `nginx.conf.template` rename. This is regression prevention, not
  cleanup, and the ADR says so rather than overselling it.
- **The e2e-harness flake is fixed by construction, not by luck.** The bot's `resignAfterPlies` lever
  (which the harness already had, and its own header calls a "determinism lever") is now set, bounding
  the game to 12–14 moves against a 300-move valve. Seeding the move choice removes one source of
  variance but was **not sufficient on its own** — seeded, the game still ran 109/155/186 moves across
  three runs, and that measurement is recorded beside the seed. 10 consecutive runs: 10 passed.
- The same failure also **hung the test file for 178s**, presenting as a frozen suite with the same
  signature as the known port-4175 conflict — which is how a real failure sends the next person down
  the wrong path entirely.

Prior: _Last updated: 2026-08-03 — M14 Increment 12: local owner lease tracking & fail-closed fast path (ADR-0078)._

## M14 Increment 12 — Local owner lease tracking & fail-closed fast path (ADR-0078)

### Eliminating the Redis round-trip on owner command routing

- **Local lease tracking in `OwnershipRegistry`**: Records monotonic expiration (`performance.now() + leaseTtlSec * 1000`) on successful claims and renewals. Renewals update expiry only when successful; failed renewals do not advance expiry.
- **Fast path in `RedisCommandRouter.route()`**: If `holdsValidLease(gameId)` is true, commands are processed locally immediately without calling `claim()` against Redis, skipping Redis network latency and avoiding total platform halt when Redis is unavailable.
- **Fail-closed safety property**: Derives conservative `safetyMarginMs` from `leaseTtlSec` and `renewalIntervalSec`. Closes the fast path before the Redis key expires in Redis, ensuring zero split-brain overlap. When Redis is down, renewals fail, the lease ages out, fast path closes, and fallback `claim()` rejects commands (failing closed).
- **Gateway observability metrics**: Added `gateway_ownership_renewal_failures_total` (counter) and `gateway_fast_path_commands_total` (counter). Registered in `serve.ts` and validated with `npm run check:observability`.
- **Chaos test suite & ADR-0010 §6 resolution**: Adjusted chaos suite `OWNERSHIP_LEASE_TTL_SEC=6` and `OWNERSHIP_RENEWAL_INTERVAL_SEC=2` in `docker-compose.chaos.yml`. Scenario D now asserts owner moves succeed during a Redis outage (inside lease window) and fail closed after lease expiry. Resolved `CONTRA-ADR FINDING` and cleared `KNOWN_OPEN_DEFECTS` (suite passes with exit 0).
- Detailed in `docs/adr/0078-owner-lease-fast-path.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 11: chaos & failover validation of multi-node game authority (ADR-0077)._

## M14 Increment 11 — Chaos & failover validation of multi-node game authority (ADR-0077)

### It found a real bug on its first honest run

**A node taking over a game validated commands against a stale aggregate**, so the surviving node
rejected a legal move (`not_your_turn`) after the owner was SIGKILLed — with the durable log proving
the move legal. Pub/sub delivers an owner's moves to *rooms*, never to the other node's authority, so
node 2's copy sat at ply 0 while the game advanced. This is the exact stale-authority failure ADR-0010
exists to prevent, reappearing at failover; `FakeRedis` single-process tests could not see it because
there is no second node holding a stale copy.

Fixed in `RedisCommandRouter`: a game is marked stale when `onClaimed` fires (which happens only on a
genuine ownership transition) and is evicted and rehydrated from the event log on the async command
path before `apply()`. Evicting inside the hook is not possible (it is synchronous, rehydration is
not) and evicting without reloading turns the rejection into `unknown_game` — both wrong turns were
taken and caught by this suite before the fix landed.

**Still open (reported, not papered over):** ADR-0010 §6 claims the owner can process its own commands
while Redis is down. It cannot — `route()` calls `claim()` on every command. Scenario D prints this as
a CONTRA-ADR finding instead of asserting the ADR's text.

### Multi-node gateway chaos test suite & observability

- **Observability metrics implementation**: Built the missing gateway metrics specified in ADR-0010 §7 using the existing `Metrics` port (`@chess-platform/api`): `gateway_owned_games` (gauge), `gateway_forwarded_commands_total` (counter), `gateway_forward_timeouts_total` (counter), `gateway_ownership_claims_total` (counter), `gateway_ownership_releases_total` (counter), and `gateway_forward_latency_seconds` (histogram with buckets `[0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5]`). Updated `/health` to expose `ownedGames` count and `ownershipRegistry: 'redis' | 'local'`. Verified against `scripts/check-observability-drift.mjs` (0 errors).
- **Two-node stack override (`docker-compose.chaos.yml`)**: Added a second gateway replica (`gateway-node2`, WS port 4177, health port 4178) alongside `gateway` (WS port 4175, health port 4176), sharing Postgres, Redis, and API containers. Shortened lease TTL (`OWNERSHIP_LEASE_TTL_SEC=3`, `OWNERSHIP_RENEWAL_INTERVAL_SEC=1`) on both nodes to make failover fast and observable. Pinned `TOURNAMENT_REPORTER: "0"` and `SEARCH_INDEXER: "0"` on node 2 so exactly one instance of each runs across the stack.
- **Automated chaos test suite (`scripts/chaos-test.mjs`)**: Plain Node ESM script verifying 4 core scenarios against the real stack:
  1. *Cross-node correctness*: Two players on different gateway nodes play alternating moves; verified zero move rejections, matching position FEN hashes, and non-owner command forwarding metric increments.
  2. *Ungraceful owner loss*: SIGKILL (`docker kill`) owner container; verified surviving node claims ownership after 3s lease TTL expiry + margin, play continues cleanly, and no move is lost or duplicated.
  3. *Graceful drain*: SIGTERM (`docker stop`) owner container; verified `releaseAll()` compare-and-delete executes and successor node claims ownership immediately (< 1.5s), measurably faster than lease TTL expiry.
  4. *Redis loss & recovery*: Stop Redis (`docker stop redis`); verified non-owner command forwarding fails, identified finding that owner node commands also fail because `RedisCommandRouter.route()` evaluates `registry.claim()` on every route; verified full recovery when Redis returns.
- **Opt-in CI workflow (`.github/workflows/chaos.yml`)**: `workflow_dispatch`-only workflow running the chaos test suite on demand without burning per-PR CI minutes.
- **Stale ROADMAP corrections**: Updated M14 deferred list in `docs/ROADMAP.md` to accurately reflect that sticky routing was evaluated and rejected in ADR-0010 (retained only as optional load balancing optimization) and that single-owner authority with Redis registry and command forwarding is implemented (what is deferred is dedicated authority shards).
- Detailed in `docs/adr/0077-chaos-failover-validation.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 10: deploy-gated CI/CD pipeline, pre-flight template validation, and release/deploy workflows (ADR-0076)._

## M14 Increment 10 — Deploy-gated CI/CD pipeline (ADR-0076)

### Automated release & deploy workflows

- **Tag-triggered release workflow (`.github/workflows/release.yml`)**: Triggered on `v*` tag pushes. Runs full verification (`npm ci`, `npm run build`, `npm test`, `npm run lint`), validates that tag version matches `deploy/helm/gambit/Chart.yaml` `appVersion`, and builds + pushes three images (`api`, `gateway`, `web`) to GHCR using `docker/build-push-action@v5`. Images are tagged with exact version and commit SHA (`latest` is never published or deployed).
- **Gated deployment workflow (`.github/workflows/deploy.yml`)**: Triggered via `workflow_dispatch` or `release: [published]`. Enforces human-approval gates via GitHub `environment:` (staging/production), queues deploys sequentially per environment (`concurrency: group: deploy-${env}, cancel-in-progress: false`), verifies image existence in GHCR with error output capture, runs a pre-flight `helm template` dry-run validation using exact composed strategy arguments, applies `deploy/environments/<env>.values.yaml`, and executes `helm upgrade` with `--atomic`, `--wait`, and explicit `--timeout 5m0s`. Blue/green is expressed as two runs via `target_color` (the colour receiving this version) and `active_color` (the colour serving traffic afterwards): unequal stages the version on the standby for preview, equal cuts over. It sets only `rollout.blueGreen.colors.<target_color>.tag=$VERSION` — never `images.api.tag`/`images.web.tag`, which the other colour falls back to as its rollback target, and which if overridden make both colours resolve to the same image and the chart refuse to render. `images.gateway.tag` moves on the cutover only, since the gateway is not colour-versioned. A blue/green initial install is refused: there is no published baseline for the standby and nothing to roll back to. Rollback is split three ways: `--atomic` reverts a failed upgrade; an explicit step covers verification failing *after* a successful upgrade, rolling back to the revision recorded before the upgrade; and when that revision cannot be determined for a release that demonstrably existed, the step refuses to act and calls for an operator rather than guessing. Uses explicit `require('node:fs')` in Node history parsing scripts.
- **Environment values files (`deploy/environments/{staging,production}.values.yaml`)**: Checked-in per-environment values files passing non-secret overrides and baseline image tags for blue/green rollback targets. Credentials are referenced via `secrets.existingSecret` or ESO integration (ADR-0044).
- **Deployment gate guard (`scripts/check-deploy-gates.mjs`)**: Plain Node ESM script (`npm run check:deploy-gates`) asserting 8 workflow invariants (environment approval gate, non-cancelling queueing concurrency, atomic helm flags, `needs:` job gating, shared helper for no `:latest` tags, release image repository alignment with `values.yaml`, no hardcoded Deployment names — which vary by rollout strategy, ADR-0075, and pre-flight `helm template` validation before `helm upgrade`). Each invariant was mutation-tested by reintroducing the defect it covers and confirming the guard fails. Wired into `.github/workflows/ci.yml` under the `helm` job.
- **Workflow flag composition snapshot tests (`scripts/helm-snapshot-test.sh`)**: Added strategy flag composition snapshot tests for `rolling`, `blueGreen`, and `canary` to ensure workflow argument composition renders cleanly.
- **Image repository reconciliation**: Reconciled `deploy/helm/gambit/values.yaml` image references to `ghcr.io/senasehs19-oss/gambit-{api,gateway,web}` matching published repositories.
- **Honest status**: No physical cluster is connected to this repository, so the deployment execution path itself is unexercised in CI. The pipeline's gate structure, concurrency controls, atomic flags, strategy flag compositions, and image repository alignment are statically verified by `check-deploy-gates.mjs` and `helm-snapshot-test.sh`.
- Detailed in `docs/adr/0076-deploy-pipeline.md`.

Prior: _Last updated: 2026-08-03 — M14 Increment 9: blue/green + canary delivery, and the web proxy repair it uncovered (ADR-0075)._

## M14 Increment 9 — Blue/green + canary delivery (ADR-0075)

### The web tier had never worked in Kubernetes

`docker/web/nginx.conf` hardcoded its upstreams as the **compose** service names (`proxy_pass
http://api:8080`). The Helm chart names Services after the release (`release-name-gambit-api`), and
nginx resolves an upstream literal when it loads its config — not per request. So the web pod exited
with `[emerg] host not found in upstream "api"` before it ever listened, taking the SPA, `/v1` and
`/ws` with it, since all three arrive through that proxy. Reproduced directly against the built
image before the fix, and again after.

No gate saw it: CI proves the manifests are schema-valid and that the image builds, and neither runs
the image against the manifests. This is the third instance of one failure mode — a hand-maintained
copy of a name that lives somewhere else (see M14 inc 8's Dockerfile build order, and the runtime
`COPY` list before it).

`docker/web/nginx.conf` is now `docker/web/nginx.conf.template`, rendered by the nginx image's
envsubst entrypoint from `API_UPSTREAM` / `GATEWAY_UPSTREAM`. `Dockerfile.web` sets the compose names
as ENV defaults (so `docker compose up` is unchanged) and the chart injects the release-prefixed
Service names. `NGINX_ENVSUBST_FILTER` restricts substitution to those two variables so envsubst
cannot rewrite nginx's own `$host` / `$uri` / `$scheme`.

### Progressive delivery

- **`rollout.strategy`**: `rolling` (the unchanged default — the default render is byte-identical to
  the previous chart apart from the upstream fix), `blueGreen`, or `canary`. Applies to **api and
  web only**.
- **Blue/green**: both colors render as separate Deployments; the primary Service selects
  `gambit.dev/color: <activeColor>`. The cutover and the rollback are the same one-value upgrade and
  neither restarts a pod or pulls an image. The standby has its own Service and preview hostname so
  the incoming version can be exercised against production dependencies first.
- **Canary**: a second track behind ingress-nginx's `canary`/`canary-weight` annotations — real
  percentage routing rather than a replica ratio, which would quantise the smallest possible canary
  at 33% with two stable pods and couple the traffic decision to the capacity decision. Optional
  `canary-by-header` for deterministic opt-in; weight 0 is valid (staged, header-only).
- **Version pairing**: the api and web variant lists are parallel, so each web pod's `API_UPSTREAM`
  addresses the api variant of its own version. A canary cohort gets the canary frontend *and* the
  canary API. This is only expressible because of the upstream fix above.
- **Exclusions, deliberate**: the gateway keeps its rolling update (a flip severs every live
  WebSocket connection, and game-command ownership per ADR-0010 is keyed by game, not version — two
  versions would both be legitimate owners), and the search indexer stays pinned at one replica.
- **Fail-closed**: unknown strategy, `activeColor` outside blue/green, a preview color with no tag of
  its own, a canary with no tag, a canary with no Ingress, and a weight outside 0–100 all fail the
  render.
- **Standing constraint**: both strategies run two API versions against one database, so migrations
  in such a release must be backward compatible with the version still serving (expand/contract).
  Concurrent migration runs are already safe — `migrate()` holds a database-wide advisory lock.

### What the tests caught

32 new assertions in `scripts/helm-snapshot-test.sh` (82 total, all passing). Four real defects were
caught before merge, each by a different reviewer:

- **The flip-invariance assertion** — *a flip changes no Deployment name, image or replica count* —
  failed on the first draft: the standby was sized at `preview.replicas: 1`, so the cutover would
  have moved all production traffic onto a single pod and scaled up afterwards. The standby now
  matches the active color's count.
- **clean-code-guard** found the preview hostname and the Ingress TLS stanza duplicated across three
  Ingresses (now `gambit.previewHost` / `gambit.ingressTls`), and that `default` swallowed a
  deliberate `preview.replicas: 0`, silently giving a staged standby full capacity.
- **Qodo (2)** found that requiring an explicit tag on the *standby* color while the active one fell
  back to `images.<component>.tag` meant a release configured with only the incoming tag rendered
  fine and then failed to render **at the moment of the flip** — the newly-inactive color having no
  tag. Both colors now fall back; what is rejected is the two resolving to the same image, which is
  the condition that actually makes a preview pointless.
- **Qodo (1)** found the one that would have broken a live cluster: under `canary` the stable track kept
  the unsuffixed Deployment name while adding `gambit.dev/track: stable` to `spec.selector`, which is
  **immutable** in `apps/v1` — so `rolling` → `canary` would have been rejected on upgrade. The
  stable track is now `…-api-stable`, so every strategy owns a distinct name set and each switch is a
  replace. A new assertion holds the strategies' Deployment names disjoint.

Every guard added here was mutation-tested by reintroducing the bug it covers (`API_UPSTREAM` back to
`api:8080`; dropping the stable track label; restoring `default` on the standby count; putting the
canary's stable track back on the unsuffixed name) and confirming it fails.

**CodeRabbit produced no review verdict on this PR** — walkthrough comment only, no
`Actionable comments posted:` line. That is the known free-plan failure mode, not a clean review.

CI's helm job gained kubeconform passes for the blue/green and canary renders, which contain objects
the default render does not.

Detailed in `docs/adr/0075-progressive-delivery.md`.

Prior: _Last updated: 2026-08-02 — M10 Increment 9: social UI on the profile page (ADR-0074), the first web increment of M10._

## M10 Social Graph Increment 1 — Pure Social Graph Domain Core (ADR-0066)

Pure, dependency-free domain core for the social graph (follows, friend requests, blocks) in `@chess-platform/social` (ADR-0066):
- **Package Foundation (`@chess-platform/social`)**: Pure TypeScript package with zero runtime dependencies. All timestamps are passed in (`at: Date`), making domain operations and tests deterministic.
- **Error Taxonomy (`src/errors.ts`)**: `SocialRuleError` carrying `SocialErrorCode` (`self_relation`, `blocked`, `already_exists`, `not_found`, `invalid_transition`, `not_authorized`).
- **Relations & Equality Primitives (`src/relation.ts`)**: `PlayerId` type, `assertDistinct(a, b)` throwing `self_relation` when `a === b` (run on all public mutations), and `normalizePair(a, b)` returning sorted ID tuples for symmetric relations.
- **Follow Graph (`src/follow.ts`)**: `FollowEdge` interface and pure queries (`isFollowing`, `followersOf`, `followingOf`). Follows are directed and require no consent.
- **Friendship State Machine (`src/friendship.ts`)**: `FriendRequest` with status `pending`, `accepted`, `declined`, `cancelled`, or `ended`. `applyFriendRequestAction` validates state transitions (only `pending` can be acted on) and actor authority (`accept`/`decline` restricted to addressee, `cancel` restricted to requester). `terminateFriendship` is the single move out of `accepted`, used when a block ends a friendship — kept beside the state machine so no other module writes a status transition. `ended` is distinct from `declined` on purpose: the history must not claim the addressee refused a request they accepted. `areFriends` and `friendsOf` query symmetric friendships. Crossing friend requests (simultaneous A→B and B→A) are rejected with `already_exists`.
- **Block Graph & Precedence (`src/block.ts`)**: Directed `BlockEdge` with symmetric enforcement. `block(A, B)` atomically removes follow edges (`A→B` and `B→A`), transitions pending requests (cancels A→B, declines B→A), and ends any active friendship. While a block exists, both blocker and blocked are barred from `follow` and `sendFriendRequest`. `unblock` removes the block without restoring past relations, so the pair must re-establish them.
- **Async Repository Port & In-Memory Adapter (`src/repository.ts`)**: `SocialGraphRepository` interface with `Promise`-returning signatures and `InMemorySocialGraphRepository` adapter implementing idempotent follows, friend request actions, blocks, and teardowns.
- **Deterministic Tie-Break Pagination (`src/ordering.ts`, `src/pagination.ts`)**: Shared `paginate` helper clamping negative `limit`/`offset` to 0. All list queries sort by timestamp descending and tie-break on counterpart `PlayerId` in **code-point** order (`compareIds`), not locale collation — the two disagree on mixed-case ids, and the Postgres adapter in increment 2 must therefore order with `COLLATE "C"`.
- **Not wired to anything yet**: domain logic and an in-memory adapter only. No migration, no route, no `bootstrap.ts` change, and `build:server` deliberately untouched — increment 2 makes it reachable.
- Detailed in `docs/adr/0066-social-graph-core.md`.

Prior: _Last updated: 2026-08-01 — M13 Observability Increment 7: span-export failure visibility + bounded retry (ADR-0063)._

## M13 Observability Increment 7 — Span-Export Failure Visibility + Bounded Retry (ADR-0063)

Span-export failure visibility, HTTP status code classification, honest delivery metrics, and bounded retries in `@chess-platform/api` (ADR-0063):
- **Async Outcome Reporting (`SpanExportOutcome`)**: `SpanTransport.send(payload)` now returns `Promise<SpanExportOutcome>` (`{ ok: true }` or `{ ok: false, retryable: boolean, reason: string }`). Export callers do not await `send()`, preserving the non-blocking `export(spans): void` contract. `send()` contains all rejections and synchronous throws, resolving to `{ ok: false, retryable: true, reason: 'network' }`.
- **`FetchSpanTransport` Classification**: `FetchSpanTransport` classifies network rejections and synchronous throws as retryable (`reason: 'network'`). On `response.ok === false`, HTTP 408, 429, and 5xx are classified as retryable (`reason: 'http_<status>'`), while all other 4xx status codes (e.g. 401, 413) are classified as non-retryable. `response.ok === true` resolves to `{ ok: true }`.
- **`OtlpJsonSpanExporter` Outcome Callback**: Added optional `onOutcome?: (outcome: SpanExportOutcome, spanCount: number, spans?: readonly SpanData[]) => void` callback to `OtlpJsonSpanExporter`. Maps payloads and delegates outcome reporting to `BatchSpanProcessor`.
- **Honest Metrics (`span_export_exported_total` & `span_export_failed_total`)**: Moved `span_export_exported_total` increment to confirmed delivery receipt (`ok: true`). Added new unlabelled counter `span_export_failed_total` incremented by the span count of a batch whose final attempt failed.
- **Bounded Retry & Memory Bound**: Bounded retries for retryable failures up to `maxExportRetries` (default 3) attempts scheduled through the existing `Scheduler` seam. Spans awaiting retry count toward `maxQueueSize`; when memory bound is hit, oldest spans (from retrying batches or fresh queue) are evicted, incrementing `span_export_dropped_total`.
- **Synchronous Non-Blocking `shutdown()`**: `BatchSpanProcessor.shutdown()` cancels pending retry tasks, counts unsent retrying spans as failed in `span_export_failed_total`, force-flushes queued spans, and finishes synchronously without hanging.
- Detailed in `docs/adr/0063-span-export-failure-visibility.md`.

Prior: _Last updated: 2026-08-01 — M13 Observability Increment 6: gateway tracing + reachable OTLP export (ADR-0062)._

## M13 Observability Increment 6 — Gateway Tracing + Reachable OTLP Export (ADR-0062)

Realtime gateway tracing, cross-node trace context propagation, and Helm OTLP configuration reachability (ADR-0062):
- **Gateway Tracer Wiring**: Wired `RecordingTracer` into `services/gateway/src/serve.ts` matching `packages/api/src/bootstrap.ts`. Configured with `serviceName: 'realtime-gateway'`, `LoggingSpanExporter`, and optional `BatchSpanProcessor(OtlpJsonSpanExporter)` gated by `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT`. Self-instrumented via existing `metrics` registry (`GET /metrics`). Sampling supported via `OTEL_TRACES_SAMPLER_ARG` (`probabilitySampler`, defaulting to `alwaysOnSampler`).
- **Targeted Gateway Spans**: Spans emitted for game commands (`gateway.command`) and cross-node command forwarding (`gateway.forward`). Noise endpoints (`/health`, `/metrics`, `/ready`) and raw WS frames are excluded.
- **Bounded-Attribute PII Discipline**: `gateway.command` carries bounded attributes (`'cmd.kind'`, `'cmd.outcome'`, `'cmd.error_code'`); `gateway.forward` carries `'forward.outcome'` and `'forward.timeout'`. Updated `BOUNDED_SPAN_ATTRS` in `@chess-platform/api` to whitelist these keys. Game ID, user ID, move UCI payload, and tokens are never added to attributes.
- **Distributed Trace Context Propagation**: Added optional `traceparent?: string` to `ForwardedCommand` wire envelope. Forwarding node writes active span context; receiving node (`OwnerCommandConsumer`) parses `traceparent` and creates child spans under the forwarder. Wire-compatible fallback to fresh root span if missing or malformed.
- **Helm OTLP Reachability**: Added `tracing` configuration block to `deploy/helm/gambit/values.yaml` (`enabled`, `otlpEndpoint`, `otlpTracesEndpoint`, `samplerArg`). Rendered onto both API and Gateway Deployments (`api.yaml`, `gateway.yaml`). Fails closed when enabled with no endpoint. Verified by 50 snapshot test assertions in `scripts/helm-snapshot-test.sh`.

Prior: _Last updated: 2026-08-01 — M14 inc 8: load baseline, and the container build was broken (see below)._

## M14 Increment 8 — load baseline + container-build repair (ADR-0065)

### `docker compose up --build` had been broken since M11 inc 5

The headline. `docs/RUNNING.md` promises a one-command local stack; it had not worked for months and
**no gate noticed**, because CI builds from the root `npm run build` chain and never builds the
container images.

Two hand-maintained lists, stale in the same way:
1. **Build order** — duplicated inside `Dockerfile.api` and `Dockerfile.gateway`, and neither gained
   `search`, `engine` or `anti-cheat` when `persistence` and `api` started depending on them. The
   build failed outright.
2. **Runtime `COPY` list** — with the order fixed the image built, then died at startup with
   `Cannot find module '@chess-platform/search'`. Same three packages missing again.

Fixed by removing the duplication: both Dockerfiles now run the root `build:server` script.
`scripts/check-docker-build-order.mjs` (`npm run check:build-order`, wired into the `build-test` CI
job) verifies statically that the chain covers every transitive dependency of `@chess-platform/api`
in a valid order **and** that each runtime stage ships them. Verified by reproducing both real
failures. Note for future work: package directory ≠ package name — `@chess-platform/core` lives in
`packages/chess-core/`, so the checker maps names from the manifests rather than deriving paths.

### Load baseline

`deploy/load` + `npm run load-test`. k6 from a pinned image (`grafana/k6:0.55.0`), no npm dependency,
matching how helm/kubeconform/promtool are used. **The k6 thresholds ARE the SLOs from ADR-0064**, so
an unachievable target fails the run instead of sitting unchallenged in a document.

Measured on one Windows workstation, single replica, near-empty dataset, generator sharing the host:

Latency figures are the **read path only** — the series the threshold enforces.

| | Measured | Target |
|---|---|---|
| Availability | 100.000% (0/50,800 5xx) | 99.5% ✅ |
| Read p99 | 98.9 ms | 250 ms ✅ |
| Read p95 | 66.4 ms | — |
| Throughput | 1,582 req/s | — |

Targets are achievable and conservative. Deliberately **not** tightened — a target tuned to an empty
database on a laptop is a promise about the wrong system.

**Five bugs in my own harness.** Three found by running it, two more by Qodo on PR #60:
the reporter printed the *aggregate* `http_req_duration` p99 while the threshold is scoped to
`{scenario:read}`, so the documented figure came from a series that blends in the registration path;
and `readPath` checked only "not 5xx", meaning a 4xx passed the check while its latency still
entered the baseline — which is exactly how the `blitz` mistake below stayed invisible. Read checks
now demand 200 and the run fails if they stop doing so.

The first three: k6's `http_req_failed` counts all
non-2xx, so the rate limiter's 429s reported 76.5% availability for a service returning zero 5xx
(fixed with `setResponseCallback`); `p(99)` is absent from k6's default summary stats, so the one
percentile the SLO is stated at printed `n/a`; and the scenario requested
`/v1/leaderboard/blitz`, but `blitz` is a *speed* and the path takes a *variant* — 9,039 silent 422s
that looked like healthy traffic (the exact vocabulary split ADR-0055 introduced).

Registration throughput remains unmeasurable from one host: 5 requests/IP/hour (ADR-0013) means the
scenario is really a rate-limiter probe, and it now asserts what it can — that the limiter sheds
load with a 429 rather than a 5xx.

Prior: _Last updated: 2026-08-01 — M13 CLOSED: SLOs, alerting, dashboards, drift guard (see below)._

## M13 — increment 8, milestone CLOSED (ADR-0064)

Increments 1–7 built the signals; nothing looked at them, which operationally equals having no
instrumentation, only more expensive. This adds the consuming half.

- **Three SLOs** (`docs/SLO.md`): API availability 99.5%, API latency 99% under 250 ms, span-export
  delivery 99%. Deliberately no gateway-latency SLO — the WebSocket path emits only connection,
  message and auth-failure counters, so one would have to be invented rather than measured.
- **Latency thresholds sit on real histogram bucket edges.** `http_request_duration_seconds` buckets
  are fixed at `0.005 … 10`; a threshold off an edge makes `histogram_quantile` interpolate and
  return an estimate that reads like a measurement. 250 ms is an actual edge.
- **Multi-window multi-burn-rate alerts** (14.4x page / 6x page / 3x ticket), thresholds derived as
  `burn x (1 - target)` rather than tuned by feel. 4xx never burns availability. No traffic means a
  NaN ratio, no series, and no alert — an idle service has no measured availability.
- **21 rules validated with the real `promtool`**, two Grafana dashboards, and a runbook per alert
  with all nine `runbook_url` anchors verified to resolve.
- **`scripts/check-observability-drift.mjs`** (`npm run check:observability`, wired into the CI
  `helm` job) cross-checks every metric referenced in `deploy/observability/**` against the names the
  source emits. This is the piece that matters: rename a counter and an alert silently stops matching
  forever, and nothing else in the suite can catch it because the rules are YAML and the metrics are
  TypeScript. Verified by making it fail — renaming `gateway_auth_failures_total` produced exit 1
  naming the metric and the file.
- **Scraping:** Prometheus must hit the API Service directly in-cluster; SEC-1 blocks `/v1/metrics`
  at the public proxy.
- **The SLO targets are unvalidated.** No production traffic, no load test (M14's 100k validation is
  still deferred). `docs/SLO.md` opens by saying so.

Also fixed stale drift in `docs/OBSERVABILITY.md`: it still described `OtlpJsonSpanExporter` as
passing outcomes via `onOutcome`, a symbol removed in ADR-0063 and replaced by `exportWithOutcome`.

Prior: _Last updated: 2026-08-01 — M12 CLOSED: pen-test pass (see below)._

## M12 — pen-test pass complete, milestone CLOSED

Full STRIDE audit of all seven trust boundaries at `c4d5bc7`, written up in `docs/SECURITY_AUDIT.md`.

**One finding, SEC-1 (Medium), fixed:** `docker/web/nginx.conf` proxied all of `/v1/` to the API and
`GET /v1/metrics` is a `PUBLIC` route, so on any deployed Gambit the whole Prometheus registry was
retrievable unauthenticated from the internet — ten series whose `route` label enumerates every
endpoint, with per-route request volume and status distribution (moderation traffic included), plus
the five `span_export_*` counters. Fixed with an exact-match
`location = /v1/metrics { return 404; }` ahead of the `/v1/` block; Prometheus scrapes the API
Service directly in-cluster, so nothing legitimate used the public path.

**The first fix was bypassable and Qodo caught it.** `splitPath` filters empty segments, so
`/v1/metrics/` resolves to the same route and serves the registry; an exact-match
`location = /v1/metrics` let it through. The initial probe forwarded that form upstream and recorded
it as "does not over-block" — a bypass written down as correct, because the probe stopped at the
proxy instead of asking what the API did with it. Now `location ~ ^/v1/metrics/?$`, verified against
a running nginx across `/v1/metrics/`, `/v1//metrics//`, `/v1/./metrics`, `/v1/foo/../metrics`, case
variation and `%20`, while `/v1/metricsfoo` and `/v1/metrics/sub` still proxy.

Guarded at both layers: an api test pins the route equivalence that makes the proxy rule's shape
load-bearing, and `scripts/smoke-test.mjs` checks both URL forms and rejects any 404 body containing
Prometheus text.

Everything else checked out: parameterised SQL throughout, moderation endpoints correctly gated to
`moderator`/`admin`, spectators unable to issue commands, scrypt + 256-bit tokens + rate limiting on
every brute-forceable endpoint, full security-header set, allowlist CORS, no internal detail in error
bodies, `shell: false` engine spawn, no committed secrets, and `npm audit --omit=dev` clean. The
audit document also states what the pass did NOT cover — no fuzzing/DAST, no load or DoS testing, no
frontend or WebAuthn crypto review, no live-cluster infrastructure review.

Prior: _Last updated: 2026-08-01 — CI: Helm chart snapshot test is now a gate (see below)._

## CI — Helm chart snapshot test wired into the `helm` job

`scripts/helm-snapshot-test.sh` (44 assertions) had been written in ADR-0057 and extended twice
since, but **nothing ever ran it automatically** — it only executed when someone remembered to.
It is now the final step of the `helm` job.

This matters because `kubeconform` only proves manifests are schema-valid. It cannot catch that
`POSTGRES_PASSWORD` must be declared before `DATABASE_URL` (Kubernetes expands `$(VAR)` only for
earlier entries), that `SEARCH_ENABLED`/`SEMANTIC_SEARCH_ENABLED` land on the right container, or
that the search indexer stays pinned to one replica. Those are exactly the regressions the script
guards, and they are invisible until a deploy.

Prior: _Last updated: 2026-08-01 — M11 Search Increment 12: embedding backfill + live embedding pipeline (ADR-0061)._

## M11 Search Increment 12 — Embedding Backfill + Live Embedding Pipeline (ADR-0061)

Vector embedding backfill (`reindexAll`) and live index worker (`SearchIndexWorker`) embedding pipeline in `@chess-platform/search`, `@chess-platform/api`, `services/gateway`, and Helm (ADR-0061):
- **Pure Domain Document Embedding**: Added `embedDocument` and `embedDocuments` to `@chess-platform/search` (`src/embed-document.ts`). Preserves `id`, `text`, and filter `fields` using conditional spread for `exactOptionalPropertyTypes` compliance. Processes inputs sequentially (since `HashingEmbeddingProvider` is CPU-bound and synchronous).
- **Single Write Path Routing**: Refactored `reindexAll` and `SearchIndexWorker` so that when `semantic` options (`{ repository, embeddingProvider }`) are supplied, writes route exclusively through the semantic repository, replacing the keyword write path. Rationale: `PgSemanticSearchRepository.index` and `indexAll` already write to both `search_documents` and `search_embeddings` inside one transaction; calling both write paths would write `search_documents` twice per document.
- **`reindexAll` Options Object Refactoring**: Converted `reindexAll` from 4 positional parameters to a unified `ReindexOptions` options object (`{ source, repository, batchSize?, onProgress?, semantic? }`), respecting the 4-argument ceiling.
- **CLI Reindex & Live Worker Wiring**: Updated `packages/api/src/scripts/reindex-search.ts` to instantiate `PgSemanticSearchRepository` and `HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS)` when `SEMANTIC_SEARCH_ENABLED !== '0'`, logging the active path. Updated `services/gateway/src/serve.ts` to pass `semantic` options to `SearchIndexWorker` under the same env gate.
- **Helm Indexer & Snapshot Test**: Updated `deploy/helm/gambit/templates/search-indexer.yaml` to set `SEMANTIC_SEARCH_ENABLED="0"` when `search.semanticEnabled` is `false`. Extended `scripts/helm-snapshot-test.sh` with matching assertions.
- **DB-Gated Integration Tests**: Added `packages/api/test/semantic-pipeline.integration.test.ts` (gated on `DATABASE_URL`, namespaced via `uuidv7()`), verifying that `reindexAll` populates `search_embeddings` in Postgres and that `querySemantic` successfully retrieves seeded entities.
- **Operator Backfill Requirement**: Documented plainly in ADR-0061 and deployment guide that populating pre-existing data into `search_embeddings` is a manual operator step (`npm run reindex-search -w @chess-platform/api`).
- Detailed in `docs/adr/0061-embedding-pipeline.md`.

Prior: M11 Search Increment 11 — REST Endpoint Wiring for Semantic and Hybrid Search (ADR-0060)

## M11 Search Increment 11 — REST Endpoint Wiring for Semantic and Hybrid Search (ADR-0060)

REST API search endpoint (`GET /v1/search`) support for semantic and hybrid search modes in `@chess-platform/api` (ADR-0060):
- **Search Mode Query Parameter**: Added optional `mode` query parameter (`mode=keyword|semantic|hybrid`, default `keyword`) to `GET /v1/search`. Invalid `mode` values return 422 validation errors (`"mode" must be one of keyword, semantic, hybrid`).
- **Keyword Mode Unchanged**: `mode=keyword` (and default when `mode` is omitted) preserves exact byte-for-byte existing behavior and response shape. Requires `deps.searchRepository` or returns 503 (`search is not configured`).
- **Semantic & Hybrid Mode Requirements**: `mode=semantic` and `mode=hybrid` require both `deps.semanticSearchRepository` and `deps.embeddingProvider`, returning 503 (`semantic search is not configured`) if either dependency is missing.
- **Filter-Aware Query Embedding**: For vector embedding input, `parseNaturalQuery` output extracts relevance terms and phrases (`[...query.terms, ...query.phrases].join(' ')`), stripping filter tokens (e.g. `variant:blitz`) to prevent noisy filter tokens from skewing vector distance calculations. Falls back to raw `q` when no terms/phrases exist.
- **Search Execution & Filtering**: `mode=semantic` executes `semanticSearchRepository.querySemantic(vector, { limit, offset, filters: query.filters })`, ensuring natural query filters constrain the vector result set. `mode=hybrid` executes `semanticSearchRepository.queryHybrid(query, vector, { limit, offset })` (where filters are applied internally across both keyword and vector RRF CTE branches).
- **Constant Export & Schema Coupling**: Exported `SEARCH_EMBEDDING_DIMENSIONS = 256` constant from `@chess-platform/search` (re-exported via package index) with explicit comment documenting strict coupling to `vector(256)` in `packages/persistence/migrations/0014_search_embeddings.sql`.
- **Production Wiring & Test Harness**: Configured production bootstrap in `bootstrap.ts` gated by `SEMANTIC_SEARCH_ENABLED !== '0'` (defaulting to `PgSemanticSearchRepository` and `HashingEmbeddingProvider(SEARCH_EMBEDDING_DIMENSIONS)`). Updated test harness (`HarnessOptions.withoutSemanticSearch`) with `InMemorySemanticSearchRepository` and `HashingEmbeddingProvider` exposed on `Harness`.
- **OpenAPI 3.1 & Integration Tests**: Regenerated `packages/api/openapi.json` with `mode` enum and updated 503 response docs. Added comprehensive integration tests covering mode defaults, semantic ranking, hybrid union/RRF fusion, filter parsing & exclusion from vector generation, mode validation, 503 unconfigured states, and pagination.
- **Helm Wiring**: New `search.semanticEnabled` value (default `true`) renders `SEMANTIC_SEARCH_ENABLED=0` on the API Deployment, so the switch is actually reachable in a Kubernetes deployment (the gap ADR-0057 fixed for `SEARCH_ENABLED`). `scripts/helm-snapshot-test.sh` grew from 39 to 43 assertions.
- **DEFERRED Gap**: Documented plainly that no production worker or projection pipeline populates `search_embeddings` yet; `mode=semantic` in production returns an empty page until an embedding backfill/projection increment lands.
- Detailed in `docs/adr/0060-semantic-search-rest-wiring.md`.

Prior: M11 Search Increment 10 — pgvector Semantic Adapter (ADR-0059)

## M11 Search Increment 10 — pgvector Semantic Adapter (ADR-0059)

PostgreSQL `pgvector` semantic vector search adapter (`PgSemanticSearchRepository`) and schema migration `0014_search_embeddings.sql` in `@chess-platform/persistence` (`/pg` subpath) (ADR-0059):
- **Schema & Extension Migration (`migrations/0014_search_embeddings.sql`)**: Created extension `vector` and table `search_embeddings` (`id TEXT PRIMARY KEY REFERENCES search_documents(id) ON DELETE CASCADE`, `embedding vector(256) NOT NULL`). Configured HNSW vector index (`search_embeddings_embedding_idx`) using `vector_cosine_ops` for low-latency cosine distance queries (`<=>`).
- **Separate Table Design Rationale**: Embeddings live in a separate table (`search_embeddings`) joining `search_documents`, keeping `remove(id)` and `clear()` honest on `SemanticSearchRepository` (deleting embeddings without touching keyword documents in `search_documents`).
- **Shared Query Helpers (`src/pg/search-helpers.ts`)**: Extracted `canonicalizeFields`, `formatPgVector`, `buildTsqueryExpr`, and `buildJsonbFilterClauses` into a shared module used by both `PgSearchRepository` and `PgSemanticSearchRepository` to ensure zero drift in field canonicalization, full-text tsquery building, or JSONB containment filtering.
- **PgSemanticSearchRepository (`src/pg/semantic-search.ts`)**: Implements `SemanticSearchRepository` port over a `pg.Pool`. Serializes vector parameter inputs as `$N::vector` without string interpolation. Handles transactional upserts (`index`/`indexAll`), selective semantic removals (`remove`/`clear`), and `size()`.
- **Cosine Distance to Similarity Mapping**: `querySemantic` converts pgvector cosine distance (`<=>`) to cosine similarity via `1 - (e.embedding <=> $q::vector)` so that higher scores represent higher similarity ("higher score = more similar"). `minScore` thresholding is mapped to the bare-operator distance predicate `e.embedding <=> $q::vector <= 1 - minScore` (the index-friendly form, kept so the predicate stays usable once the fast path below lands). The query vector is bound **lazily**: the count query only references it when a `minScore` predicate exists, and Postgres rejects a Bind supplying more parameters than the statement uses, so eager binding broke `querySemantic(vector)` with no filters outright.
- **SQL Reciprocal Rank Fusion (`queryHybrid`)**: Fuses keyword FTS (`kw` CTE) and vector search (`vec` CTE) via SQL Reciprocal Rank Fusion (`COALESCE(kwWeight / (rrfK + kw.rnk), 0) + COALESCE((1 - kwWeight) / (rrfK + vec.rnk), 0)`). Handles empty keyword queries, validates parameters throwing `RangeError`, and filters `WHERE score > 0` so `keywordWeight: 1` and `keywordWeight: 0` return strictly their respective modality's documents.
- **Planner Mechanics — MEASURED (pgvector 0.8.5, 5,000 × 256-dim rows, `EXPLAIN ANALYZE`)**: the `, d.id` tie-break **alone** defeats the HNSW index. The join and the jsonb `@>` filter do NOT — both keep an `Index Scan` (0.43 ms / 0.18 ms); adding the tie-break drops the plan to a top-N `Sort` over a full `Seq Scan` (5.89 ms). The tie-break is deliberately retained for pagination determinism, so **the HNSW index is not currently exercised by any adapter query** — it exists for the follow-up fast path. That fast path (ANN candidates via the index in an inner query, re-sorted outside) is deferred on purpose: pgvector 0.8's iterative scans are off by default, so an inner `LIMIT` plus a filter can under-return, and choosing a recall policy deserves its own increment. Full numbers in ADR-0059.
- **Hybrid Filter Correctness (fixes ADR-0058 behaviour, `@chess-platform/search` + adapter)**: `query.filters` now constrain the SEMANTIC branch as well as the keyword branch, in both `hybridSearch` and `queryHybrid`. Previously a document violating a hard constraint parsed from the query text (e.g. `variant:blitz`) could re-enter through the vector branch and surface in the fused results. Regression tests at both layers.
- **Test Isolation Fix (`packages/persistence/package.json`)**: persistence tests now run with `--test-concurrency=1`. `PgSearchRepository.size()` counts `search_documents` globally, and the new semantic suite writes to that same table, so parallel test files raced and broke the pre-existing keyword suite's relative-size assertions. These are integration tests sharing one database; serializing them is the honest expression of that.
- **DB-Gated Integration Tests (`test/semantic-search.integration.test.ts`)**: Added namespaced, hermetic integration test suite covering migration, indexing, similarity ranking, upsert, removal, `minScore` thresholding, JSONB metadata filters, pagination, hybrid union/extremes, and 256-dimension vector mismatch error handling.
- Detailed in `docs/adr/0059-pgvector-semantic-adapter.md`.

## M11 Search Increment 9 — Semantic Search Domain Core (ADR-0058)

Pure, dependency-free domain core for vector and hybrid search in `@chess-platform/search` (ADR-0058):
- **Pure Vector Math (`src/vector.ts`)**: Added `Vector` type (`readonly number[]`) and functions `dot`, `magnitude`, `cosineSimilarity` (bounded in `[-1, 1]`), and `normalize`. All vector functions validate finite components via `assertFinite` throwing `RangeError` on `NaN`/`Infinity`. Dimension mismatches throw `RangeError` with explicit length details. Zero-magnitude vectors return `0` similarity and normalize to zero vectors of equal length. `cosineSimilarity`/`normalize` scale by the largest absolute component before squaring, so entirely finite inputs near `Number.MAX_VALUE` cannot overflow into a `NaN` score or a silently zeroed unit vector.
- **Embedding Provider Port & Offline Hashing Adapter (`src/embedding.ts`)**: Defined async `EmbeddingProvider` interface (`dimensions`, `embed`, `embedAll`) ensuring `@chess-platform/search` stays dependency-free while accommodating external model providers. Implemented `HashingEmbeddingProvider` using deterministic 32-bit FNV-1a hashing (`fnv1a32`) for offline, reproducible vectorization in CI.
- **Shared Filter Module (`src/filters.ts`)**: Extracted `matchesAllFilters`, `matchesFilter`, and `getFieldValue` into a shared module for keyword and vector search rankers without altering `search.ts` external behavior.
- **Pure Vector Similarity Ranker (`src/semantic.ts`)**: Created `SemanticSearchableDocument` interface and `semanticSearch` ranker evaluating cosine similarity, enforcing `minScore` thresholding, applying field filters, and sorting results `score DESC`, tie-broken by `id ASC`.
- **Hybrid Search via Reciprocal Rank Fusion (`src/hybrid.ts`)**: Implemented `hybridSearch` fusing keyword FTS and vector search via Reciprocal Rank Fusion (RRF, `1-based rank` score `weight / (rrfK + rank)`). Solves term-frequency vs cosine-similarity scale incompatibility with scale-invariant rank fusion. Validates `keywordWeight` in `[0, 1]` and `rrfK > 0`.
- **Semantic Repository Port & In-Memory Adapter (`src/semantic-repository.ts`)**: Created `SemanticSearchRepository` interface (`index`, `indexAll`, `remove`, `clear`, `size`, `querySemantic`, `queryHybrid`) and `InMemorySemanticSearchRepository` adapter. The index latches its embedding dimension on first write and rejects mismatched documents there (released again whenever the index becomes empty, via `clear()` or removal of the last document), so one bad insert cannot break reads for the whole repository. Documented pgvector cosine-distance (`<=>`) mapping (`1 - distance`) for future persistence adapters.
- **Shared Pagination Contract (`src/pagination.ts`)**: Moved `SearchOptions`, `SearchPage`, and a new `paginate` helper out of `repository.ts` (which re-exports both types, so the package's public API is unchanged and `PgSearchRepository` keeps importing them from the package root). Both `InMemorySearchRepository` and `InMemorySemanticSearchRepository` now share one implementation of the clamping rules — negative `offset`/`limit` clamp to `0`, an omitted `limit` returns all remaining hits, `total` counts hits before pagination — so keyword and semantic paging cannot drift apart.
- **Deferred**: pgvector persistence adapter (`PgSemanticSearchRepository`) and REST API wiring deferred to Increments 10 and 11.
- Detailed in `docs/adr/0058-semantic-search-core.md`.

## M14 Increment 7 — Search Indexer Deployment (ADR-0057)

Helm wiring for the live search indexer, pinned to one replica (ADR-0057):
- **Dedicated Deployment (`deploy/helm/gambit/templates/search-indexer.yaml`)**: renders `<fullname>-search-indexer` when `gateway.searchIndexer.enabled=true` (default `false`), running the gateway image with `SEARCH_INDEXER=1`. `replicas: 1` is hard-coded, not a value — the worker's dedup set is process-local, so N replicas would each index every finished game.
- **No Service**: the pod takes no client traffic. It binds the WS/health ports because it reuses `serve.ts`, but with no clients it never claims game ownership and stays inert in the Redis ownership registry (ADR-0010). Probes target the pod directly.
- **`SEARCH_ENABLED` reachable from Helm (`templates/api.yaml`)**: new `search.enabled` value (default `true`); when `false` the API gets `SEARCH_ENABLED=0` and `GET /v1/search` returns 503 per ADR-0055.
- **Fail-closed**: `gateway.searchIndexer.enabled=true` with `search.enabled=false` fails at template time instead of indexing into an index nothing serves.
- **Gateway template comment**: records that `SEARCH_INDEXER` is deliberately absent there, so it is not added later — unlike `TOURNAMENT_REPORTER`, duplicate indexing is not made safe by CAS.
- **Explicit rollout strategy**: `RollingUpdate` with `maxSurge: 1, maxUnavailable: 0`. `Recreate` was rejected — `gamesEndedChannel()` is Redis pub/sub (fire-and-forget), so terminating the old pod first would drop every game finishing in the gap; a brief two-pod overlap only duplicates idempotent work.
- **Verification**: `scripts/helm-snapshot-test.sh` extended with assertions for opt-in default, `replicas == 1`, the pinned strategy, `SEARCH_INDEXER` absent from the gateway, no added Service, the fail-closed combination, and the `SEARCH_ENABLED` kill switch. 35 passed / 0 failed locally. Default render stays 13 resources; indexer-enabled is 14.
- **CI wiring PENDING**: `.github/workflows/ci.yml` could not be committed (integration lacks the GitHub App `workflows` permission), and the snapshot script has never run in CI. Indexer rendering is not continuously verified until a step invoking it is added.
- **Debt note**: this closes the single-replica-Deployment debt for the indexer only. `TOURNAMENT_REPORTER` (safe via CAS), `BOT_AUTO_ANALYZE` and `ANTICHEAT_AUTO_ANALYZE` remain per-replica; shared distributed leadership stays tracked.
- Detailed in `docs/adr/0057-search-indexer-deployment.md`.

Prior: M11 Search Increment 8 — Live Incremental Game Search Indexing (ADR-0056)

## M11 Search Increment 8 — Live Incremental Game Search Indexing (ADR-0056)

Event-driven live game search indexing triggered by `gamesEndedChannel()` broadcasts (ADR-0056):
- **Single-Game Read Path (`@chess-platform/persistence`)**: Added `findGame(id: string): Promise<GameDocumentInput | null>` to `SearchBackfillSource` port and implemented in `PgSearchBackfillSource` reusing column selection + JOINs.
- **Package Boundary & Local Subscriber Port (`@chess-platform/api`)**: Declared local structural `SearchIndexSubscriber` port (`subscribe(channel, handler): () => void`) avoiding an `api` -> `realtime-gateway` package dependency.
- **Live Worker Architecture (`SearchIndexWorker`)**: Created `SearchIndexWorker` in `@chess-platform/api` with defensive payload type guards, bounded FIFO dedup set (`MAX_SEEN = 10_000`), error containment, and deterministic `await worker.drain()` test hook.
- **Aborted Games Decision**: Aborted games (`result: '*'`) and non-existent games (`null`) are explicitly skipped during live indexing.
- **Gateway Hosting (`services/gateway/src/serve.ts`)**: Hosted worker gated on `SEARCH_INDEXER=1`, suppressed by `SEARCH_ENABLED=0`, and wired to graceful process shutdown (`worker.stop()`).
- Detailed in `docs/adr/0056-live-search-indexing.md`.

## M11 Search Increment 7 — Search Projections, Backfill & Production Wiring (ADR-0055)

Search entity projections, keyset-paginated backfill source, production wiring, and reindex CLI (ADR-0055):
- **Entity Projections (`@chess-platform/search`)**: Added `gameToDocument`, `playerToDocument`, and `tournamentToDocument` in `projections.ts` mapping local structural inputs into canonicalized `SearchableDocument` records with namespaced IDs (`game:<id>`, `player:<id>`, `tournament:<id>`) and a `type` field (`game` | `player` | `tournament`). Zero external runtime dependencies.
- **Security & PII Exclusion**: Player documents strictly index `handle` and optional `country`. User `email`, `email_hash`, and `flags` are explicitly excluded from indexed search documents, proven by automated regression test.
- **Backfill Source (`@chess-platform/persistence`)**: Added `SearchBackfillSource` interface port and `PgSearchBackfillSource` PostgreSQL implementation using bound parameter keyset (cursor) pagination (`WHERE id > $1 ORDER BY id ASC LIMIT $2`). JOINs `users` on `games` to resolve player handles.
- **Production Wiring (`@chess-platform/api`)**: Wired `PgSearchRepository` in `createPgDependencies` in `bootstrap.ts`, with operator opt-out via `SEARCH_ENABLED=0` environment variable (degrading `GET /v1/search` to HTTP 503).
- **Reindex CLI**: Added `reindex-search.ts` script in `packages/api/src/scripts/` (registered as `npm run reindex-search -w @chess-platform/api`), paging all entity kinds in batches (~500) and upserting into `search_documents` idempotently.
- **Vocabulary Realignment & Player-Relative Query Deferral**: Realigned natural vocabulary (`speed` vs `variant`, canonical codes, `match`/`matches` -> `game`, draw result mapping). Removed player-relative terms (`won`, `lost`, `white`, `black`) from `NATURAL_VOCABULARY`, deferring player-scoped natural queries ("games I won") to Increment 8 (authenticated search mode).
- **Absolute Operator Kill Switch**: Hardened `SEARCH_ENABLED=0` in `bootstrap.ts` to act as an absolute kill switch (setting `deps.searchRepository` to `undefined` unconditionally).
- **Reindex Core & Idempotency**: Extracted pure `reindexAll` helper in `packages/api/src/search/reindex.ts`, verified idempotent across multiple runs.
- **Round-Trip Testing**: Added `search-roundtrip.test.ts` verifying end-to-end matching of projected entity documents via `parseNaturalQuery` against `InMemorySearchRepository`.
- Detailed in `docs/adr/0055-search-projections-and-wiring.md`.

## M11 Search Increment 6 — Search REST API (GET /v1/search) (ADR-0054)

Public, read-only search REST API endpoint `GET /v1/search` in `@chess-platform/api` (ADR-0054):
- **Endpoint & Routing**: Added `GET /v1/search` route (public policy) accepting required `q` query string, optional bounded `limit` (default 20, max 100), and optional `offset` (default 0, non-negative integer validation).
- **Query Processing**: Runs natural language query normalizer `parseNaturalQuery(q)` from `@chess-platform/search` and executes `deps.searchRepository.query(query, { limit, offset })`.
- **Response & OpenAPI Schemas**: Returns `{ total, results }` matching `SearchResults` schema (`SearchResult` items with `id` and `score`).
- **Optional Dependency & 503 Guard**: Injected `searchRepository?: SearchRepository` on `ApiDependencies` / `RouteDeps`. Throws `HttpError.unavailable('search is not configured')` (503) when `searchRepository` is absent, mirroring anti-cheat moderation routes.
- **Test Harness**: Wired `InMemorySearchRepository` into `startHarness`, controllable via `withoutSearch` option.
- **Deferred**: Populating search index (projections from entities) and wiring `PgSearchRepository` in `bootstrap.ts` deferred to later increments.
- Detailed in `docs/adr/0054-search-rest-api.md`.

Prior: M11 Search Increment 5 — Postgres full-text adapter (PgSearchRepository) (ADR-0053)

Durable Postgres full-text adapter `PgSearchRepository` in `@chess-platform/persistence` implementing `SearchRepository` (ADR-0053):
- **Schema & Migration (`0013_search_documents.sql`)**: `search_documents` table with `id TEXT PRIMARY KEY`, `text TEXT`, `fields JSONB`, and stored generated `tsv tsvector` using `'simple'` configuration, with GIN indexes on `tsv` and `fields`.
- **`PgSearchRepository` Adapter**: Implements `SearchRepository` (`index`, `indexAll` with atomic transaction, `remove`, `clear`, `size`, `query`) in `@chess-platform/persistence/pg`.
- **Parameterized Query Building**: Query translator converting terms via `plainto_tsquery('simple', $N)` and phrases via `phraseto_tsquery('simple', $N)`, combined with `&&`. Case-insensitive field filters using `lower(fields->>$N) = lower($M)` or `IS DISTINCT FROM` for negation. All user inputs passed as SQL bound parameters ($1, $2, ...) ensuring zero SQL injection.
- **Scoring & Pagination**: `ts_rank(tsv, tsquery)` scoring when text terms/phrases exist (0 otherwise for filter-only/empty queries ordered `id ASC`), separate total count query before appending `LIMIT` / `OFFSET`.
- **Integration Testing**: Ephemeral Postgres integration test (`search.integration.test.ts`) covering index, query, upsert, remove, field filters, negation, and pagination, cleanly skipping when `DATABASE_URL` is unset.
- **Deferred**: pgvector semantic vector search adapter and REST/GraphQL API integration deferred to later M11 increments.
- Detailed in `docs/adr/0053-pg-search-repository.md` and `docs/DATABASE.md`.

Prior: M11 Search Increment 4 — Async SearchRepository port (ADR-0052)

Async `SearchRepository` port and in-memory adapter signatures in `@chess-platform/search` (ADR-0052):
- **SearchRepository Port**: Updated interface methods to return Promises (`index`, `indexAll`, `remove`, `clear`, `size`, `query`) enabling future I/O-backed adapters (Postgres full-text and pgvector semantic search) to perform async operations.
- **InMemorySearchRepository Adapter**: Updated method implementations to `async`, returning resolved Promises with unchanged Map-backed storage, query evaluation, and pagination semantics.
- **Contracts Unchanged**: `SearchOptions` and `SearchPage` data contracts remain unchanged; no consumers outside `@chess-platform/search` were affected.
- Detailed in `docs/adr/0052-async-search-repository.md`.

Prior: M11 Search Increment 3 — Natural-language query normalization (parseNaturalQuery) (ADR-0051)


Bounded, rule-based natural language query normalizer in `@chess-platform/search` (ADR-0051):
- **Normalizer (`parseNaturalQuery`)**: `parseNaturalQuery(input: string): SearchQuery` layers on `parseSearchQuery(input)` (preserving explicit `field:value` filters and quoted `"phrases"` intact), promotes recognized chess vocabulary words among bare terms into non-negated filters, drops stop words, and deduplicates filters by `(field, value, negated)` preserving first-occurrence order.
- **Vocabulary & Stop Words**: `NATURAL_VOCABULARY` maps recognized terms to structured filters (variants: `blitz`, `bullet`, `rapid`, `classical`, `chess960`/`960`, `atomic`, `crazyhouse`, `horde`, `antichess`; colors: `white`, `black`; results: `win`/`won`/`wins`/`winning`, `loss`/`lost`/`losses`/`lose`, `draw`/`draws`/`drew`/`drawn`/`tie`/`tied`); `NATURAL_STOP_WORDS` drops 27 filler words carrying no search signal.
- **Pure & Total**: Operates strictly in memory without I/O or external dependencies, returning a structured `SearchQuery` consumable by existing matchers and repositories.
- **Deferred**: Semantic vector embeddings and LLM-based query understanding deferred to later M11 increments.
- Detailed in `docs/adr/0051-natural-query-normalization.md`.

Prior: M11 Search Increment 2 — SearchRepository port + in-memory adapter (ADR-0050)

Stateful repository abstraction and in-memory adapter in `@chess-platform/search` (ADR-0050):
- **SearchRepository Port**: `SearchRepository` interface with `index(document)`, `indexAll(documents)`, `remove(id)`, `clear()`, `size()`, and `query(query, options)`.
- **Pagination Contracts**: `SearchOptions` (`limit`, `offset` with negative value clamping to `0`) and `SearchPage` (`total` matching hit count across index independent of pagination limits, and `results` containing sliced `SearchResult[]`).
- **InMemorySearchRepository Adapter**: Pure, dependency-free Map-backed adapter storing `SearchableDocument`s by `id` (upsert semantics). Delegates query evaluation to Increment 1's `search` ranker and slices results deterministically (`start = Math.max(0, offset ?? 0)`, `end = limit === undefined ? allHits.length : start + Math.max(0, limit)`).
- **Deferred**: Postgres full-text search and pgvector semantic adapters deferred to later M11 increments.
- Detailed in `docs/adr/0050-search-repository.md`.

Prior: M11 Search Increment 1 — pure-domain keyword search core (ADR-0049)

Pure, dependency-free `@chess-platform/search` domain package delivering keyword search core (ADR-0049):
- **Tokenizer**: `tokenize(text: string): string[]` splitting text into lowercase alphanumeric tokens using Unicode-aware regex (`/[^\p{L}\p{N}]+/u`).
- **Query Parser**: `parseSearchQuery(input: string): SearchQuery` parsing free-text input into `terms`, `phrases` (`"quoted phrase"`), and `filters` (`[-]field:value` or `field:"value"`). Non-throwing, hand-rolled whitespace/quote tokenizer handling empty values (`field:` as term) and unterminated quotes cleanly.
- **In-Memory Search Matcher & Ranker**: `search(query, documents): SearchResult[]` performing AND-matching across exact case-insensitive filters (including negated filters `-field:value`), required term-tokens, and contiguous phrase token sublists. Ranks hits by term token frequency plus phrase bonus (`2 * phraseMatches`), tie-broken deterministically by `id` ASC.
- **Deferred**: pgvector persistence, semantic embeddings, and REST/GraphQL API surfaces deferred to later M11 increments.
- Detailed in `docs/adr/0049-search-domain-core.md`.

Prior: M13 Increment 5 — span-export pipeline self-instrumentation (metrics) (ADR-0048)

Self-observing span export pipeline in `@chess-platform/api` (ADR-0048):
- **BatchSpanProcessor Self-Instrumentation**: Emits Prometheus counters via `metrics?: Metrics` in `BatchSpanProcessorOptions` to surface pipeline health at `GET /v1/metrics`.
- **Counters**: `span_export_received_total` (spans accepted), `span_export_dropped_total` (spans evicted on overflow + post-shutdown drops), `span_export_exported_total` (spans dispatched downstream), and `span_export_batches_total` (batches dispatched downstream).
- **Cardinality Discipline**: Counters carry NO labels (cardinality and PII safe).
- **Dropped Count Agreement**: `span_export_dropped_total` and `processor.droppedSpans` stay in exact agreement.
- **Bootstrap Wiring**: In production `bootstrap.ts`, passes the shared `metrics` instance to `BatchSpanProcessor` on the OTLP path.
- **Deferred**: True export-FAILURE counters + retries remain deferred to the async-exporter increment (synchronous `void` export cannot confirm collector receipt).
- Detailed in `docs/adr/0048-span-export-metrics.md` and `docs/OBSERVABILITY.md`.

Prior: M13 Increment 4 — BatchSpanProcessor (buffered, batched span export) (ADR-0047): Buffered and batched span export decorator `BatchSpanProcessor` in `@chess-platform/api` (ADR-0047):
- **BatchSpanProcessor**: Decorator implementing `SpanExporter` in `src/ports/batch-span-processor.ts` buffering finished spans and flushing them in batches of size `maxExportBatchSize` (default: 512).
- **Scheduler Seam & Periodic Flush**: Periodic flush every `scheduledDelayMillis` (default: 5000ms) to bound span loss window; `Scheduler` seam with `intervalScheduler` default (unref'd `setInterval`) and manual scheduler test helper.
- **Bounded Queue**: Bounded by `maxQueueSize` (default: 2048). Drops oldest spans on overflow and increments `droppedSpans` counter.
- **Lifecycle & Containment**: `forceFlush()` drains queue in batch chunks; `shutdown()` cancels scheduled task and force-flushes (idempotent); downstream export exceptions are contained.
- **Bootstrap Wiring**: In production `bootstrap.ts`, wraps ONLY `OtlpJsonSpanExporter` inside `MultiSpanExporter` when `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. Logging export stays direct per-span.
- **Deferred**: Retries remain deferred (sync `void` `export` contract cannot signal failure).
- **Detailed in `docs/adr/0047-batch-span-processor.md` and `docs/OBSERVABILITY.md`.**

Prior: M13 Increment 3 — span export seam + OTLP/JSON exporter (ADR-0046): Span export abstraction, reusable `LoggingSpanExporter`, fan-out `MultiSpanExporter`, pure `toResourceSpans` OTLP/JSON payload builder, and `OtlpJsonSpanExporter` over an injectable `SpanTransport` in `@chess-platform/api`.
- **Exporter Seam**: `SpanExporter` port (`export(spans: readonly SpanData[]): void`) in `src/ports/span-export.ts` with best-effort, non-blocking contract.
- **Whitelisting**: Exported `pickBoundedAttrs` and `BOUNDED_SPAN_ATTRS` (`http.method`, `http.route`, `http.status_code`) as single source of truth; removed bootstrap local copy.
- **Exporters**: `LoggingSpanExporter` (same structured JSON log output as inc 2), `MultiSpanExporter` (composite fan-out with try/catch error containment), and `spanSinkFromExporter` adapter.
- **OTLP/JSON Exporter**: `src/ports/otlp-span-exporter.ts` defines OTLP/JSON interfaces (`OtlpTracesPayload`, `OtlpSpan`, etc.), pure mapping `toResourceSpans` (kind/status enums, `BigInt` nanosecond timestamps, `toOtlpAnyValue` type conversion, omitted `parentSpanId` when null), and `OtlpJsonSpanExporter` delegating to `SpanTransport`. Includes `FetchSpanTransport` boundary adapter.
- **Bootstrap Wiring**: In production `bootstrap.ts`, if `OTEL_EXPORTER_OTLP_ENDPOINT` is set, builds `OtlpJsonSpanExporter` alongside `LoggingSpanExporter` via `MultiSpanExporter`; otherwise uses `LoggingSpanExporter` alone.
- **Deferred**: Buffered/batched async export and retries remain deferred (spans currently export per-`end()`).
- Detailed in `docs/adr/0046-span-export-otlp.md` and `docs/OBSERVABILITY.md`.

Prior: M13 Increment 2 — tracing and propagation (ADR-0045): Request span emission, deterministic sampling, and outbound `traceparent` propagation in `@chess-platform/api`.
- **Tracer Port**: `Tracer`, `Span`, `SpanData`, `NullTracer`, `RecordingTracer`, `InMemorySpanRecorder` ring buffer in `packages/api/src/ports/tracer.ts`.
- **Sampling**: `alwaysOnSampler` default and deterministic `probabilitySampler(ratio)` based on the first 8 hex chars of `traceId`. Respects inbound `parentSampled` decision.
- **Trace Context Propagation**: Hand-rolled `formatTraceparent` (`00-<traceId>-<spanId>-<flags>`), `generateSpanId`, and `isSampled` in `traceparent.ts`. Router sets outbound `traceparent` header on every response.
- **Server Spans**: Per-request `http.server` span in `router.ts`, attributed with route pattern (`http.route`), HTTP method (`http.method`), and numeric status code (`http.status_code`). Sets span status to `'error'` for status >= 500 and `'ok'` for <500.
- **Production Exporter**: Production `bootstrap.ts` injects a `RecordingTracer` emitting finished spans to structured logs (`JsonLogger`) with a `pickBoundedAttrs` whitelist (`http.method`, `http.route`, `http.status_code`), maintaining PII and cardinality discipline.
- Detailed in `docs/adr/0045-tracing-and-propagation.md` and `docs/OBSERVABILITY.md`.

Prior: M14 Increment 6 — external-secrets (ADR-0044): External Secrets Operator (`external-secrets.io/v1`) integration for the Gambit Helm chart (`deploy/helm/gambit/`).
When `secrets.externalSecrets.enabled=true`, the chart renders an `ExternalSecret` custom resource (`apiVersion: external-secrets.io/v1`) that ESO reconciles into a Kubernetes Secret named `<fullname>-secret`, sourced from a backing SecretStore / ClusterSecretStore.
- `spec.target.name` equals `include "gambit.secretName" .` so `api` and `gateway` Deployments consume `ACCESS_TOKEN_SECRET` and `POSTGRES_PASSWORD` via `secretKeyRef` with zero modifications to Deployment manifests.
- The inline Opaque `Secret` and its fail-closed min-length checks are skipped in ES mode.
- `secrets.externalSecrets` and `secrets.existingSecret` are strictly mutually exclusive (fail-closed in chart).
- CI workflow validates the external-secrets render case via `kubeconform -strict -ignore-missing-schemas`.
- Detailed in `docs/adr/0044-external-secrets.md`, `deploy/helm/gambit/README.md`, and `docs/DEPLOYING.md`.

Prior: M12 Anti-Cheat Increment 8 (ADR-0043): Production engine wiring and gateway hosting for anti-cheat auto-analyzer (createEngineProviderFromEnv, createEngineBackedAnalysisService, serve.ts ANTICHEAT_AUTO_ANALYZE=1 hosting block and graceful engine shutdown).


Prior: M12 Bot Detection Increment 6 (ADR-0041): Automatic auto-analysis worker and gateway hosting for bot detection (BotAnalysisService, BotAutoAnalyzer, refactored analyze route, serve.ts BOT_AUTO_ANALYZE=1 hosting block).

Prior: M12 Bot Detection Increment 4 (ADR-0039): Bot detection service and report repository (`BotDetectionService` & `BotBehaviorReportRepository` with `InMemoryBotBehaviorReportRepository` in `@chess-platform/anti-cheat`, `AnalyzeBotAndStoreInput`, `GameBotReport`, idempotent `(playerId, gameId)` nested-map upsert, `analyzeAndStore` and `aggregatePlayer` composition).


Prior: M12 Bot Detection Increment 3 (ADR-0038): Move-timing extraction (`extractTimedMoves` in `@chess-platform/anti-cheat`, `MoveTiming`, `GameTimings`, minimal decoupled projection from `MovePlayedEvent.moveTimeMs`, `isBook` predicate seam for opening-book exclusion).

Prior: M12 Bot Detection Increment 1 (ADR-0036): Pure domain behavioral move-time analyzer (`analyzeBotBehavior` in `@chess-platform/anti-cheat`, `TimedMove` timing interface, mean/stdev move time, coefficient of variation, near-instant move fraction, lowConfidence gate, and deterministic suspicion banding).

Prior: M12 Anti-Cheat Increment 7 (ADR-0035): Automated auto-analysis worker (`gamesEndedChannel` fan-out in `@chess-platform/realtime-gateway`, single-owner authority broadcast, `AntiCheatAutoAnalyzer` worker in `@chess-platform/api` with dedup, at-least-once safety, crash-safe error handling, and drain hook).

Prior: M12 Anti-Cheat Increment 6 (ADR-0034): On-demand analysis-trigger pipeline (`FinishedGameSource` port + `EventStoreGameSource` adapter, `AntiCheatAnalysisService` application service, and `POST /v1/moderation/anti-cheat/games/:gameId/analyze` endpoint, audited and `MODERATION`-gated, 503 when unconfigured).

Prior: M12 Anti-Cheat Increment 5 (ADR-0033): Postgres persistence (`anti_cheat_reports` table, `PgAntiCheatReportRepository` with atomic `saveBatch` transactions and `(player_id, game_id)` upsert) and read-only moderation REST API (`GET /v1/moderation/anti-cheat/players/:playerId` and `GET /v1/moderation/anti-cheat/players/:playerId/games`, audited, `moderator`/`admin`-gated).

Prior: M12 Anti-Cheat Increment 4 (ADR-0032): AntiCheatService and AntiCheatReportRepository port with an in-memory adapter. The pure orchestration composes earlier increments into a usable flow: analyzing a game, saving both players' reports atomically via `saveBatch` keyed by `(playerId, gameId)` for idempotency, and fetching reports to aggregate an account-level signal.

Prior: M12 Anti-Cheat Increment 3 (ADR-0031): EngineBackedEvaluator adapter bridging the pure anti-cheat domain to the real @chess-platform/engine. Adds extractPlies to parse full games, negates resulting position evaluation to price sub-optimal moves, and safely handles terminal positions. Prior: M12 Anti-Cheat Increment 2 (ADR-0030): cross-game, account-level
suspicion aggregation in `@chess-platform/anti-cheat`. `aggregatePlayer(games)` combines a player's
per-game `PlayerCorrelationReport`s (the side the account played each game) into one
`PlayerAggregateReport` by **pooling** raw numerators/denominators (never averaging per-game rates —
a 3-ply game must not weigh like a 60-ply one), with sample-weighted ACPL and pooled T1/T3. Increment
1's report now exposes those raw counts (`t1Matches`/`t3Matches`/`tRateSampleCount`/
`rawCentipawnLossTotal`/`cappedCentipawnLossTotal`); the suspicion thresholds are shared constants so
per-game and aggregate bands can't diverge. An aggregate confidence gate (`AGG_MIN_GAMES=3`,
`AGG_MIN_POOLED_TRATE=40`) means one anomalous game can't flip an account while many individually
low-confidence games can still form a confident aggregate; duplicate `gameId`s are rejected so a
retried history read can't double-count. `flaggedGameIds` drills reviewers to the anomalous games.
Pure domain, no I/O/DB wiring (later increment). **Review note:** the increment was reconstructed on
current `main` — Gemini's branch had been cut from a stale `main` and built the aggregator on the
pre-review *blended* per-game report, which would have reverted Increment 1's per-player separation
and CodeRabbit fixes; aggregation is now correctly per-player. Prior: M12 Anti-Cheat Increment 1
(ADR-0029): the `@chess-platform/anti-cheat` pure domain package with `analyzeGame` — ACPL (raw +
per-ply-capped), T1/T3 match rates, only-move + opening-book exclusions, `lowConfidence`, and
deterministic suspicion bands (`clean`/`review`/`high`) over a `PositionEvaluator` port; splits by
side into a per-player `{ white, black }` report so a cheater isn't diluted by the opponent's human
moves. Prior: M13 Observability, Increment 1 (ADR-0028), completed in a review pass:
the `Logger`/`Metrics`/`traceparent` ports the router referenced were missing (branch did not
build) — they are now implemented (dependency-free `JsonLogger`/`NullLogger`,
`InMemoryMetrics`/`NullMetrics` with Prometheus `render()`, W3C `traceparent` parse), wired through
the composition root (shared metrics instance for the recorder + `GET /v1/metrics`; `JsonLogger`
in production `bootstrap.ts`), plus review fixes: bounded failure-path metric cardinality
(`req.method` → known verb or `OTHER`), a `gateway_auth_failures_total` counter via a wrapped
`TokenVerifier`, and `startHarness` extended to inject readiness/logger. Port + endpoint +
redaction + traceparent tests added; PII/cardinality rules enforced (never label by userId/gameId/
handle/IP; never log tokens/emails/bodies). Prometheus `/metrics` also exposed on the gateway
health port; readiness verifies real dependencies. Prior: WebAuthn security review fixes (post-merge of ADR-0027): (1) User
Verification is now **enforced** — options request `userVerification: 'required'` and both
register- and login-verify reject an authenticator-data flag with UV (0x04) unset (previously
a touch-only assertion authenticated, downgrading the guarantee); (2) login failures are now a
single uniform 401 — rpIdHash / User-Present / User-Verification / flag-invariant checks funnel
into the same failure path instead of throwing 422, closing a response-code oracle; (3)
deleting an account's only passkey when no password is set is refused with 409 (lockout guard).
Regression tests added (UV-absent register/login, uniform-401 across auth failures, last-passkey
delete). Prior: Playable Alpha Increment 2: Production game action controls (resign, offer draw, accept/decline draw, claim flag, abort) implemented in the web UI via GameSync. Prior: Playable Alpha Increment 1: Seek Acceptance (atomic match provisioning, frontend lobby play button). Prior: M4 Identity Hardening inc 2 review hardening: strict
typed `clientDataJSON` validation, complete authenticator-extension framing,
signature-counter regression protection, and reusable dummy verification key. Prior: M4 Identity Hardening inc 2: WebAuthn (passkeys) support
(ADR-0027): `webauthn_credentials` Postgres table + `WebAuthnCredentialsRepository`, auth-service logic for credential parsing/signature verification with `node:crypto` (ES256), and `POST /v1/auth/webauthn/*` endpoints with decoy flows. Prior: M4 Identity Hardening inc 1: password reset + email verification
(ADR-0026): `users.email` (CITEXT UNIQUE) + `identity_tokens` (hashed, single-use, TTL),
`EmailSender`/`IdentityTokensRepository` ports, three new `/v1/auth` endpoints with
anti-enumeration + rate limiting, full-session revocation on reset. Prior: M9 inc 13: Durable tournament result recording in production
(ADR-0025): optimistic concurrency (version CAS) on `TournamentsRepository`, the
`TournamentResultReporter` promoted from the e2e harness into `@chess-platform/api` and
hosted by `services/gateway` behind `TOURNAMENT_REPORTER=1` (startup rehydration + periodic
re-scan for games launched by other processes). **M1–M9 complete, M12 inc 1–3 complete, M14 increments 1–4 complete (M14 overall still in progress).** Prior: Repo review pass: fixed the two tournament routes that
predated the Arena format and never gained its dispatch — `POST
/v1/tournaments/:id/games/:gameId/result` (always 409'd for arenas; arenas had NO
result-recording path through the REST API) and `GET /v1/tournaments/:id/live`
(always 409'd for arenas) — plus `ArenaService` domain-error → HTTP mapping
(unknown gameId is now 404, not 500). Docs (README/AI_HANDOVER/ROADMAP) re-synced
with reality (M9 ✅, M12 🚧, live test counts). Prior: M9 inc 12: Arena realtime game lifecycle (ADR-0024). Prior: M9 inc 11: Arena through the API + persistence (ADR-0023). Prior: M9 inc 10: Arena tournament format (domain model) (ADR-0022). Prior: M9 inc 9: Tournament robustness (ADR-0021). Prior: M9 inc 8: Tournament Commentator AI feature (ADR-0020). Prior: M9 inc 7: Live tournament broadcast (ADR-0019). Prior: M9 inc 6: Real-time tournament integration (ADR-0018). Prior: M9 inc 5: Tournament game lifecycle (ADR-0017). Prior: M9 inc 4: Postgres adapter for tournament persistence. Prior: M9 inc 3: Tournament persistence & REST API (ADR-0016). Prior: M9 inc 2: Swiss pairing + round-by-round port evolution (ADR-0015). Prior: M12 inc 3: rate limiting for sensitive auth endpoints (ADR-0013). Prior: M14 increment 4 (Kubernetes Helm chart). **M7, M8, M9, M14 inc 1–4 complete.** Prior: Review #03 fixes applied:
the authoritative `legalMoves` map from the server snapshot is now surfaced through `GameSync`
state (populated from each `StateView`, stale after a live move broadcast, empty once the game ends)
and a new `AuthoritativeMoveOracle` adapter implements the existing `LegalMoveOracle` port, fed by
the `GameSync` state's `legalMoves` map — no chess rules in the client, no `@chess-platform/core`
import in `web`. This is step 2 of the server-backed `LegalMoveOracle` (ADR-0003, Option 2). Prior
context below. **Increment 3C-2A (prior):**
the authoritative realtime `StateView` now carries a typed `legalMoves` map (origin square →
legal destinations for the side to move), **computed server-side by the perft-verified core engine**
in the realtime-gateway `GameAuthority` and empty once a game is over; the WS protocol and its web
mirror (`ws-protocol.ts`) are extended in lockstep, with the frontend consuming the contract only
(no chess rules in the client, no `@chess-platform/core` import in `web`). This is step 1 of the
server-backed `LegalMoveOracle` (ADR-0003, Option 2 — legal moves embedded in the authoritative
state). Prior context below. **Increment 3C-1:**
the web frontend's application **composition root** landed — a single `packages/web/src/app/`
layer (`createApp` + `resolveConfig` + `mountBoard` + `bootstrap`) that assembles the object graph
via dependency injection: the REST stack (`GambitClient` = `HttpClient` + `SessionManager`), the
realtime `WsClient`, and a per-game `GameSync` factory, with browser adapters (`fetch` / `WebSocket`
/ `localStorage`) as defaults and fakes injected in tests. `main.ts` is now a thin DOM entry and the
UI stays separate from infrastructure (the board module composes UI + core only). This increment is
**wiring only**: no connection is opened, no gameplay synchronization or server-backed move oracle is
implemented. Web suite 121 tests green (strict-TS + lint clean, production build passes). Prior context
below. **Increment 3B (prior):**
the web frontend's WebSocket foundation + gameplay synchronization landed — a `WebSocketConnection`
port + browser adapter, a typed `WsClient` (connection state machine, automatic reconnect with
exponential backoff + jitter, ping/pong heartbeat with silent-link detection), hand-authored
wire-protocol models mirroring `packages/realtime-gateway/src/protocol.ts` with a JSON codec, and a
`GameSync` synchronization layer (join/resume lifecycle, authoritative snapshot + live move ledger,
optimistic move tracking with `clientSeq`-based confirm/rollback, ply-gap resync, presence/ended/
draw-offer state). Framework-independent, networking kept separate from UI; no lobby/matchmaking/
profile UI yet. Web suite 115 tests green (strict-TS + lint clean, production build passes). Prior
context below. **Milestone 5 COMPLETE:** the
`@chess-platform/engine` package is implemented, tested (51/51), and reviewed. ADR-0002 is
**Accepted**. Whole repo now 170 tests green. This commit ships the engine bridge and updates
the handover. Base commit before this one: `c465fba` ("docs: refine M5 engine-bridge design"). The
prior refinement note (kept for history): a ten-point review adding an `EngineManager` orchestrator,
a plugin + capability-discovery model, an `AnalysisProvider` abstraction above UCI, a cache **port**
(reversing the earlier durable-Postgres choice), and reliability seams (isolation, hot
replacement, graceful shutdown, health). **No engine code is written until the gate is
approved.** Base commits: `f7c588e` (M4 api) → `cb19dec` + `4703f23` (M5 gate opened)._

---

## Historical archive notice

> The sections from “1. Snapshot” onward are retained as point-in-time handover
> records. Their test totals, “next” instructions, and statements that work is
> deferred or in progress describe the state when each section was written; they
> are not current status. Use the dated delivery entries above and
> [`ROADMAP.md`](ROADMAP.md) for current status and remaining work.

## 1. Snapshot (historical; superseded)

- **Product:** *Gambit* — AGPL-3.0 open-source chess platform aiming at feature
  parity with Lichess/Chess.com plus a first-class AI layer. Intended to be a
  commercial product scaling to millions of users.
- **Repo model:** npm-workspaces monorepo, Node ≥20, **strict TypeScript**,
  dependency-free domain packages, tests via the built-in `node --test` runner.
- **Method (applied every milestone):** build to explicit acceptance criteria with
  tests → self-critique loop → multi-perspective review (distributed-systems,
  performance, security, chess-server maintainer) → advance only when clean.

## 2. Completed milestones (historical snapshot)

| M | Package | Result | Tests |
|---|---|---|---|
| **M1** ✅ | `@chess-platform/core` | Variant-aware, perft-verified rules engine (0x88, immutable `Position`, FEN/UCI/SAN, 8 variants, terminal detection, repetition-key derivation) | 16/16 |
| **M2** ✅ | `@chess-platform/game` | Event-sourced `Game` aggregate + deterministic clocks; threefold repetition (en-passant legality-aware repetition key in `@chess-platform/core`); exact reconstruction via `Game.fromEvents` (~1.17ms/game) | 26/26 |
| **M3** ✅ | `@chess-platform/realtime-gateway` | Server-authoritative WS protocol, `GameAuthority`, rooms/presence/fanout, resume, latency comp; `PubSub`/`Transport` seams; token-based auth (`TokenVerifier` port, ADR-0004); durable `EventLog` port + Redis `PubSub` (M14) | 56/56 |
| **M4a** ✅ | `@chess-platform/persistence` | Durable append-only event store (in-memory + Postgres), migrations, repositories, Glicko-2, UUIDv7 | 14/14 (+5 DB-gated) |
| **M4b** ✅ | `@chess-platform/api` | Stateless REST + identity (scrypt/`PasswordHasher`, HMAC access tokens, rotating refresh tokens, RBAC), seeks/ratings/games, published OpenAPI 3.1 | 48/48 |
| **M5** ✅ | `@chess-platform/engine` | Provider-agnostic UCI engine bridge: `AnalysisProvider`/`EngineManager`/`EnginePool`/`EngineInstance`/`EnginePlugin`/`AnalysisCache`/`EngineTransport`; capability discovery, priority scheduler, watchdog/cancellation, crash→hot-replacement, circuit breaker, graceful drain, health | 50/50 |
| **M6** ✅ | `@chess-platform/web` | Playable web frontend: interactive board (drag/click, premoves, promotion), REST + WS client, GameSync, lobby, profile, theme, PWA, a11y; Playwright e2e + Lighthouse gate passed | 239 |
| **M7** ✅ | `@chess-platform/ai-orchestrator` | Provider-agnostic AI orchestration: `AiProvider`/`AiOrchestrator`/`ProviderRegistry`/`RoutingStrategy`/`ResponseCache`/`RateLimiter`/`HealthTracker`/`BenchmarkRunner`; OpenAI + Anthropic adapters; engine grounding | 114 |
| **M8** ✅ | `@chess-platform/ai-features` | 8 AI features: Move Explainer, Puzzle Generator, Mistake Predictor, Opening Explorer, Endgame Trainer, Coach, Study Partner, Voice Coach; Tournament Commentator deferred to M9 | 137 (16 key-gated) |
| **M9** ✅ | `@chess-platform/tournament` | **Increment 1 (pure domain):** tournament aggregate with a `registration → running → finished` state machine, a `PairingStrategy` port, `RoundRobinPairing` (circle-method/Berger schedule — every pair once, one bye per player for odd N, balanced colors), and Sonneborn-Berger standings (ADR-0014). **Increment 2 (Swiss pairing):** round-by-round `PairingStrategy` port (`pairNextRound(context): Round \| null`), `SwissPairing` (deterministic Monrad/Dutch-lite — score-group pairing via a complete backtracking match that never drops a player, no rematches, best-effort color balancing, configurable round count, graceful early finish when the field is exhausted), `Tournament` aggregate auto-advances round-by-round, `TournamentConfig` discriminated union (`round_robin` / `swiss`); full FIDE Dutch deferred (ADR-0015). **Increment 3 (persistence & API):** `TournamentSnapshot`-based persistence (`toSnapshot`/`restore`), an in-memory `TournamentsRepository` adapter, and a REST API (create/list/get/register/withdraw/start/record-result/standings) with OpenAPI schemas and `tournament_director` authorization (ADR-0016). **Increment 4:** Postgres adapter `PgTournamentsRepository` + `0003_tournaments.sql`. **Increment 5 (Game lifecycle):** gameLinks in aggregate, API GameLauncher port, reconcileLaunch loop in TournamentService, and recordResultByGame (ADR-0017). **Increment 6 (Real-time integration):** AuthorityGameLauncher mapping tournament pairings to realtime GameAuthority games, TournamentResultReporter subscribing to PubSub EndedBroadcast to auto-record results, per-pairing launch-attempt counter so aborted games auto-relaunch, implemented purely via composition root (ADR-0018). **Increment 7 (Live broadcast):** `TournamentLiveView` port (api) + `TournamentBroadcaster` (composition root) multiplexing every active game's live board, `tournamentChannel` fanout of `TournamentUpdateBroadcast` to spectators, and a public `GET /v1/tournaments/:id/live` returning live boards + standings (ADR-0019). **Increment 8 (Tournament Commentator):** `TournamentCommentator` AI feature in `ai-features` providing engine-grounded live commentary on games and data-grounded narrative round recaps (ADR-0020). **Increment 9-10:** Tournament robustness, Arena domain model (ADR-0021, ADR-0022). **Increment 11:** Arena persistence and API (ADR-0023). **Increment 12:** Arena realtime game lifecycle, continuous launching, result recording, and settle on read (ADR-0024). | 35 tournament + api lifecycle |
| **M12** 🚧 | Security hardening & Anti-cheat | **Increment 1:** CORS policy + security response headers for the API (`withSecurity` middleware — ACAO allowlist, credentials-aware, preflight short-circuit, `X-Content-Type-Options`/`Referrer-Policy`/`X-Frame-Options`/CSP/CORP/HSTS); ADR-0011 Accepted. **Increment 2:** httpOnly refresh-token cookie — API sets `HttpOnly; SameSite=Strict; Path=/v1/auth; Max-Age=<ttl>; Secure` cookie on login/refresh; refresh/logout accept cookie or body token; web stops persisting refresh token to `localStorage`; access token in memory only; ADR-0012 Accepted. **Increment 3:** Rate limiting for auth endpoints — API injects a `RateLimiter` port (`InMemoryRateLimiter` default) to protect `/v1/auth/{login,register,refresh}`, returns `429 Too Many Requests` with `Retry-After`; ADR-0013 Accepted. **Increment 4:** Anti-cheat engine-correlation analyzer (pure domain package), ACPL/T1/T3 match rates, forced-move exclusion, and suspicion banding (ADR-0029). **Increment 5:** Cross-game, account-level suspicion aggregation — `aggregatePlayer` pools per-game per-player reports (weighted ACPL, pooled T1/T3), an aggregate confidence gate, and duplicate-game rejection (ADR-0030). **Increment 6:** EngineBackedEvaluator adapter and extractPlies bridging to real engine (ADR-0031). **Increment 7:** AntiCheatService and AntiCheatReportRepository orchestrating the flow (ADR-0032). | 77/77 (+4 inc 3) + 31 anti-cheat |
| **M13** 🚧 | Observability | **Increment 1:** Hand-rolled zero-dependency JSON logger and Prometheus text metrics implementation (`InMemoryMetrics`), strictly isolated as domain ports (`Logger` / `Metrics`). W3C `traceparent` parsing in API router, injecting request context (traceId, logger). Automated HTTP route cardinalities. Gateway instrumented with metrics and logs. (ADR-0028 Accepted) | — |
| **M14** 🚧 | Deployable services | Docker Compose local stack (inc 1), durable EventLog + Postgres (inc 2), Redis pub/sub multi-node fanout (inc 3), Kubernetes Helm chart (inc 4); Terraform/blue-green/load-test deferred | — |

**Whole-repo total: 1049 tests passing, 0 failures, across 13 packages + the gateway service** (31 skips, all environment-gated — Postgres/API-key/Redis; `npm run test:counts` prints the live per-package breakdown). Strict TS, zero errors, lint clean. CI active — 6 jobs: build+typecheck+test on Node 22/24, Postgres integration, M6 Playwright + Lighthouse acceptance, helm lint + kubeconform, gateway service (build + Redis integration).

## 3. Architecture summary (historical snapshot)

- **Dependency arrow points at the domain:**
  `core ← game ← realtime-gateway`, and `core, game ← persistence ← api`. Domain
  packages have zero runtime deps; infra (WebSocket, Redis, Postgres) enters via
  documented seams, never domain code.
- **Server is the authority.** Clients send intents; the authority validates via
  the core engine, appends to an event log, and broadcasts authoritative frames.
- **Event sourcing.** A game is an append-only `GameEvent[]`; state is a pure fold.
  The `persistence` event store makes this durable and reconstructable.
- **`api` is stateless.** Access tokens are self-contained (HMAC-SHA256), so any
  instance can serve any request with no shared session store; refresh tokens and
  identity live in Postgres via `persistence` repositories.
- **Realtime wire protocol (as of Review #03):** The `JoinMessage` now carries a
  `token` (not a client-asserted `userId`); the gateway derives identity exclusively
  from the token via a `TokenVerifier` port (ADR-0004). When the token is absent, the
  connection joins as an anonymous spectator; when present but invalid, the join is
  rejected with `unauthorized`. The `MoveBroadcast` now carries a `legalMoves` map
  (origin square → legal destinations for the side to move), computed server-side by
  the core engine — clients never derive legality themselves (ADR-0003, Option 2).

### `api` package design (this milestone)

- **HTTP:** Node built-in `http` + a **typed router** (`src/http/router.ts`).
  Routes couple their OpenAPI contract, auth policy, and handler. Handlers take a
  `RequestContext`, return a `HandlerResult`; the router is the only code that
  touches the socket. Standard JSON error envelope `{ error: { code, message,
  requestId, details? } }` with `X-Request-Id` on every response.
- **DI:** `createApiServer(deps)` is the composition root (`src/server.ts`). Deps =
  `{ repos, hasher, tokens, clock, ids, config }`. No module-level singletons.
- **Passwords:** `PasswordHasher` abstraction (`src/auth/password.ts`); default
  `ScryptPasswordHasher` (Node `crypto.scrypt`, self-describing encoding
  `scrypt$N=..,r=..,p=..$salt$hash`, timing-safe). Argon2id/KMS = drop-in, no data
  migration. Login runs a decoy verify for unknown handles (anti-enumeration).
- **Access tokens:** `AccessTokenService` (`src/auth/tokens.ts`), compact HS256
  JWS, constant-time verify, `exp` enforced against the injected `Clock`. Only the
  exact pinned header is accepted (no alg-confusion / `alg:none`).
- **Refresh tokens:** opaque 256-bit random, stored only as SHA-256 hash,
  **single-use with rotation** (`rotated_from` chain). Replaying a rotated token is
  treated as **theft** and revokes the whole chain (audited `auth.refresh.reuse`).
- **RBAC:** enforced declaratively per route (`AuthPolicy.anyRole`) and re-checked
  in handlers where ownership matters (seek cancellation).
- **Ports (injectable seams):** `Clock`, `IdGenerator` (UUIDv7), and an
  `AuditRepository` extension (`src/ports/`). In-memory fakes for every repository
  live in `src/fakes.ts`; the Postgres bootstrap is isolated behind
  `@chess-platform/api/pg` (`src/bootstrap.ts`, includes `PgAuditRepository`).
- **OpenAPI 3.1:** generated from the live route table (`src/openapi/`), served at
  `GET /v1/openapi.json` and published to `packages/api/openapi.json` via
  `npm run openapi`. A test asserts every `$ref` resolves and every route is
  documented, so the spec can never drift from the served contract.
- **Minimal dependencies:** everything is `node:crypto`/`node:http`. Root entry has
  no third-party runtime dep; `pg` only enters through the `/pg` subpath.

## 4. Key engineering decisions (historical log)

1. **REST-first for M4; GraphQL deferred to M10–M11** (commit `15d6bb1`).
2. **M4 split:** `persistence` (durable data) then `api` (stateless REST).
3. **DB engine = PostgreSQL** — one ACID boundary for event log + projections.
4. **Event-store ordering = per-game append `seq`**, not chess `ply`.
5. **EventStore / repositories are seams** (in-memory + Postgres), mirroring M3.
6. **`api` uses scrypt behind `PasswordHasher`** rather than a hard argon2id
   dependency: keeps the domain dependency-free and lets deployments choose the KDF
   without touching service code. The DB column stores an opaque, self-describing
   hash, so the choice is reversible.
7. **Access = stateless HMAC token, refresh = opaque rotating token.** Access
   tokens scale horizontally (no DB read on the hot path); refresh tokens give
   server-side revocation + theft detection. This is the standard split.
8. **Repository interface extension:** added `SeeksRepository.findById` to
   `persistence` (needed for seek-ownership checks) and defined an `AuditRepository`
   port in `api` (write side of the existing `audit_log` table). Additive only;
   all existing persistence tests stay green.

## 5. Deferred work / follow-ups (historical snapshot)

- **Tournaments (M9 follow-ups):** items 1 (production result reporter) and
  2 (optimistic concurrency for `TournamentsRepository`) from the 2026-07-18
  review are **CLOSED by M9 inc 13** (ADR-0025). Still open:
  1. Arena `withdraw` is permanent by design — `register` after `withdraw`
     does not re-admit the player (the domain keeps them in `withdrawn`).
     Lichess-style pause/rejoin needs an explicit domain decision + ADR.
  2. Reporter refinements (ADR-0025 consequences): an event-log catch-up read
     for `EndedBroadcast`s missed between game end and first subscription, and
     a dedicated single-replica reporter Deployment instead of
     one-reporter-per-gateway-replica.
- **Identity (M4 → M14):** WebAuthn/passkey storage, server ceremonies, and the real
  browser registration/sign-in/management flow are implemented (ADR-0027, ADR-0108).
  Password-reset + email verification APIs are implemented (M4 identity hardening
  inc 1); their web UI is the next bounded roadmap item.
- **API hardening (M12):** request rate limiting / quotas, CORS policy, security
  headers, and body-shape strictness (reject unknown fields — schemas already
  declare `additionalProperties: false`; validators currently ignore extras).
- **Authority ↔ EventStore wiring:** connect `GameAuthority` to the durable
  `EventStore` — **deferred to the deployable service in M14** per DATABASE.md §3.3;
  the seam is ready.
- **Core (M1):** per-variant perft suites; Chess960 castling-by-file; PGN parser.
- **Game (M2):** per-variant timeout rules.
- **Realtime (M3):** ship `ws` + Redis production adapters (M14); MessagePack
  frames; per-user connection quotas / backpressure (M12).
- **Token-storage tradeoff (web):** **Resolved in M12 inc 2** (ADR-0012).
  The refresh token now lives in an `httpOnly` cookie (not `localStorage`),
  and the access token is kept in memory only. See ADR-0012 for details.

## 6. Technical debt (historical snapshot)

1. **`LICENSE` — ✅ DONE** (AGPL-3.0, commit `d295ad2`).
2. **CI — ✅ ACTIVE.** `.github/workflows/ci.yml` runs **six** jobs on every push/PR
   to `main`: build + typecheck + test on Node 22.x/24.x, the Postgres
   integration job (persistence against a real database), the M6 acceptance
   gate (Playwright full-game e2e + Lighthouse a11y ≥ 0.95), the M14 Helm
   job (`helm lint` + `helm template | kubeconform` for both the bundled and
   external-datastore renders), and the **gateway service** job (build + Redis
   integration tests). The formerly staged copies (`docs/ci/ci.yml`,
   `deploy/helm/ci.yml`) have been merged into the live workflow and deleted.
3. **Lockfile — ✅ DONE.** The root `package-lock.json` is committed and CI
   installs with `npm ci` for reproducible builds.

## 7. Milestone 4 — historical status & next steps

**Status: COMPLETE.** Both packages shipped, green, and reviewed.

**✅ `packages/api` (`@chess-platform/api`):** see §3 for the design. Endpoints
(v1): `health`, `openapi.json`, `auth/{register,login,refresh,logout,sessions}`,
`users/me`, `users/:handle` (+ `/ratings`, `/games`), `users/:userId/roles`
(admin), `leaderboard/:variant`, `seeks` (list/create/delete), `games/:id`.
45 tests: auth flows, **authZ matrix**, token/scrypt units, router edge cases,
resources, OpenAPI self-consistency.

**Acceptance criteria status (M4):**
- authZ-matrix tests — ✅ (`packages/api/test/authz.test.ts`).
- Glicko-2 vs reference — ✅ (`persistence`).
- OpenAPI published — ✅ (`packages/api/openapi.json`, served at `/v1/openapi.json`).
- DB integration tests (ephemeral Postgres) — ✅ gated on `DATABASE_URL`.
- Game persistence round-trip — ✅ (`persistence`).

**Verification note:** gated integration tests need `DATABASE_URL` (Postgres 16);
`npm test -w @chess-platform/persistence` applies `0001_init.sql`. The `api` suite
needs no database — it runs against in-memory fakes.

### Files likely to change next
- `packages/web/src/api/models.ts`, `packages/web/src/api/client.ts`, and the auth
  controller/bootstrap/markup/tests when the password-recovery UI lands over the
  already-published identity-recovery endpoints.
- `packages/realtime-gateway/src/gateway.ts` + `services/gateway` when sticky
  per-game routing / sharded authority lands (unlocks gateway replicas > 1).
- `deploy/helm/gambit/*` + `.github/workflows/ci.yml` as later M14 increments
  (Terraform, CI/CD deploy gates, secrets management) arrive.
  (The durable EventStore wiring and CI activation are done — see §6.)

### Open technical decisions
- **Passkey library vs. hand-rolled WebAuthn — resolved (ADR-0027, ADR-0108).**
  The current server verification and native browser JSON adapter use no added
  runtime dependency; any future replacement requires a new evidence-backed decision.
- **Rate-limiting store.** In-process token bucket (simple, per-instance) vs. Redis
  (accurate across instances). Likely Redis, reusing the M3 pub/sub adapter seam.
- **Refresh-rotation UX.** Chain-burn on reuse can log out a legitimate client that
  retried after a dropped response. Acceptable now; consider a short grace window
  keyed on the rotated-from id if it proves noisy in practice.

### Known issues
- Session create + old-session revoke on refresh are two repository calls, not one
  transaction; a crash between them could briefly leave two active sessions. Wrap in
  a transaction when a `UnitOfWork`/tx seam is added to `persistence`.
- ~~`additionalProperties: false` is documented in the OpenAPI request schemas but the
  runtime validators don't yet reject unknown fields (they ignore them).~~ **RESOLVED:**
  `strictObject()` in `http/validate.ts` is applied to every mutating route in
  `routes.ts` and rejects unknown fields with a 422 `validation_failed` response.
- A user's ratings profile issues one `RatingsRepository.get` per variant (≤8);
  fine now, but add a bulk `ratingsForUser` query before it's hot.

### Milestone 5 — IMPLEMENTED (`@chess-platform/engine` shipped)
**Status: implemented, 51/51 tests green, strict TS + lint clean.** Gate docs:
`docs/ENGINE_BRIDGE.md` + `docs/adr/0002-engine-bridge.md` (ADR Status: **Accepted**). The
ten-point refinement (all adopted) is realised in code as these seams:

- **EngineManager** orchestrator over `EnginePool` over `EngineInstance` — adopted.
- **Plugin-oriented engines** + **capability discovery** (no engine-name conditionals) — adopted.
- **AnalysisProvider** abstraction above UCI (future non-UCI/AI providers drop in) — adopted.
- **Engine version negotiation** (min-version floor + fingerprint + advertised-option-only) — adopted.
- **Cache abstraction** (`AnalysisCache` port; in-process LRU default) — adopted; this
  **reverses ADR-0002 v1's durable-Postgres decision**, so M5 no longer touches the approved
  `DATABASE.md` contract. A durable cache is deferred to a future **ADR-0003** + DB addendum.
- **Failure isolation** (process bulkhead + per-pool circuit breaker), **hot worker replacement**,
  **graceful shutdown/recovery**, and **health-monitoring interfaces** — all adopted.

No item was rejected; each is a seam within the new `@chess-platform/engine` package and none
changes the platform architecture, service map, or milestone plan. **Additional ADR evaluation:**
only ADR-0002 is required now; ADR-0003 (durable cache) is flagged for later.

**As-built (`packages/engine`, dependency-free domain, native processes behind seams):**
- `src/provider.ts` — `AnalysisProvider` (the contract every caller depends on).
- `src/manager.ts` — `EngineManager`: registry, capability-based routing, cache + FEN boundary,
  health aggregation, graceful shutdown (also `AnalysisProvider` + `AsyncDisposable`).
- `src/pool.ts` — `EnginePool`: warm workers, autoscale by queue depth, crash→hot-replacement,
  per-pool circuit breaker, graceful drain.
- `src/instance.ts` — `UciEngineInstance`: UCI state machine, per-search watchdog, cooperative
  (`stop`) + hard cancellation, crash detection, version floor.
- `src/plugin.ts` — `EnginePlugin` + built-in Stockfish / Fairy-Stockfish descriptors.
- `src/transport.ts` — `EngineTransport` seam + deterministic `FakeEngineTransport`;
  `src/child-process-transport.ts` — hardened native `ChildProcessTransport`.
- `src/cache.ts` — `AnalysisCache` port + `InMemoryLruCache`/`NullCache` (durable backend deferred).
- `src/queue.ts` — priority scheduler (aging + backpressure); `src/capabilities.ts` — discovery,
  fingerprint, version negotiation; `src/uci/protocol.ts` — pure UCI codec; `src/bootstrap.ts` —
  `createEngineManager` composition root + `BinaryResolver`.

**Deferred (tracked, not lost):** real-engine golden test (env-gated, needs a pinned binary in CI),
live-infra autoscaling, distributed remote workers, and wiring the bot/analysis path into the M3
`GameAuthority` + M4 `EventStore` — all land with the deployable service in **M14**. A durable
analysis cache remains a future **ADR-0003** (would amend `DATABASE.md`).

### Exact next step for the next agent

M14 Inc45 is complete: password-recovery web UI is implemented and verified in `@chess-platform/web` over the existing M4 server contracts (`POST /v1/auth/password-reset/request` and `POST /v1/auth/password-reset/confirm`). Production delivery was subsequently closed in M15 Increment 18 (ADR-0126).

## 8. Historical build & test snapshot

```bash
npm install                 # workspaces root
npm run build               # core → game → realtime-gateway → persistence → api → engine
npm test                    # runs all package test suites (node --test)
npm run openapi -w @chess-platform/api   # regenerate packages/api/openapi.json
```
Per package: `cd packages/<pkg> && npm install && npm run build && npm test`.

> The increment sections below are historical delivery records. Later sections
> may close deferrals or replace adapters described in earlier entries.

## M9 Increment 11: Arena through the API + persistence
- **Parallel Arena Service**: In order to securely implement API access to the `ArenaTournament` format without jeopardizing the stability of round-based formats (round-robin and swiss), `TournamentConfig` was split into `RoundBasedConfig` and `ArenaConfig`.
- **API Branching**: `ArenaService` isolates arena-specific behavior. The REST endpoints natively branch based on the tournament format, falling back to `TournamentService` for standard formats.
- **Persistence**: Reused `TournamentsRepository` completely by introducing `TournamentAnySnapshot`. `ArenaSnapshot` handles distinct fields for the arena schema. No schema migrations needed as `jsonb` absorbs the structural differences smoothly.
- **Testing**: Added integration test suite explicitly for validating Arena tournaments natively through the API.

## M9 Increment 13: Durable tournament result recording in production
- **Optimistic Concurrency Control**: Added OCC to the `TournamentsRepository` to prevent lost updates in the domain (using a row-version increment with an automated 3-attempt CAS retry loop).
- **Production Reporter**: Extracted `TournamentResultReporter` into `@chess-platform/api` to act as a production-grade long-running background worker running alongside the gateway. The reporter tracks pubsub topics for ongoing games to drive tournament progression durably, surviving temporary crashes or downtime by catching up on startup.
- **Leak Fix**: Fixed test memory leak by supporting graceful `stop()` and event subscription deregistration in `TournamentResultReporter`.

## M4 Identity Hardening — Increment 1: password reset + email verification (ADR-0026)
- **Email storage**: `users` gains a nullable `email CITEXT UNIQUE` column (plus
  `email_verified_at`), populated at registration alongside the existing
  `email_hash`; the privacy tradeoff is recorded in ADR-0026. Migration
  `0007_identity_hardening.sql` also adds the `identity_tokens` table
  (kind CHECK `password_reset` | `email_verify`, token stored as SHA-256 hash,
  TTL-bound, single-use).
- **Flows**: `POST /v1/auth/password-reset/request` (always 202 —
  anti-enumeration; rate-limited per-IP and per-target), `POST
  /v1/auth/password-reset/confirm` (atomic single-use consume, new password via
  `PasswordHasher`, ALL sessions/refresh chains revoked, refresh cookie
  cleared), `POST /v1/auth/email/verify`; registration issues a verification
  token when an email is provided. All audited; OpenAPI regenerated.
- **Ports**: `EmailSender` (`InMemoryEmailSender` for tests, `ConsoleEmailSender`
  as the stand-in production default — a real provider adapter is a later
  increment) and `IdentityTokensRepository` (in-memory + Postgres; consumption
  is one conditional `UPDATE ... RETURNING`, race-free by construction).
- **Review hardening**: pre-reset refresh tokens proven dead after a reset;
  expired-token rejection via the injected clock; the in-memory users fake now
  mirrors the email UNIQUE constraint (duplicate email registration → 409).

## M4 Identity Hardening — Increment 2: WebAuthn / Passkeys (ADR-0027)
- **Storage**: Added `webauthn_login_challenges` to Postgres for stateless login challenge handling without fake user FKs.
- **Security Primitives**: Hardened `decodeFirst` CBOR parser against trailing bytes, recursion limits, and duplicate map keys.
- **Anti-Enumeration**: `allowCredentials` is omitted from login options to avoid exposing a credential list and to enable discoverable credentials. Existing and unknown handles both receive random, stored single-use challenges, and verification failures use the same generic response path.
- **Sign Counts**: Atomic concurrency control when updating sign counts via `WebAuthnCredentialsRepository.updateSignCount`.
- **API Endpoints**: Rate-limited `POST /v1/auth/webauthn/*` endpoints with comprehensive tests validating ceremony and decoy behaviors.

## M4 Identity Hardening — Increment 2 Review Hardening
- **Client data validation**: Both WebAuthn ceremonies now require typed, canonical client-data challenges, exact ceremony type, an allowed origin, `crossOrigin: false` when present, and no `topOrigin` under the current same-origin policy; malformed data returns 422 instead of reaching `node:crypto` as a 500.
- **Authenticator data framing**: The parser rejects trailing bytes unless the ED flag is set, and requires ED payloads to be one complete CBOR map for both assertions and attested credential data.
- **Counter/replay protection**: A stored non-zero signature counter can no longer regress to zero, and the in-memory repository now mirrors the Postgres compare-and-update rule.
- **Resource hardening**: Unknown credentials reuse one process-level dummy EC key instead of synchronously generating a key pair for every unauthenticated verification request.
- **Regression coverage**: Added tests for extension framing, signature-counter regression, malformed challenges, and forbidden `topOrigin`.

## Playable Alpha Increment 1: Seek Acceptance
- **Atomic Matching**: Added `POST /v1/seeks/:id/accept` endpoint in `@chess-platform/api` which checks rating boundaries and enforces game-ownership assignment.
- **Persistence**: Implemented `PgSeekAcceptor` in `@chess-platform/persistence` that uses an atomic row-locking `UPDATE ... WHERE game_id IS NULL` to claim the seek while provisioning the `game_id`, avoiding race conditions between simultaneous acceptors. Database schema updated with `0009_seek_match_receipts.sql` to support the tracking of matched games.
- **Lobby Integration**: Updated `@chess-platform/web`'s `LobbyController` and `bootstrap.ts` to render 'Play' buttons on opponent seeks. Upon successful acceptance, both players automatically route to the game via client-side redirection.
- **Verification**: E2E verification implemented in `packages/web/e2e/seek-acceptance.spec.ts` modeling the entire slice: Player 1 creates seek -> Player 2 accepts -> both land on the board page and connect successfully.

## M13 Observability — Increment 1 (ADR-0028)
- **JSON Logger**: Implemented a zero-dependency `JsonLogger` mapped behind a generic `Logger` port in `@chess-platform/api`. It supports W3C `trace_id` injection and automatic redaction of sensitive keys (`password`, `token`).
- **Prometheus Metrics**: Implemented a hand-rolled `InMemoryMetrics` engine mapped behind a `Metrics` port, generating spec-compliant Prometheus text format. Enforces strict metric cardinality bounds.
- **API Instrumentation**: Updated `router.ts` to parse W3C `traceparent` headers for distributed tracing, injecting trace context into the route handlers. Also instruments every route automatically with bounded-cardinality route tags (avoiding unbounded params). Exposed `GET /v1/metrics`.
- **Gateway Instrumentation**: Realtime gateway updated to replace `console.log` with `JsonLogger`, introduced connection, message, and auth failure metrics, and exposed `GET /metrics`.

## M12 Anti-Cheat Increment 1 — Engine-Correlation Analysis (ADR-0029)
- **Domain logic**: Created `@chess-platform/anti-cheat` as a pure, dependency-free domain package.
- **Metrics**: Implemented `analyzeGame` to calculate Average Centipawn Loss (ACPL) with a 300cp cap and MATE encoding, T1/T3 match rates, and deterministic suspicion bands (`clean`, `review`, `high`).
- **Mitigations**: Opening-book plies are excluded from *every* metric. Forced moves (only-move gap >= 200cp) are excluded from the **T1/T3 match rates only** — they still count toward ACPL and `sampleSize`, since playing the sole reasonable move is not itself suspicious but the position was still played. Applies a `lowConfidence` flag for low engine depth, small ACPL sample size, or a thin T1/T3 denominator.
- **Hermetic tests**: Tested against deterministic `InMemoryEvaluator` fakes.
- **Poolable counts**: The per-player report also exposes raw numerators/denominators (`t1Matches`, `t3Matches`, `tRateSampleCount`, `rawCentipawnLossTotal`, `cappedCentipawnLossTotal`) so Increment 2 can aggregate games by pooling rather than averaging rates.

## M12 Anti-Cheat Increment 2 — Cross-Game Aggregation (ADR-0030)
- **Account-level signal**: `aggregatePlayer(games)` combines a player's per-game `PlayerCorrelationReport`s (the side the account played each game) into one `PlayerAggregateReport`.
- **Pool, never average**: T1/T3 are pooled (Σ matches ÷ Σ eligible plies) and ACPL is a sample-weighted mean (Σ loss ÷ Σ `sampleSize`) — a 3-ply game cannot weigh like a 60-ply one. A test asserts pooling differs from naive per-game averaging.
- **Per-player, not blended**: aggregation consumes `PlayerCorrelationReport`, so a cheater is never diluted by the opponent's human moves — the same isolation as Increment 1, carried to the account level.
- **Confidence gate**: `AGG_MIN_GAMES = 3` and `AGG_MIN_POOLED_TRATE = 40`. One anomalous game can't flip an account; many individually low-confidence games can still form a confident aggregate once pooled.
- **Shared thresholds**: the `high`/`review` bands reuse Increment 1's exact numeric constants (imported) so per-game and aggregate bands can't diverge.
- **Duplicate rejection**: a repeated `gameId` throws, so a retried/overlapping history read can't double-count a game and inflate confidence.
- **Reviewer drill-down**: `flaggedGameIds` lists the games whose per-game suspicion was `review`/`high`.
- **Reconstruction note**: the increment was rebuilt on current `main`; the original branch had been cut from a stale `main` and built the aggregator on the pre-review *blended* per-game report, which would have reverted Increment 1's per-player separation and CodeRabbit fixes.

## M12 Anti-Cheat Increment 4 — Service and Repository (ADR-0032)
- **Application Layer**: Introduced `AntiCheatService` and `AntiCheatReportRepository` to compose Increments 1-3 into a usable flow.
- **Pure Orchestration**: The service orchestrates analyzing a game, saving reports for both players, and aggregating a player's history. It depends only on injected ports, keeping the domain logic pure and independent of specific persistence or engine implementations.
- **Idempotency Guarantee**: Reports are stored keyed by `(playerId, gameId)`. `InMemoryAntiCheatReportRepository` uses a nested map (`playerId` -> `gameId` -> `report`). This ensures re-analyzing a game replaces the prior record rather than appending a duplicate, so `aggregatePlayer`'s duplicate game guard will never trip. Both players' reports are persisted atomically via `saveBatch`.
- **Deferred Storage**: Postgres implementation and moderation REST APIs are deferred to a later increment, proving the domain patterns fully in-memory first.

## M12 Anti-Cheat Increment 5 — Postgres Persistence & Moderation REST API (ADR-0033)
- **Postgres Schema**: Migration `0010_anti_cheat_reports.sql` creates table `anti_cheat_reports` storing `player_id`, `game_id`, `color`, and `report` JSONB with `PRIMARY KEY (player_id, game_id)`. Opaque IDs without foreign keys preserve analytical records independently of user/game row lifecycles.
- **Repository Implementation**: `PgAntiCheatReportRepository` in `@chess-platform/persistence` implements `AntiCheatReportRepository`. `saveBatch` persists white and black reports in one atomic transaction (`BEGIN` ... `COMMIT` / `ROLLBACK`). Upserts replace existing reports on `(player_id, game_id)` conflict for idempotency.
- **Moderation REST API**: Added `GET /v1/moderation/anti-cheat/players/:playerId` (account aggregate) and `GET /v1/moderation/anti-cheat/players/:playerId/games` (per-game history) to `@chess-platform/api`, gated by policy `MODERATION` (`moderator` or `admin` role). Both endpoints record audit entries (`anti_cheat.aggregate.view` / `anti_cheat.games.view`).
- **OpenAPI Document**: Updated OpenAPI 3.1 specification committed to `packages/api/openapi.json` with new component schemas (`AntiCheatPlayerReport`, `AntiCheatGameReportView`, `AntiCheatAggregateView`, `AntiCheatGameReportList`) and route definitions.
- **Root Build Pipeline**: Moved `@chess-platform/engine` and `@chess-platform/anti-cheat` ahead of `@chess-platform/persistence` and `@chess-platform/api` in root `package.json` `build`, `test`, and `lint` scripts to reflect the new package dependency graph.
- **Next Steps**: The on-demand analysis pipeline landed in Increment 6 (below); the automated background/PubSub trigger is deferred to Increment 7.

## M12 Anti-Cheat Increment 6 — On-Demand Analysis Pipeline (ADR-0034)
- **Application Services**: Added `FinishedGameSource` interface and `EventStoreGameSource` adapter in `@chess-platform/api` to load historical events, reconstruct games via `Game.fromEvents`, and validate finished status and player presence. Implemented `AntiCheatAnalysisService` composing `FinishedGameSource`, `extractPlies`, evaluator factory, and `AntiCheatService.analyzeAndStore`.
- **Moderation REST Endpoint**: Added `POST /v1/moderation/anti-cheat/games/:gameId/analyze` to `@chess-platform/api`, gated by policy `MODERATION`. Parses optional `depth` parameter `[8, 30]`, records audit entry (`anti_cheat.analyze`), runs analysis, and returns `AntiCheatGameAnalysisView` (`{ white, black }`). Returns 503 if engine is not configured.
- **Engine Gating & Wiring**: Production bootstrap (`createPgDependencies`) env-gates `AntiCheatAnalysisService` behind `PgBootstrapOptions.analysisProvider`. Test harness (`startHarness`) wires a deterministic fake evaluator for hermetic integration testing.
- **OpenAPI Document**: Updated OpenAPI 3.1 specification committed to `packages/api/openapi.json` with new component schemas (`AnalyzeGameRequest`, `AntiCheatGameAnalysisView`) and route documentation.
- **Automated Worker Deferred**: Automated background/PubSub auto-analysis worker deferred to Increment 7.

## M12 Anti-Cheat Increment 7 — Automated Auto-Analysis Worker (ADR-0035)
- **Global Game-Ended Channel**: Added `gamesEndedChannel()` (`games:ended`) to `@chess-platform/realtime-gateway` and exported it from the package root.
- **Authority Fan-Out**: Updated `GameAuthority` publish loop to fan out terminal `EndedBroadcast` messages to `gamesEndedChannel()`. Because each live game has a single authority owner (ADR-0010), each game's completion is published to `gamesEndedChannel()` exactly once.
- **Auto-Analysis Worker**: Implemented `AntiCheatAutoAnalyzer` in `@chess-platform/api` (`packages/api/src/anti-cheat/auto-analyzer.ts`). Subscribes to `gamesEndedChannel()`, deduplicates seen game IDs, tracks background analysis promises in an `inFlight` set, and provides a `drain()` hook for deterministic testing.
- **Crash Safety & Idempotency**: Analysis rejections trigger `onError` (or `console.error`) and remove the game ID from `seen` so subsequent re-broadcasts can retry. The pubsub message handler never throws, preventing host crashes. Upserts in `AntiCheatAnalysisService` guarantee idempotent report storage.
- **Package Exports**: Exported `AntiCheatAutoAnalyzer`, `AntiCheatAnalysisService`, and `EventStoreGameSource` from `@chess-platform/api` root index.
- **Hermetic Test Suite**: Added `packages/api/test/anti-cheat-auto-analyzer.test.ts` covering end-to-end auto-analysis, crash-safety/error handling, deduplication, non-ended message filtering, and `stop()` cleanup.

## M12 Bot Detection Increment 1 — Behavioral Move-Time Analyzer (ADR-0036)
- **Pure Domain Analyzer**: Added `analyzeBotBehavior` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-behavior.ts`) to analyze move-time distributions for a single player in one game.
- **Timing Interface**: Defined `TimedMove` interface with move duration `ms` and opening-book flag `isBook`.
- **Metrics & Signals**: Computes `meanMs`, population standard deviation `stdevMs`, `coefficientOfVariation` (`stdev / mean`), near-instant move count `instantMoves` (`ms <= 150`), and `instantFraction`.
- **Confidence Gate & Suspicion Banding**: Low confidence gate (`sampleSize < 10`) forces report to `clean`. Confident reports take the max suspicion band between CV band (`<= 0.25` -> `high`, `<= 0.5` -> `review`) and near-instant band (`>= 0.9` -> `high`, `>= 0.7` -> `review`).
- **Human Moderation Screening**: Serves strictly as a screening signal for human review queues, never auto-banning (per ARCHITECTURE §7).
- **Hermetic Tests**: Unit test suite in `packages/anti-cheat/test/bot-behavior.test.ts` covering uniform bots, human pacing, low confidence gating, book exclusions, empty input, numeric accuracy, and review bands.

## M12 Bot Detection Increment 2 — Cross-Game Aggregation (ADR-0037)
- **Account-Level Behavioral Aggregation**: Added `aggregateBotBehavior` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-aggregate.ts`) to combine an account's per-game `BotBehaviorReport`s into a single `BotAggregateReport`.
- **Pool Raw Moments, Never Average**: Extended `BotBehaviorReport` with raw poolable moments `sumMs` (Σ ms) and `sumSqMs` (Σ ms²). Aggregation pools raw timing sums across games (`pooledMeanMs`, `pooledStdevMs`, `pooledCoefficientOfVariation`, `pooledInstantFraction`) rather than averaging per-game rates, avoiding skew from short games.
- **Aggregate Confidence Gate**: Enforces `BOT_AGG_MIN_GAMES = 3` and `BOT_AGG_MIN_POOLED_SAMPLE = 40`. Aggregates with fewer games or smaller pooled move samples set `lowConfidence: true` and remain `clean`.
- **Shared Suspicion Banding**: Extracted `behaviorSuspicion` as a shared pure helper in `bot-behavior.ts` used by both `analyzeBotBehavior` and `aggregateBotBehavior`, guaranteeing per-game and account-level thresholds cannot diverge.
- **Duplicate Rejection**: Rejects duplicate `gameId`s with a thrown `Error` to prevent double-counting game history.
- **Reviewer Drill-Down**: Surfaces `flaggedGameIds` listing games whose per-game suspicion was `review` or `high`.
- **Hermetic Tests**: Unit test suite in `packages/anti-cheat/test/bot-aggregate.test.ts` covering pooling vs averaging, confidence gates, confident escalation, duplicate rejection, flagged game collection, empty inputs, and exact pooled statistics math.

## M12 Bot Detection Increment 3 — Move-Timing Extraction (ADR-0038)
- **Pure Domain Move-Timing Bridge**: Added `extractTimedMoves` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-extract.ts`) to split a game's ordered per-move timings into per-player `TimedMove[]` (`{ white, black }`) ready for `analyzeBotBehavior`.
- **Decoupled Projection**: Accepts minimal `MoveTiming` (`{ by: Color, moveTimeMs: number }`) without depending on `@chess-platform/game` or event log infrastructure.
- **Direct Clock Timing**: Uses pre-computed `MovePlayedEvent.moveTimeMs` directly as `ms` without clock-delta math.
- **Book Exclusion Seam**: Supports an `isBook(moveIndex: number)` predicate to flag opening-book plies so `analyzeBotBehavior` excludes them from behavioral statistics.
- **Hermetic Tests**: Unit test suite in `packages/anti-cheat/test/bot-extract.test.ts` covering alternating split, `ms` mapping, book marking, empty input, single-color/uneven input, and end-to-end extract -> analyze bridge triggering high suspicion.

## M12 Bot Detection Increment 4 — Service + Report Repository (ADR-0039)
- **Repository Port & In-Memory Adapter**: Added `BotBehaviorReportRepository` interface and `InMemoryBotBehaviorReportRepository` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-repository.ts`) with `saveBatch` and `listByPlayer`.
- **Nested-Map Idempotent Upsert**: `InMemoryBotBehaviorReportRepository` keys records by `(playerId, gameId)` in a nested map (`Map<playerId, Map<gameId, StoredBotReport>>`), replacing prior records on re-analysis so duplicate-`gameId` error guards in `aggregateBotBehavior` never trip.
- **Pure Domain Service**: Added `BotDetectionService` in `@chess-platform/anti-cheat` (`packages/anti-cheat/src/bot-service.ts`) composing `extractTimedMoves` → `analyzeBotBehavior` → `saveBatch` (`analyzeAndStore`) and `listByPlayer` → `aggregateBotBehavior` (`aggregatePlayer`).
- **Engine-Free Simplicity**: Operates entirely on move-timing data without requiring an engine/evaluator adapter (unlike `AntiCheatService`).
- **Hermetic Tests**: Unit test suites in `packages/anti-cheat/test/bot-repository.test.ts` and `packages/anti-cheat/test/bot-service.test.ts` covering batch storage, idempotent upsert replacement, unknown player fallback, multi-game bot escalation vs human clean aggregates, and `isBook` predicate delegation.

## M12 Bot Detection Increment 5 — Postgres Persistence & Moderation REST API (ADR-0040)
- **Database Schema**: Added migration `0011_bot_reports.sql` creating `bot_reports` table (`player_id`, `game_id`, `color`, `report JSONB`, `created_at`, `updated_at`) with composite primary key `(player_id, game_id)` and supporting index `(player_id, created_at)`.
- **Postgres Repository**: Added `PgBotBehaviorReportRepository` in `@chess-platform/persistence/pg` implementing atomic `saveBatch` (SQL `BEGIN`...`COMMIT` transaction with `ON CONFLICT (player_id, game_id) DO UPDATE`) and `listByPlayer`. Re-exported from `@chess-platform/persistence/pg`.
- **Timing Source Adapter**: Added `EventStoreBotTimingSource` in `@chess-platform/api/src/bot-detection/source.ts` implementing `BotGameTimingSource` to project finished game events into `BotFinishedGame` (`white`, `black`, `moves`).
- **Moderation REST Endpoints**: Added three `MODERATION`-gated, audited endpoints in `@chess-platform/api`:
  - `GET /v1/moderation/bot-detection/players/:playerId` (audits `bot_detection.aggregate.view`, returns `BotAggregateView`).
  - `GET /v1/moderation/bot-detection/players/:playerId/games` (audits `bot_detection.games.view`, respects `limit`, returns `BotGameReportList`).
  - `POST /v1/moderation/bot-detection/games/:gameId/analyze` (audits `bot_detection.analyze`, loads timings via `botTimingSource`, triggers `BotDetectionService.analyzeAndStore`, returns `BotGameAnalysisView`). Unconditionally available without engine setup (throws 503 if `botTimingSource` is missing).
- **OpenAPI & Wire Integration**: Added presenter functions/views in `presenters.ts` and OpenAPI component schemas in `schemas.ts`. Updated `deps.ts`, `server.ts`, `fakes.ts`, `bootstrap.ts`, and test `helpers.ts`.
- **Tests**: DB-gated integration test in `packages/persistence/test/bot-reports.integration.test.ts` and API test suites in `packages/api/test/bot-detection.test.ts` and `packages/api/test/bot-detection-analyze.test.ts`.

## M12 Bot Detection Increment 6 — Automatic Auto-Analysis Worker & Gateway Hosting (ADR-0041)
- **BotAnalysisService Application Service**: Added `BotAnalysisService` in `@chess-platform/api` (`packages/api/src/bot-detection/analysis-service.ts`) encapsulating `BotGameTimingSource` and `BotDetectionService`, exposing `analyzeAndStore(gameId)`.
- **BotAutoAnalyzer Worker**: Added `BotAutoAnalyzer` in `@chess-platform/api` (`packages/api/src/bot-detection/auto-analyzer.ts`). Subscribes once to `gamesEndedChannel()`, deduplicates game IDs up to `MAX_SEEN = 10_000` with FIFO eviction, tracks background analysis in `inFlight`, handles rejections safely via contained `onError` hook without failing promises/drain, and provides a deterministic `drain()` method.
- **REST Analyze Route Refactoring**: Updated `POST /v1/moderation/bot-detection/games/:gameId/analyze` in `packages/api/src/routes.ts` to consume `BotAnalysisService`, removing inline loading and analysis duplication.
- **Gateway Process Hosting**: Hosted `BotAutoAnalyzer` in `services/gateway/src/serve.ts` behind optional environment variable `BOT_AUTO_ANALYZE === '1'`. Requires `DATABASE_URL` (instantiates `PgBotBehaviorReportRepository` and `EventStoreBotTimingSource`). Requires no engine process. Stop hook wired into graceful shutdown.
- **Package Exports & Documentation**: Exported bot detection source, analysis service, and auto-analyzer from `@chess-platform/api` index. Documented ADR-0041 and updated roadmap.
- **Hermetic Tests**: Added unit test suite in `packages/api/test/bot-detection-auto-analyzer.test.ts` covering end-to-end auto-analysis, crash-safety and contained error hooks, retry on re-broadcast, deduplication, and subscriber filtering/cleanup.

## M12 Anti-Cheat Correctness Hardening (ADR-0042)
- **Identical Player ID Validation**: `AntiCheatService.analyzeAndStore` now throws an error if `input.players.white === input.players.black`, preventing silent record overwrites in composite PK `(player_id, game_id)` storage.
- **Deterministic Repository Ordering**: Updated `PgAntiCheatReportRepository.listByPlayer` SQL to `ORDER BY created_at ASC, game_id ASC` with `game_id` tie-breaker. Added migration `0012_anti_cheat_reports_index.sql` replacing index with `(player_id, created_at, game_id)` for index-backed deterministic pagination.
- **Documentation & Parity**: Updated `docs/DATABASE.md` §4.5, `docs/ROADMAP.md`, and added `docs/adr/0042-anticheat-correctness-hardening.md`.

## M12 Anti-Cheat Increment 8 — Production Engine Wiring & Gateway Hosting (ADR-0043)
- **Engine Provider Factories**: Added `createEngineProviderFromEnv()` (reads `STOCKFISH_PATH`, instantiates `EngineManager` lazily or returns `undefined`) and `createEngineBackedAnalysisService(source, provider, repository)` in `packages/api/src/anti-cheat/engine-provider.ts`, re-exported from `@chess-platform/api`.
- **Gateway Process Hosting**: Hosted `AntiCheatAutoAnalyzer` in `services/gateway/src/serve.ts` behind `ANTICHEAT_AUTO_ANALYZE === '1'`. Requires `DATABASE_URL` (for `PgAntiCheatReportRepository` and `EventStoreGameSource`) and an engine binary (`STOCKFISH_PATH`). Logs clear warnings if either requirement is missing.
- **Graceful Subprocess Shutdown**: Integrated `antiCheatAutoAnalyzer?.stop()` and engine pool shutdown (`antiCheatEngine.shutdown()`) into the gateway's `SIGINT`/`SIGTERM` shutdown handler.
- **Documentation**: Added `docs/adr/0043-anticheat-engine-hosting.md` and updated `docs/ROADMAP.md` and `docs/PROJECT_STATE.md`.
- **Hermetic Tests**: Added unit test suite in `packages/api/test/anti-cheat-engine-provider.test.ts` testing environment variable reading and end-to-end anti-cheat analysis/storage using a fake `AnalysisProvider`.

## M10 Social Graph Increment 2 — Persistence & REST API (ADR-0067)
- **Migration `0015_social_graph.sql`**: Created tables `social_follows` `(follower_id, followee_id, followed_at)`, `social_blocks` `(blocker_id, blocked_id, blocked_at)`, and `social_friend_requests` `(id, requester_id, addressee_id, status, created_at, responded_at)`. Added foreign keys with `ON DELETE CASCADE` to `users(id)`, NOT NULL timestamp fields, `not_self` CHECK constraints, and partial unique indexes (`social_friend_requests_one_pending_per_pair` and `social_friend_requests_one_accepted_per_pair`).
- **Postgres Adapter (`PgSocialGraphRepository`)**: Implemented `SocialGraphRepository` port in `packages/persistence/src/pg/social.ts` and re-exported from `@chess-platform/persistence/pg`. Atomic `block()` execution within single SQL transactions (`BEGIN` ... `COMMIT`), block precedence checks in `follow()` and `sendFriendRequest()`, and error translation (handling unique violation `23505` to `already_exists`). Collation for UUID fields uses standard Postgres byte-wise comparison matching code-point `compareIds` order without `COLLATE "C"`.
- **REST API Endpoints**: Registered 12 `/v1/social/...` endpoints in `packages/api/src/routes.ts` (`POST/DELETE /v1/social/follows/:playerId`, `GET /v1/social/players/:playerId/followers`, `GET /v1/social/players/:playerId/following`, `POST /v1/social/friend-requests`, `POST /v1/social/friend-requests/:id/respond`, `GET /v1/social/friend-requests/incoming`, `GET /v1/social/friend-requests/outgoing`, `GET /v1/social/friends`, `POST/DELETE /v1/social/blocks/:playerId`, `GET /v1/social/blocks`).
- **Authorization & Wire Integration**: Enforced actor strictly as `requireAuth(ctx).userId`, server-generated `uuidv7()` request IDs, public follow lists, private caller-only friend/block/request lists, and `mapSocialError` helper converting `SocialRuleError` to 422, 403, 409, 404. Wired `socialGraphRepository` across `deps.ts`, `server.ts`, `bootstrap.ts` (with 503 fallback when omitted), and test `helpers.ts` (`withoutSocial`).
- **OpenAPI & Build Chain**: Exported presenters (`followEdgeView`, `friendRequestView`, `blockEdgeView`) and OpenAPI 3.1 schemas (`COMPONENT_SCHEMAS`). Regenerated `packages/api/openapi.json` with zero drift. Updated `package.json` `build:server` and Dockerfiles (`Dockerfile.api`, `Dockerfile.gateway`). Verified check:build-order script passes.
- **Tests**: DB-gated integration tests in `packages/persistence/test/social.integration.test.ts` (29/29 pass) and HTTP REST tests in `packages/api/test/social-api.test.ts` (255/255 pass).
- Detailed in `docs/adr/0067-social-persistence-api.md`.

## M10 Direct Messaging Increment 3 — Direct 1:1 Messaging (ADR-0068)
- **Domain Core Package (`@chess-platform/messaging`)**: Created pure TypeScript domain package with zero runtime dependencies. Defined `Conversation`, `Message`, `ConversationReadState`, and `ConversationSummary` interfaces. Inverted block dependency via `BlockChecker` port interface. Defined `MessagingRuleError` with codes `self_conversation`, `blocked`, `not_found`, `not_authorized`, `invalid_body`, `invalid_transition`. Code-point tie-break sorting (`compareOldestThenId`, `compareRecentActivityThenId`) and `paginate` pagination helper.
- **Migration `0016_messaging.sql`**: Created tables `messaging_conversations`, `messaging_messages`, and `messaging_reads`. `ON DELETE CASCADE` foreign key references to `users(id)` and `messaging_conversations(id)`. Partial-free unique index on `(LEAST(participant_a, participant_b), GREATEST(participant_a, participant_b))` enforcing one conversation per pair. Every referencing FK side is covered, three of them by the composite list indexes that already lead with the same column rather than by narrow duplicates.
- **Postgres Adapter (`PgMessagingRepository`)**: Implemented `MessagingRepository` in `packages/persistence/src/pg/messaging.ts` and re-exported from `@chess-platform/persistence/pg`. Transaction pair locks via the shared `pair-lock.ts` key (the same key the social graph adapter uses, which is what makes the cross-connection block check meaningful), a fixed lock order — pair lock before any row lock, after the reverse order in `sendMessage` was found to deadlock against `getOrCreateConversation` — single-statement idempotent upsert for `getOrCreateConversation`, `GREATEST` for both the read marker and `last_message_at`, `listConversations` as one query with a `LATERAL` instead of two per row, and safe `NaN`/`Infinity` pagination handling.
- **REST API Endpoints**: Registered 9 `/v1/messages/...` endpoints in `packages/api/src/routes.ts` (`GET/POST /v1/messages/conversations`, `GET /v1/messages/conversations/:id`, `GET/POST /v1/messages/conversations/:id/messages`, `PATCH/DELETE /v1/messages/messages/:id`, `POST /v1/messages/conversations/:id/read`, `GET /v1/messages/unread-count`).
- **Authorization & Privacy**: Actor strictly derived from `requireAuth(ctx).userId`. Server-generated `uuidv7()` message and conversation IDs. Uniform `not_found` (404) returned for non-existent vs unauthorized conversation access to prevent conversation ID probing.
- **Wiring & OpenAPI**: Added presenters in `presenters.ts` and OpenAPI component schemas in `schemas.ts`. Updated `deps.ts`, `server.ts`, `bootstrap.ts` (with optional dependency 503 fallback), and test `helpers.ts` (`withoutMessaging`). Regenerated `packages/api/openapi.json` with zero drift. Updated workspace dependencies, `package.json` scripts, `test-counts.mjs`, `Dockerfile.api`, `Dockerfile.gateway`, and verified `check:build-order`.
- **Tests**: Domain unit tests in `packages/messaging/test/messaging.test.ts` (10/10), DB-gated integration tests in `packages/persistence/test/messaging.integration.test.ts` (persistence 30/30 against a real Postgres), and REST API tests in `packages/api/test/messaging-api.test.ts` (api 263/263). Two of them were checked against deliberately broken code before being trusted: the deadlock test fails with Postgres' own `deadlock detected` under the original lock order, and the stranger-probing tests compare a real id against an invented one so they cannot pass by accident.
- Detailed in `docs/adr/0068-direct-messaging.md`.

## M10 Teams & Forums Increment 4 — Teams/Communities + Forums (ADR-0069)
- **Domain Core Package (`@chess-platform/community`)**: Created pure TypeScript domain package with zero runtime dependencies. Defined `Team`, `Membership`, `JoinRequest`, `ForumThread`, `ForumPost` interfaces, bounds, role hierarchy (`owner` > `admin` > `member`), and slug normalization. Defined `CommunityRuleError` with codes `not_found`, `not_authorized`, `invalid_slug`, `slug_taken`, `invalid_input`, `already_member`, `already_requested`, `cannot_leave_as_owner`, `invalid_role_transition`, `invalid_transition`. Defined ordering comparators (`compareThreads`, `comparePosts`, `compareMembers`, `compareTeams`) and `paginate` pagination helper.
- **Single-Owner & Role Invariants**: Enforced single owner per team across domain logic and persistence. Ownership transfer updates old owner to admin and target member to owner atomically under an advisory lock. Primary owner cannot leave the team without first transferring ownership.
- **Existence Oracle Protection**: Private teams read as `not_found` (404) for non-members across team details, membership lists, join requests, and forum threads/posts. `not_authorized` (403) is used exclusively for visible resources where the actor lacks permission.
- **Migration `0017_community.sql`**: Created tables `community_teams`, `community_memberships`, `community_join_requests`, `community_forum_threads`, `community_forum_posts`. `ON DELETE CASCADE` foreign key references to `users(id)` and `community_teams(id)`. Partial unique indexes `community_memberships_one_owner_per_team` and `community_join_requests_one_pending_per_player`. All referencing foreign key columns indexed to avoid full table scans on cascading user or team deletions.
- **Postgres Adapter (`PgCommunityRepository`)**: Implemented `CommunityRepository` in `packages/persistence/src/pg/community.ts` and re-exported from `@chess-platform/persistence/pg`. Transaction advisory locks (`lockTeam` via `pg_advisory_xact_lock`) acquired before row locks (`FOR UPDATE`) to prevent deadlocks. Safe `NaN`/`Infinity` pagination handling.
- **REST API Endpoints**: Registered 22 `/v1/teams/*` and `/v1/teams/:id/forum/*` endpoints in `packages/api/src/routes.ts`. Enforced authentication matrix, `requirePlayerExists` verification for target user routes, server-generated `uuidv7()` IDs, presenter views in `presenters.ts`, and `mapCommunityError` error translation.
- **Wiring & OpenAPI**: Added presenter views in `presenters.ts` and OpenAPI component schemas in `schemas.ts`. Updated `deps.ts`, `server.ts`, `bootstrap.ts` (with optional dependency 503 fallback), and test `helpers.ts` (`withoutCommunity`). Regenerated `packages/api/openapi.json` with zero drift. Updated workspace dependencies, `package.json` scripts (`build`, `test`, `lint`, `clean`, `build:server`), `scripts/test-counts.mjs`, `Dockerfile.api`, `Dockerfile.gateway`, and verified `check:build-order`.
- **Tests**: Domain unit tests in `packages/community/test/community.test.ts` (8/8 suites pass), DB-gated integration tests in `packages/persistence/test/community.integration.test.ts` (7/7 pass), and REST API tests in `packages/api/test/community-api.test.ts` (all auth matrix, 503 fallback, and full lifecycle tests pass).
- Detailed in `docs/adr/0069-teams-and-forums.md`.

## M10 Studies & PGN Increment 6 — Interactive Studies & PGN System (ADR-0071)
- **Domain Core Package (`@chess-platform/studies`)**: Created pure TypeScript domain package with zero runtime dependencies (43/43 tests passing). Defined `Study`, `StudyCollaborator`, `StudyChapter`, `StudyTreeNode`, and PGN models (`PgnGame`, `PgnHeader`, `PgnMoveNode`). Defined `StudyRuleError` with code taxonomy (`not_found`, `not_authorized`, `invalid_input`, `invalid_san`, `cannot_remove_owner`, `already_collaborator`, `invalid_role_transition`, `illegal_move`, `cycle_detected`, `order_conflict`). Implemented PGN parser (`parsePgn`) and serializer (`serializePgn`), SAN move resolver, code-point deterministic comparators, and `StudiesRepository` port with `InMemoryStudiesRepository` implementation.
- **SAN Move Resolution**: Adapted SAN move validation and position execution through an abstract `PositionReader` port (`legalSans`, `play`), decoupling domain move application from engine internals. Created `CorePositionReader` in `@chess-platform/api` using `@chess-platform/core`'s `Position`.
- **Migration `0019_studies.sql`**: Created tables `studies`, `study_collaborators`, `study_chapters`, and `study_tree_nodes`. Foreign key constraints specify `ON DELETE CASCADE`. Partial unique indexes `study_collaborators_one_owner_per_study` (one owner per study) and `study_chapters_study_id_order_index_idx` (active chapter ordering).
- **Postgres Adapter (`PgStudiesRepository`)**: Implemented `StudiesRepository` in `packages/persistence/src/pg/studies.ts` re-exported from `@chess-platform/persistence/pg`. Transaction advisory locking (`lockStudy` via `pg_advisory_xact_lock`) acquired before row locks (`FOR UPDATE`) to prevent cross-entity deadlocks. Ownership transfer demotes old owner to contributor before promoting target user to owner to maintain partial unique index compliance. Constraint-safe chapter reordering under advisory lock.
- **REST API Endpoints**: Registered 21 `/v1/studies/*` endpoints in `packages/api/src/routes.ts`. Enforced authentication matrix (`AUTHED` / `PUBLIC`), `requirePlayerExists` validation, server-generated `uuidv7()` IDs, presenter functions in `presenters.ts`, `mapStudyError` error translation, and `MAX_PGN_BYTES` (5 MB) body size limit on PGN import returning 413 Payload Too Large.
- **Wiring & OpenAPI**: Added presenter functions in `presenters.ts` and OpenAPI component schemas in `schemas.ts` (`StudyView`, `StudyPage`, `CollaboratorView`, `CollaboratorPage`, `StudyOwnershipTransferView`, `ChapterView`, `ChapterList`, `TreeNodeView`, `ChapterDetailView`, `PgnExport`). Updated `deps.ts`, `server.ts`, `bootstrap.ts` (`STUDIES_ENABLED === '1'`), and test `helpers.ts` (`withoutStudies`). Regenerated `packages/api/openapi.json` with zero drift. Updated workspace dependencies, `package.json` scripts (`build`, `test`, `lint`, `clean`, `build:server`), `scripts/test-counts.mjs`, `Dockerfile.api`, `Dockerfile.gateway`, and verified `check:build-order`.
- **Tests**: Domain unit tests in `packages/studies/test/` (43/43 pass), DB-gated integration tests in `packages/persistence/test/studies.integration.test.ts` (14/14 pass against Postgres), and REST API integration tests in `packages/api/test/studies-api.test.ts` (303/303 `@chess-platform/api` tests pass cleanly).
- Detailed in `docs/adr/0071-pgn-and-studies.md`.

## M10 Lessons & Courses Increment 7 — Structured Courses & Interactive Lessons (ADR-0072)
- **Domain Core Package (`@chess-platform/learning`)**: Created pure TypeScript domain package with zero runtime dependencies (8/8 unit tests passing). Defined `Course`, `Lesson`, `LessonStep`, `Progress`, `CourseProgressSummary`, `AttemptResult` interfaces, and step discriminators (`text`, `move`, `quiz`). Reused `@chess-platform/studies`'s `PositionReader` port for move step authoring-time legality check. Implemented slug validation and normalization (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`), code-point deterministic comparators (`compareCourses`, `compareLessons`, `compareSteps`, `compareProgress`), `paginate` helper, and `LearningRepository` port with `InMemoryLearningRepository` implementation.
- **Migration `0020_learning.sql`**: Created tables `learning_courses`, `learning_lessons`, `learning_steps`, and `learning_progress`. All player/course/lesson/step foreign keys specify `ON DELETE CASCADE`. Partial unique indexes on active course slugs (`learning_courses_slug_idx`), active lesson order indexes (`learning_lessons_course_id_order_index_idx`), and active step order indexes (`learning_steps_lesson_id_order_index_idx`). Dedicated full indexes on all foreign key columns cover cascading deletions on tombstoned rows.
- **Postgres Adapter (`PgLearningRepository`)**: Implemented `LearningRepository` in `packages/persistence/src/pg/learning.ts` re-exported from `@chess-platform/persistence/pg`. Transaction advisory locking (`lockCourse` via `pg_advisory_xact_lock`) acquired before row locks (`FOR UPDATE`). Dense order index reordering shifts active rows to negative indices (`-1 - i`) first to avoid partial unique index collisions. Single atomic SQL statement attempt recording (`INSERT INTO learning_progress ... ON CONFLICT (player_id, step_id) DO UPDATE SET attempts = ..., completed_at = COALESCE(...)`) with verified concurrent execution semantics.
- **REST API Endpoints**: Registered 23 `/v1/courses/*`, `/v1/lessons/*`, `/v1/steps/*` endpoints in `packages/api/src/routes.ts`. Enforced authentication matrix (`AUTHED` / `PUBLIC`), `requirePlayerExists` validation, server-generated `uuidv7()` IDs via `deps.ids.next()`, presenter functions in `presenters.ts`, and `mapLearningError` error translation.
- **Wiring & OpenAPI**: Added presenter functions in `presenters.ts` and OpenAPI component schemas in `schemas.ts` (`CourseView`, `CoursePage`, `LessonView`, `LessonList`, `StepView`, `StepList`, `ProgressView`, `ProgressList`, `CourseProgressSummaryView`, `AttemptResultView`). Updated `deps.ts`, `server.ts`, `bootstrap.ts` (`LEARNING_ENABLED === '1'`), and test `helpers.ts` (`withoutLearning`). Regenerated `packages/api/openapi.json` with zero drift. Updated workspace dependencies, `package.json` scripts (`build`, `test`, `lint`, `clean`, `build:server`), `scripts/test-counts.mjs`, `Dockerfile.api`, `Dockerfile.gateway`, and verified `check:build-order`.
- **Tests**: Domain unit tests in `packages/learning/test/learning.test.ts` (8/8 pass), DB-gated integration tests in `packages/persistence/test/learning.integration.test.ts` (including real N-concurrent attempt submission test), and REST API integration tests in `packages/api/test/learning-api.test.ts` (54/54 `@chess-platform/api` test suites pass cleanly).
- Detailed in `docs/adr/0072-lessons-and-courses.md`.

## M10 Increment 8 — Read-Only GraphQL Layer (ADR-0073) — closes M10
- **Endpoint**: `POST /v1/graphql`, behind `GRAPHQL_ENABLED=1`, registered with the same `AuthPolicy` machinery as the REST routes and open to anonymous callers. Delivers the nested reads REST answers badly — a player with their followers, teams, achievements and studies in one round trip. This closes the GraphQL deferral recorded in §4 decision 1.
- **Queries only**: the parser refuses `mutation` and `subscription` by name. Writes stay on REST, where each already has an authorization review.
- **Authorization delegated entirely to the repositories** (`packages/api/src/graphql/schema.ts`): every resolver passes `ctx.actorId` into the existing port and returns the answer, with no exceptions. `not_found` and `not_authorized` are flattened to one message so the endpoint is not an existence oracle (ADR-0069 §4). Review removed an invented rule: `Query.player` initially hid players who had blocked the caller, but ADR-0066 §3 scopes a block to follows and friend requests, and no REST read consults `isBlockedBetween` — the test now asserts GraphQL and REST return the *same* profile for a blocked pair. The repository bundle was also dropped from `ResolverContext` so resolvers reach subsystems only through accessors that fail the field rather than through a bundle they can branch on.
- **Per-request batching** (`graphql/loaders.ts`): a dependency-free DataLoader-style `BatchLoader` coalescing every `load()` in a microtask tick and caching per key, created inside the request handler so the cache never outlives it. Required a new `UsersRepository.findByIds`, implemented in `PgUsersRepository` (filters non-canonical ids before `= ANY($1::uuid[])`, since the cast would fail the whole batch on one malformed element) and in `InMemoryUsersRepository`. 25 followers resolve in 2 batched reads, not 26.
- **Three limits enforced before execution** (`graphql/limits.ts`): depth 8, complexity 1000 (list fields multiply their subtree by the page size they request), aliases 50. Validation *produces* the execution plan, so no field can resolve uncosted; each limit test asserts the repositories were not called. Plus a 16 KB query cap and argument-nesting bound in the parser.
- **Introspection off by default** (`GRAPHQL_INTROSPECTION=1`); rejection messages never list the fields that exist. The `__schema` shape returned is this repo's own, not spec-compliant — stated as such in the ADR.
- **No new runtime dependency**: parser, validator, executor and loader hand-written (~1,800 lines, 8 files). Fragments, directives, block strings and multi-operation documents are refused with explicit parse errors rather than misparsed; the fragment refusal avoids cyclic/exponential expansion that a depth bound cannot see.
- **Wiring**: `deps.ts`, `routes.ts`, `server.ts`, `bootstrap.ts` (`GRAPHQL_ENABLED`), `openapi/schemas.ts` (`GraphQLRequest`), and test `helpers.ts` (`withoutGraphql`, `graphqlIntrospection`).
- **Tests**: `packages/api/test/graphql.test.ts` (29) and DB-gated `packages/persistence/test/users-batch.integration.test.ts`. Eight rules were mutation-tested — each broken in turn, covering test confirmed to fail. That pass caught a flattening test that proved nothing (the studies adapter already flattens both codes, so it passed against broken code); it was replaced with a direct unit test.
- Detailed in `docs/adr/0073-graphql-read-layer.md`.

## M10 Increment 9 — Social UI on the Profile Page (ADR-0074) — first WEB increment
- **The gap it closes**: increments 1–8 were all backend. 91 M10 endpoints existed with **zero UI**; the web app spoke only `/v1/auth`, `/v1/health`, `/v1/seeks`, `/v1/users` across four routes. This is the first increment of the web track.
- **Surface**: the existing `/profile/:handle` route, extended — no new route. Follower/following lists with counts, follow/unfollow, friend requests (send, accept, decline, cancel), block/unblock, and on the viewer's own profile their pending requests, friends and blocked players. All 12 social endpoints reachable.
- **Read path** (`packages/web/src/api/graphql.ts`): `POST /v1/graphql` for nested reads, REST for writes. The binding reason is not round trips — the social endpoints return **bare ids and REST has no id-to-handle lookup** (`/v1/users/:handle` goes the other way), so `player(id:)` is the only route to a display name. `resolvePlayers` batches aliased lookups 20 at a time, well under the endpoint's 50-alias and 1000-complexity limits.
- **Degradation**: `GRAPHQL_ENABLED` is opt-in, so every GraphQL failure becomes `null` rather than an exception, latched after the first attempt. Flag off ⇒ counts, lists and actions all still work; only names fall back to truncated ids under an explanatory note.
- **Derived relationship** (`packages/web/src/app/social-controller.ts`): there is no "do I follow this player" endpoint, so the viewer's own following/blocks/requests are read once (`RELATIONSHIP_SCAN_LIMIT = 100`) and the relationship derived. Knowingly approximate past 100 follows, and safe because `follow` is an idempotent upsert and `unfollow` reports "nothing removed" without failing.
- **Writes reload rather than patch** — a follow can be refused by an unseen block, and a request can be answered from the other side between render and click.
- **Sign-out clears the region**: it holds one account's friends, requests and blocks; leaving it rendered would be a disclosure, not a stale view.
- **Design (Impeccable v4, Operate mode)**: `.rating-row`/`.game-row`/`.panel-row` consolidated onto one shared rule per DESIGN.md's one-row-style requirement; counts sit beside their heading rather than in stat tiles (the SaaS-dashboard anti-reference); follow state carried by the verb, never colour (one accent, and colour-only state fails colourblind users); a signed-out visitor gets an empty action bar rather than disabled buttons.
- **Tests**: `social-controller.test.ts` (15) plus 3 a11y assertions; 305/305 web tests pass. Eight rules mutation-tested, 8/8 caught — the pass caught a stale-load test that proved nothing (identical fakes on both loads meant it passed with the generation guard removed) and it was rewritten with a gated slow response.
- **Recorded gaps**: GraphQL `Player` has no `teams` field despite ADR-0073's Context claiming it; five pre-existing design-system findings in `style.css` are reported, not repaired (fixing drift inside a feature PR is how a design-system change ships unreviewed).
- Detailed in `docs/adr/0074-social-ui-profile.md`.









