# ADR-0128: Endgame training in production, without handing over the answer

- **Status:** Accepted
- **Date:** 2026-08-22
- **Milestone:** M15 Increment 20
- **Extends:** ADR-0006 (M8 feature architecture) into production, as ADR-0115, ADR-0118, ADR-0125
  and ADR-0127 did for Move Explanation, Mistake Prediction, the Puzzle Generator and the Opening
  Explorer.
- **Applies:** ADR-0095 (a learner-scoped view must not carry the answer) and ADR-0127 (an authored
  number must not be published as a measured one).

## Context

`EndgameTrainer` and `BundledEndgameDatabase` (21 curated positions) have existed in
`@chess-platform/ai-features` since M8 Increment 5 with no importer, route, capability or UI.

Unlike the Opening Explorer, its engine is load-bearing: `EndgameTrainerOptions.engine` is required
(`packages/ai-features/src/endgame-trainer.ts:54`) and only `ai` is optional. So this is the
Puzzle Generator's shape — it borrows the API-owned `AnalysisService` and adds no pool. It is
stateless: `nextPosition` and `evaluateAttempt` are independent calls, so there is no table and no
migration.

What makes it different from the four before it is that it is the first feature whose whole purpose
is to *withhold* something from the reader until they have committed. That turns two of its existing
fields into hazards.

## Decision

### 1. `POST /v1/endgames/next` does not carry the solution — and makes no engine call

`TrainingPosition` (`endgame-types.ts`) carries a `solution` with `bestMove`, `bestLine`, `eval` and
`mateDistance`. Serving that to the learner alongside the position would put the answer in the
response to the request that asks for the exercise. A reader with devtools — or any second client —
gets the move before attempting it, and the training feature stops training anything.

This is not a new observation in this repository. ADR-0095 records the same defect in the same
shape: `stepView` emitted `expectedSan` on a move step and `correctIndex` on a quiz step, and
`GET /v1/lessons/:id/steps` is the route the learner's own page calls. The fix there was a
learner-scoped view, and it is the fix here.

So the route publishes the position and the objective only:
`{ id, type, name, fen, sideToMove, objective, difficulty, technique }`. The engine's figures are
reachable exactly once through `POST /v1/endgames/attempt`, after the learner has moved — which is
also the right pedagogy: you find out when you have tried.

A consequence worth stating: because nothing engine-derived is published, **`/next` makes no engine
call**. `EndgameTrainer.nextPosition` is therefore deliberately not used — it exists to compute a
solution this route must not serve, and paying for a search in order to discard its result would be
strictly worse than selecting from the database directly. The library is still the source of the
data and of every judgement; only this one method is bypassed, and this paragraph is why.

### 2. The authored goal distance is not published; the engine's is

Each entry carries an authored `goal`, and for a mate it carries a distance — `{ kind: 'mate',
distance: N }`. Nothing cross-checks that against the engine: `nextPosition` reads the engine's own
`mateDistance` (`endgame-trainer.ts:134`) and never compares the two. A dataset that says "mate in
5" over a position the engine mates in 7 would present an authored number as a measured one.

That is the ADR-0127 decision again, and it resolves the same way. The wire carries `objective` —
`'mate' | 'win' | 'draw'`, which is the *training goal* and not a claim about the position — and the
engine's `mateDistanceAfter` from `/attempt`. The authored distance exists only as metadata inside
the bundled dataset and never leaves it. Publishing a verified distance later is additive; publishing
an unverified one is not reversible once a client renders it.

### 3. The server owns the position

`EvaluateAttemptRequest` takes the whole `EndgameEntry` from its caller. A route shaped that way
would let a client submit any FEN with any goal and have the server grade it — the position, the
objective and therefore the verdict would all be attacker-chosen.

`POST /v1/endgames/attempt` accepts `{ id, move }`. The entry is looked up server-side from the
bundled dataset. The client cannot express a position at all.

### 4. `loss` is a tagged union, because the library returns `Infinity`

`legacyCpLoss` (`endgame-trainer.ts:350`) returns `Infinity` on two branches — lines 352 and 359 —
for a move that walks into mate or throws away a forced mate. `JSON.stringify(Infinity)` is `null`,
so a naive projection would publish an untyped `null` in a field the schema declares a number, and a
client would render "0" or nothing for the most decisive outcome the feature has.

The wire therefore carries `loss: { kind: 'centipawns', value } | { kind: 'decisive' }`, with
finiteness asserted rather than assumed. Same discipline as ADR-0125's tagged evidence: a value that
cannot be a number is given a shape instead of a coerced number.

### 5. Three more JSON-safety and robustness rules

- The library emits the string `'(none)'` for a missing best move (lines 127 and 213). It never
  reaches JSON; `betterMove` is `string | null`.
- `evaluateAttempt` reads `resultsBefore[0]` and `resultsAfter[0]` with no bounds check (lines 211
  and 237). An engine returning no lines would throw on a property read and surface as a 500. The
  service checks first and answers 503 — the deployment failing, said as a deployment failure.
- Only `IllegalMoveError` from `Position.play` (line 218) becomes a 422; anything else is rethrown.
  A blanket catch would report a defect of ours as the learner's illegal move and hide it from the
  error rate. The UCI shape is checked by regex first, so a malformed move costs no engine work.

### 5b. Selection filters itself; `random()` is not used with a filter

`BundledEndgameDatabase.random` (`bundled-endgame-database.ts:285-287`) falls back to
`this.entries[0]` when the filter matches nothing — "Fallback: return the first entry if filters are
too restrictive." A learner asking for an advanced rook endgame would receive a beginner queen mate,
with the response's own `type` and `difficulty` fields contradicting the request that produced it.
The same line also returns `undefined` for an empty dataset while the signature promises an
`EndgameEntry`.

The service therefore filters the catalogue itself and answers 422 when nothing matches, rather than
serving an entry nobody asked for. Composition refuses an empty dataset outright, so the second
hazard cannot arise in production either.

### 6. Standard chess only, and one quota for the feature

`endgame-trainer.ts` hardcodes `variant: 'chess'` and the dataset is standard positions. Neither
route accepts a variant, so there is nothing to refuse.

Both routes charge one `endgameTraining` bucket at 20/user/minute and 40/IP/minute — the
mistake-prediction sizing, because an accepted attempt is two engine searches. One bucket rather than
two because it is one feature and the quota describes the cost of using it; `/next` is free of engine
work, so it can afford to share.

### 7. `endgameTrainer` is a capability, and it needs both halves

True exactly when the composed dependency exists, which requires an analysis service that can
satisfy the fixed limits *and* a non-empty dataset. A deployment where positions can be served but no
attempt can ever be judged is not the feature, so the flag does not split.

### 8. The UI is its own route, not a game-sidebar section

Every existing section in the game sidebar — analysis, tactic, opening, explain, assess — is *about
the position on the board in front of you*. Endgame training is not: it is a separate activity with
its own position, and putting it beside them would ask a player in a live game to start practising a
different one. The board there also belongs to the live game and is driven by `GameController`'s
`onPosition`, so a training position could not use it without fighting the game for it.

The trainer therefore gets its own route, alongside `/courses` and `/lessons`. That is the
established home in this app for "a learner works through a position", it already has the pattern
for a board and a move input inside a page, and `BootstrappedDisposables` (ADR-0092) makes
forgetting to dispose the new controller a compile error rather than a leak.

## Consequences

- A learner cannot read the answer out of the response that gives them the exercise.
- No authored mate distance reaches a client; only engine-measured figures do.
- A client cannot choose the position it is graded on.
- The most decisive verdict the feature produces has a shape on the wire instead of a coerced null.
- `/next` costs no engine time, so browsing positions does not consume search capacity.

## Out of scope, and staying so

The LLM coaching narrative and every field that accompanies it; a larger endgame corpus or a
tablebase; progress persistence, ratings or spaced repetition; `Coach`, `StudyPartner` and
`VoiceCoach` (the first of which composes this feature and is unblocked by it); Chess960; and the
`studies.variant` CHECK-to-FK conversion.
