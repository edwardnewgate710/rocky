# ADR-0130 — Tournament commentary: the caller names a resource, the server supplies every fact

**Status:** Accepted — M15 Increment 22
**Supersedes:** nothing. **Builds on:** ADR-0113 (analysis subsystem), ADR-0115 (move explanation),
ADR-0116 (decided positions are results, not `+0.00`), ADR-0127 (an authored number must not be
published as a measured one), ADR-0129 (the Coach orchestrates production services).

## Context

`TournamentCommentator` has been in `@chess-platform/ai-features` since M9 with no route, no
capability flag and no UI. It offers two things: engine-grounded commentary on a moment in a game,
and a data-grounded narrative recap of a round.

Its library interface takes every fact from its caller — the FEN, the players, the round, the match
results, the standings — because in M9 its caller was a test. That is the whole of what makes it
unsafe to expose: a route that forwarded a request body to it would let anyone have a model narrate
a tournament that never happened, in the voice of this platform.

The second hazard is the opposite of the first. `GET /v1/tournaments/:id/live` is a **public** route
that already publishes the FEN of every game in progress. Attaching an engine evaluation to that
data would turn a spectator endpoint into a live engine for the players in it.

## Decision

### 1. The request carries path identifiers and an empty body

`POST /v1/tournaments/:id/games/:gameId/commentary` and
`POST /v1/tournaments/:id/rounds/:roundIndex/recap` take no body at all. A body carrying any field
is refused with 422 rather than ignored, so a client that tries is told.

Everything else is read by the server: the position and the move from the durable game log, the
players, results and standings from the tournament aggregate, the handle behind each player id from
the users table. There is no field through which a caller could name a player, assert a result, or
choose how much of a shared engine and a metered provider their request spends.

### 2. Membership comes from the tournament; terminality comes from the game log

These are two different authorities and using the wrong one for either question is a live defect.

`Tournament.pairingForGame(gameId)` answers "is this game part of this tournament", and it is
authoritative because the link is written when the game is *launched*.

Whether the game is **over** is answered by the durable event log, not by the tournament's recorded
result. `TournamentResultReporter` records results from a PubSub subscription — asynchronously, with
a periodic scan behind it for the ones that go missing — so a game can be over in the log for some
time before the tournament knows. Asking the tournament would answer "still playing" about a
finished game; the reverse error, which would be analysing a live board, is the one that matters, so
the log is what the service reads.

### 3. The engine looks at the position the final move was played *from*

Not the position it produced. Two reasons, and either alone would be sufficient.

A move and the position it produced do not belong together: pairing them describes a move being
played from a board it has already been played on. That is the defect ADR-0129 §7 found on the
Coach's client, which sent the post-move FEN with the move and got a 422 for every coached move.

And the position a game *ended* in may be checkmate or stalemate, where an evaluation is not a fact
(ADR-0116). The position a legal move was played from never is.

`FinishedGame.fenBeforeFinalMove` is reconstructed by replaying the event log up to but excluding
the final `MovePlayed` event. A game that ended before any move was played has no such position and
is refused.

### 4. Finished games only, and it is a refusal rather than a redaction

An unfinished game answers 409 before any engine is acquired. Not "commentary without the citation"
— a live game gets no commentary at all, because the prose is grounded in the evaluation and a model
told to describe a position it has no evaluation for will describe it anyway.

Live-game commentary is deliberately deferred. It needs a distinction this increment does not make —
between a spectator and a player in the game being described — and that distinction deserves its own
decision rather than being smuggled in behind a feature.

### 5. A round is recapped only when the aggregate says it is complete

`Tournament.isRoundComplete(roundIndex)` is the condition `tryAdvance` uses to decide a round is
over, exposed rather than restated. `tryAdvance` now calls it, so there is exactly one definition of
"this round is finished" and "complete enough to recap" cannot come apart from "complete enough to
pair the next round".

There is no partial recap. A narrative about three of five games under a heading that says "after
round 3" is a false account of a round, and no wording in the prompt undoes a heading. The product
has no partial-recap concept to be consistent with either: `GET /v1/tournaments/:id/rounds` shows a
round in progress as pairings, which is a different thing than a story about how it went.

Arenas are refused with 409 and a reason. They pair continuously and have no rounds at all, so
answering 404 would tell a caller their tournament does not exist when it plainly does.

### 6. Standings are the table as it stood after *that* round

`Tournament.standings()` computes over every recorded result, which is the right answer to "how does
the table look now" and the wrong one for anything reporting on a particular round. By the time a
round-3 recap is requested, round 4 may already have decided games, and presenting the current table
beside round 3's results would label later facts with an earlier round's number.

`standingsAfterRound(roundIndex)` filters the results map before computing. A test builds a
tournament with a decided game in a *later* round and asserts the recap excludes it.

### 7. Facts and prose are separate fields, and separate blocks on screen

The response carries `results`, `standings`, `citation`, `result`, `termination`, `finalMove` — and
`commentary` / `narrative` beside them. The model is handed the facts; it is never asked for them,
and nothing in the response is derived from what it wrote. The web view renders the prose in its own
block under a label that says it is generated, and a test asserts no facts block contains it.

### 8. The library cannot reach an engine, and its fabricated citation is unreachable

`TournamentCommentator` searches whenever its caller supplies no pre-computed analysis. The
production service always supplies it, and the composition root makes that a guarantee rather than a
habit: the library is constructed with an `AnalysisProvider` that **throws on every call**. A future
edit that stopped supplying the analysis fails loudly instead of quietly running a search at limits
the library chose and this API's policy never approved.

There is a second trap in the same method. When `results` is empty, `commentateMoment` builds its
citation as `+0.00` at depth 0 and returns it as though an engine had said so — an authored number
presented as a measured one, which is exactly what ADR-0127 was written about and ADR-0116 before
it. The service refuses with 503 when the analysis produced no usable line, so that branch is
unreachable in production. `firstUsableLine` also rejects a line whose depth is zero or non-finite,
because such a line is not a weaker measurement but the absence of one.

### 9. Server-owned policy, one quota, charged after validation

Fixed depth 18, 1,500 ms, MultiPV 1, asserted satisfiable at construction the way the endgame
trainer asserts its own. Temperature and token ceiling fixed at composition time, exactly as
`createMoveExplanation` fixes them, so no request field reaches them.

Worst case per admitted request: **one engine search and one provider call** for a game commentary,
**zero and one** for a round recap. That is move explanation's bill, so `tournamentCommentary` gets
move explanation's budget — 10/min per user, 30/min per IP — and both routes share the bucket,
because they are two questions about one tournament and splitting them would publish two ceilings
for one bill.

The quota is charged after every free refusal — the tournament lookup, the membership check, the
log read, the completeness check — and before the first expensive call. A caller enumerating game
ids therefore spends nothing, and a test asserts the ordering as a sequence rather than trusting it.

Composing the services internally charges no other route's quota, because this service reaches no
other route.

### 10. Both routes are authenticated

Every route in this API that reaches an engine or a provider requires an account, and these are no
exception. Reading a broadcast costs a database query; generating a commentary costs a search and a
metered completion. Public visibility of a tournament does not make anonymous callers entitled to
spend money on it. A test asserts the 401 *and* that neither subsystem was touched.

### 11. Cancellation reaches both halves

`ctx.signal` — the disconnect signal ADR-0129 added to `RequestContext` — is passed to
`AnalysisPort.analyze` and into the library's `CompletionRequest`, which forwards it to the
provider. A test asserts the signal arrived at both.

### 12. Repeat requests are answered from existing caches, and no store is added

A finished game and a completed round are immutable, so the prompt for a given request is
deterministic. The AI orchestrator already caches completions keyed on a hash of the messages,
grounding and options, and the engine already caches searches keyed on `fingerprint|variant|multiPv|
fen`. Identical requests therefore hit both.

No table and no migration for caching. A durable store of generated prose is a product decision
about publishing — who may read a commentary someone else paid for, and what happens when a model is
replaced — and it is not one this increment needs to make.

### 13. Only handles reach the provider, and only handles reach the wire

`UsersRepository.findByIds` returns whole account rows including email, email hash and moderation
flags. `RepositoryPlayerHandles` projects the handle before the rows reach anything else, so the
private columns exist in one function and nowhere downstream of it.

A player whose account is gone is named `White`, `Black` or `Player` — never their id. Answering
with a UUID would send an internal identifier to a third party to no purpose: a narrative needs a
name to write with, not a key to look anything up by.

**Prompt injection through a handle is bounded by the handle charset, and now also by a check at
this boundary.** `HANDLE_PATTERN` is `/^[A-Za-z0-9_-]{3,30}$/`; registration is the only path that
writes a handle and there is no rename route, so no handle in the database can carry whitespace,
punctuation or a newline — and therefore none can carry an instruction.

Relying on that alone was the version of this decision the adversarial review argued with. It
claimed a crafted handle as a critical injection and was wrong on the facts — the handle it proposed
cannot be registered — but it was right that the safety of putting a person's chosen string in front
of a model rested on a pattern enforced at one route and nowhere in the schema. `displayName` now
checks the shape itself and falls back to `White`/`Black`/`Player` when it does not match.

The guard enforces the same character class, `[A-Za-z0-9_-]`, with deliberately looser length
bounds: length is not what makes a string safe to interpolate, and a name too short or too long to be
a handle is not thereby an injection.

Declining to name them, **not** sanitising them: stripping characters would put a different player's
name in a narrative that reads as official, which is a worse answer than a generic label. Both
directions are mutation-checked — removing the guard fails a test, and replacing it with the review's
proposed `.replace()` fails the same test.

### 14. A gap in the narrative is published, not hidden

`MatchResultData` has three values: `1-0`, `0-1`, `1/2-1/2`. The tournament's own vocabulary is
wider — `bye`, `void` and `double_forfeit` are how a round resolves a pairing nobody played, and
offering one of them to the model as a draw or a win would be telling it something untrue about a
real pairing.

So they are published in `results` and withheld from the prompt, and `pairingsNarrated` says how
many pairings the model was given. When it is below `results.length` the prose covers fewer games
than the round contained, and the UI says so rather than presenting a partial account as a complete
one.

## Consequences

- `packages/tournament` gains three read accessors and loses a duplicated rule; 49 existing tests
  pass unchanged.
- `toHttpError` in `move-explanation-service.ts` becomes a delegation to a shared
  `aiErrorToHttp(err, subject)`. The alternative was a second copy differing only in a noun, and the
  last time this codebase kept two hand-maintained copies of one rule they drifted (ADR-0129 §6b).
- `createApiServer` forwards optional dependencies to the router by hand, and the list is silently
  incomplete when one is added — the new service was wired everywhere else and still answered 503
  until the forwarding line was written. It compiles because every field is optional. This is the
  same defect class the ROADMAP records for `main.ts`'s disposal list, resolved in Increment 25 by
  making it exhaustive at the type level; the same fix belongs here and is **not** in this
  increment. Recorded as a known gap.
- Live-game commentary, a durable store of generated prose, and commentary for arena tournaments are
  all deferred, each because it needs a decision this increment does not make.

## What the review changed

Twenty-five mutations were run against the guards above; twenty-four were caught on the first pass.

**The survivor was the auth declaration.** Flipping both routes from `AUTHED` to `PUBLIC` left every
test green, because `requireAuth` in the handler answers 401 on its own. The declaration is not
redundant, though: the router is what adds `WWW-Authenticate: Bearer` to that 401, so a `PUBLIC`
route would refuse anonymous callers while silently dropping the challenge that tells a client what
to do about it. The test now asserts the header.

The adversarial review raised four findings. Two were acted on and two were not:

- **Prompt injection via a handle (claimed critical) — wrong as stated, right underneath.** Resolved
  as described in §13.
- **No caching, so identical requests buy the search and the completion twice (claimed low) —
  invalid.** `createAiFromEnv` composes the orchestrator with its response cache enabled
  (500 entries, 5 minutes) and `AnalysisService` is composed with an `InMemoryLruCache`; both keys
  are deterministic for a request whose every input is immutable. The proposed fix — a new cache
  keyed by game id — would duplicate two caches that already exist.
- **The terminal check is redundant, so its test cannot fail — valid.** A terminal `AnalysisOutcome`
  carries empty `lines`, so the emptiness check was doing all the work and a mutation deleting the
  terminal check survived. The test case now carries a usable line beside the terminal outcome,
  which is the only configuration where that check decides anything.
- **`|| controller.signal.aborted` in the web controller can never decide anything — valid.**
  `abortInFlight` bumps the generation before aborting and is the only thing that aborts, so the
  guard beside it has already returned. Removed. The same dead clause exists in `CoachController`
  (ADR-0129) and is left alone: it is correct, merely unreachable, and rewriting a shipped
  controller is not this increment's business.

### What the second round changed

CodeRabbit reviewed the pushed commit and posted four findings. All four were valid, and two of them
were about the web mount, which the first round had under-designed.

- **The recap control hard-coded round 0 under a label promising "the last complete round".** A label
  that lies. The client cannot know which round is complete — `GET /v1/tournaments/:id/rounds`
  publishes pairings and no results, so completeness is a fact only the server holds. There is now
  one control per generated round, each naming the round it asks for, and a 409 renders as "that
  round is not finished yet" rather than as a failure. Asking and reporting the server's specific
  answer beats guessing locally, and it avoids a second copy of the completeness rule on the client.
- **The mount appended a button to a container it does not own and never removed it.**
  `lifecycle.ts` tears down and re-bootstraps on every SPA navigation, so a second visit left a
  second element carrying the same id — shadowing the first for `getElementById` — and a click
  listener still holding a disposed controller. `dispose` now removes exactly what the mount
  appended.
- **`NARRATABLE_NAME` was documented as identical to `HANDLE_PATTERN` and is not.** The character
  class matches; the length bounds are deliberately looser. The comment now says so.
- **The "sends no body" test could not fail.** Its fake declared the client's signature and recorded
  `body: undefined` as a literal, so the assertion held for every possible client including one that
  had started sending a body — a fake whose own shape was the assertion. It now captures every
  argument with a rest parameter, and a new client-level test drives the real `GambitClient` through
  a fake transport and reads the request that came out. The controller test proves what the
  controller asks for; only the transport test proves what goes on the wire.

Eight further mutations were run against the fixes. Three survived and each was a real gap rather
than a false alarm: two guards inside `renderRoundControls` that no path could reach (deleted — an
unreachable guard is one nothing can keep honest), and a client that could add a request body with
every test still green, which is what the new transport test now covers.

One defect was found by writing those tests rather than by review: the mount's phase callback wrote
an empty string for every phase that was not `loading` or `idle`, and the controller reports a
failure *before* it reports the phase — so the status line was blanked on every refusal, and the
message explaining it never appeared.

### What the third round changed

Qodo reviewed the same commit and found two bugs. It reached the round-zero defect independently and
marked it resolved once the fix landed. Its second was one neither CodeRabbit nor I had seen, and it
was the most consequential finding of the review:

**The game-commentary half of the feature had no control anywhere in the UI.** The route, the
service, the client method and the controller branch all existed and were tested, and nothing a
person could click reached any of them. The tournament page offered a recap button and nothing else,
so half the increment was reachable only from a test.

The mount now reads `GET /v1/tournaments/:id/rounds` — a public route publishing pairings, each with
the `gameId` of the game launched for it — and offers a recap control per round plus a commentary
control per launched game. A pairing with no `gameId` and a bye get no control, because there is no
game to ask about. Which of those games are *finished* remains the server's question, answered with a
409 rendered as "that game is still being played".

CodeRabbit's fifth finding, on the pushed fix, was that the encoding test could not fail for
`gameId`: the fixture passed an id containing only a space, which `encodeURI` encodes identically to
`encodeURIComponent`, so that half of the assertion could not have caught a change to the weaker
encoder while the `tournamentId` half could. Both segments now carry `/../`.

Four further mutations this round, all caught: three against the new control, and one confirming
the encoding assertion above by swapping `encodeURIComponent` for `encodeURI`.



### What the fourth round changed: two results, not one

Qodo's third inline finding was that `commentateGame` publishes the game log's own result and never
the tournament's recorded one, so a commentary could contradict the standings on the same page. That
is true, and its proposed fix — use the aggregate's result instead — is not the answer, because the
aggregate frequently has no result yet. `TournamentResultReporter` records asynchronously, and the
interval between a game ending and its result being recorded is exactly when a commentary is most
likely to be asked for. Replacing one with the other would trade a rare contradiction for a common
empty field.

They are two different facts. The log says **how the game ended**; the aggregate says **how the
tournament scored it**, and a director can make them disagree by recording a forfeit over a game that
was played out, or by voiding a pairing. So the response carries both: `result` from the log, and
`tournamentResult` — nullable, absent until the tournament has recorded one. The UI shows the second
only when it disagrees with the first, since `1-0` and `white_win` are one outcome in two
vocabularies and printing both would invite a reader to look for a difference that is not there.

Same rule as everywhere else in the increment: publish each fact as what it is, and never let one
stand in for another.

CodeRabbit's full review at this HEAD returned **no actionable comments**. Its two remaining notes
were taken: the `tournamentCommentary` rate-limit entry sat between the Coach's rationale comment and
the Coach's own entry, where a reader would attribute "eight is that budget scaled by the ratio of
the work" to the 10/min commentary bucket, and two type imports from the same module were on separate
lines. Four more mutations, all caught.

### What the fifth round changed

CodeRabbit's full review at the previous HEAD raised three findings. Two were taken and one was
declined with evidence.

- **Every unresolved player in a recap was called `Player` — valid, and a real defect.** A game
  commentary names two people and can call them `White` and `Black`, which are distinct by
  construction; a recap names a whole field, and one shared fallback collapses two deleted accounts
  into two standings rows the reader cannot tell apart, with the model asked to narrate two
  competitors under one name. Each unresolved player now gets an ordinal, assigned over a *sorted*
  id list rather than over encounter order — standings order changes as a tournament progresses, so
  encounter order would rename people in an already-published recap of an earlier round.
- **`standingsAfterRound` reports current withdrawal status, not historical — valid, declined
  here.** `computeStandings` uses `withdrawn` for one thing: a boolean on each row. It does not
  enter points, tiebreaks or ordering (`packages/tournament/src/standings.ts:161`), and neither
  commentary route publishes it — `RecapStanding` carries rank, name and points. So the stale flag
  reaches nothing this increment ships. The proposed fix records a withdrawal round and migrates
  `TournamentSnapshot`, which changes a persisted format and belongs in its own increment. The
  limitation is now documented on the accessor so the next caller finds out before publishing the
  flag rather than after.
- **The mutation total did not add up — valid.** Corrected, and the batches below are the ledger.

Three mutations against the naming fix. One survived: the fixture registered players in ascending id
order, so encounter order already matched sorted order and the test could not tell the two rules
apart — the same defect class as the fake that could not observe a request body. The fixture now
registers in descending order and the mutation fails.

### What the sixth round changed

Two findings, and a failing pre-merge check that no reviewer raised.

- **The body-rejection test posted to one route of the two — valid.** Both handlers call `noBody`
  separately, so removing that call from the commentary handler left the route accepting
  caller-supplied fields with the whole suite still green. The test now posts every body shape to
  both routes, and each handler's call is mutation-checked on its own.
- **The survivor count in PROJECT_STATE disagreed with this ledger — valid.** Corrected, and the
  five survivors are now named there rather than counted.
- **Docstring coverage was 72% against an 80% threshold**, failing CodeRabbit's pre-merge checks.
  I had reported the gates as green without reading that section. It is now 100% of the 107
  functions this diff touches, tests included — the check counts test doubles and helpers, which the
  first pass at this missed, taking coverage only to 74%. One of the gaps was a docstring I orphaned
  myself: inserting `sameOutcome` ahead of `isNarratable` in round four left the latter's comment
  attached to the former.
- **The test counts in PROJECT_STATE were wrong**, claiming 26 service tests against 19 actual. Both
  documents now quote figures taken from the files.

Three things I got wrong about this increment's *reporting* rather than its code, all in the same
direction — checking something narrower than the thing that mattered:

1. I verified "not paused" against the review bodies, where the notice does not appear. It lives on
   the sticky comment. CodeRabbit had auto-paused for the second increment running.
2. I read the sticky for the actionable-comment line and never for its **pre-merge checks** section,
   which was reporting a failure the whole time.
3. My review-comment scrape used an unpaginated `gh api` call, which silently truncates at 30. Two
   actionable comments existed on a second page while I reported none.

### What the seventh round changed

One finding: the commentary published the aggregate token itself — `black_win`, `double_forfeit` —
beside recap rows that render the same values as `0-1` and `Both forfeited`. One vocabulary shown
two ways in one feature. It now goes through the same mapping, with an unrecognised token passing
through unchanged rather than being given an invented label: a value this client does not know is a
server that knows something it does not, and guessing would be the client asserting a fact it does
not have.

### What the eighth round changed

Two findings, both valid.

- **`noBody` accepted `{}` and an explicit JSON `null`.** `strictObject(ctx.body, [])` refuses
  unknown *fields*, so an object with none passed it, and a `null` body returned early. Both then
  produced a 200 from routes whose documented response for a request body is 422 — the contract
  disagreeing with itself. `undefined` is now the only body accepted. Nothing is taken from a caller
  who has a fact to send, because there is no fact these routes accept.
- **`startHarness` had no docblock** although this diff touches it. Documented.

### What the ninth round changed

CodeRabbit’s review at this HEAD posted **no actionable comments**. Two of its three nitpicks were
worth taking anyway, and one of those was understated by its own label:

- **No route test ever read a successful recap.** Marked Trivial, but it meant the recap route’s 200
  branch and `tournamentRoundRecapView` were unexercised end to end: a handler returning the *game*
  view, or a projection that dropped `standings`, would have passed every other test in the file.
  The same class of gap as the four survivors above, found by a label that said Trivial.
- **The pairing result was typed `string`** while the OpenAPI enum published exactly six values. It
  is a `PairingResult` union now. Verified rather than assumed: adding a seventh value to the
  aggregate’s `GameResult` makes `composition.ts` fail to compile, where before it would have
  produced a response failing its own schema at runtime.
- **Declined:** extracting the shared quota closure. The two are identical by design and the shared
  bucket is asserted by a route test that spends the budget on one route and finds it spent on the
  other, so a divergence fails rather than hides. Six lines of indirection would not add to that.

One nitpick on the round-nine fix, and it was the same defect one layer down: the new recap route
test asked for round 0 of a fixture whose only round was round 0, so a handler that always loaded
round 0 would have passed it. The fixture now runs two complete rounds decided opposite ways and the
test asks for round 1 — a handler pinned to round 0, and a projection returning current standings
rather than the round snapshot, both fail it.

The tenth round was the same finding a third time, one layer deeper each time. The route test asked
round 1 of a two-round fixture — the *final* round, where "the table after round 1" and "the table
now" are the same table, so a projection ignoring the requested round passed. The earlier mutation of
that projection had been caught by the *service* test, which is exactly why the route-level gap
stayed invisible.

The fixture now runs three complete rounds decided three different ways and the recap asks for the
middle one, with the expected points derived from the recorded pairings rather than from the
aggregate's own answer. Judged by the route test in isolation, the standings mutation now fails.

One more, and it was an asymmetry the previous round introduced: adding `resultLabel` for the
commentary path left the recap table indexing `RESULT_LABELS` directly, so a token this build does
not know rendered as empty text in one place and as itself in the other. The union types the field,
which is a compile-time guarantee and says nothing about what arrives over the wire. Both paths go
through the same function now.

The twelfth round tightened the same recap assertion once more: checking each returned row against
its own name left a table that lists one player twice and another not at all passing, so long as the
two share a score — every row finds its own expected points and the length is still four. The whole
mapping is compared now, after asserting the names are unique. A mutation that duplicates the first
standings row and drops the last is caught.

The thirteenth round fixed the last state the mount got wrong. Two failures reach the same catch and
need opposite answers: a capabilities read that fails leaves the panel hidden and silent, because
nothing was shown and the section may not exist on this deployment at all; a *rounds* read that
fails happens after the panel is visible and its status already says the section is ready, so saying
nothing left a reader looking at a panel claiming to be ready with nothing in it to click. Both
directions are now tested and mutation-checked.

**Mutation ledger:** 25 + 8 + 4 + 4 + 3 + 2 + 2 + 1 + 2 + 2 + 1 + 1 + 2 = **57 run, 57 caught.** Five survived a first pass and
each one exposed a test that could not fail rather than a guard that was merely missing.

## Known gap, not fixed here

`createApiServer` forwards optional dependencies to the router by hand. The new service was wired
into `deps.ts`, `bootstrap.ts`, `routes.ts` and the test harness and still answered 503 on every
call until that one line was written, and it compiled the whole way because every field is optional.
This is the defect class the ROADMAP records for `main.ts`'s disposal list — resolved in Increment 25
by making the list exhaustive at the type level — and the same fix belongs here. It is a refactor
across a dozen forwarding lines and belongs in its own increment.
