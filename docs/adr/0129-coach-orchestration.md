# ADR-0129: Coaching by orchestrating the services, not by re-running the library

- **Status:** Accepted
- **Date:** 2026-08-22
- **Milestone:** M15 Increment 21
- **Extends:** ADR-0006 (M8 feature architecture) into production, as ADR-0115, ADR-0118, ADR-0125,
  ADR-0127 and ADR-0128 did for Move Explanation, Mistake Prediction, the Puzzle Generator, the
  Opening Explorer and the Endgame Trainer.
- **Applies:** ADR-0095 (a learner-scoped view must not carry the answer), ADR-0116 (a decided
  position is a result, not a score) and ADR-0127 (an authored number must not be published as a
  measured one).

## Context

`Coach` (`packages/ai-features/src/coach.ts`, M8 Increment 6) is the composition layer over the five
feature classes. It has been library-only for the same reason the others were: its dependencies were
library-only. Increment 20 shipped the last of them, so all five are now production services with
their own routes, capabilities, quotas and — crucially — their own hard-won policies:

| Service | Route | Owns |
|---|---|---|
| `MistakePredictionService` | `/v1/analysis/mistake-prediction` | thresholds, the `judged`/`terminal` split |
| `MoveExplanationService` | `/v1/ai/move-explanation` | the provider, prompt, and grounding |
| `PuzzleGenerationService` | `/v1/analysis/puzzle` | MultiPV 3, the sharpness threshold |
| `OpeningExplorationService` | `/v1/openings/explore` | standard-only, the 60-ply ceiling |
| `EndgameTrainingService` | `/v1/endgames/next`, `/attempt` | answer withholding, finiteness guards |

The obvious implementation is to construct `Coach` from `ai-features` and expose it. That is the
wrong one, and the reason is the whole of this ADR.

## Decision

### 1. Compose the services, never the library `Coach`

`Coach`'s constructor (`coach.ts:110-125`) builds its own `MoveExplainer`, `MistakePredictor`,
`OpeningExplorer`, `PuzzleGenerator` and `EndgameTrainer` directly on the raw `AnalysisProvider`
port. Using it in production would route every coaching request around all five services and
therefore around every policy in the table above: the standard-only opening gate, the ply ceiling,
the terminal adjudication that stopped checkmate reading as `+0.00`, the finiteness guards, the
`'(none)'` containment, and the answer withholding.

None of that would fail loudly. It would produce plausible coaching with the guards missing — the
worst possible failure mode for a subsystem four increments were spent hardening.

So `CoachService` calls the same five services the five routes call, and contributes nothing but
sequencing. The library `Coach` class remains where it is, unused by production, exactly as
`EndgameTrainer.nextPosition` does (ADR-0128 §1).

### 2. A section may never publish more than its own route does

Four of the five sections are rendered by the *existing presenter* for that feature —
`mistakePredictionView`, `moveExplanationView`, `openingExplorationView`, `endgameNextView`. That is
not brevity. It means there is no second projection here that could drift from the first, so a field
withheld at a feature's own route is withheld here by construction rather than by a rule someone has
to remember. The OpenAPI section schemas `$ref` those same response schemas, for the same reason.

The endgame section reaches the catalogue through a new `EndgameTrainingService.identify(fen)`,
which returns `EndgameNextOutcome` from the same private `project()` that `next()` uses. There is
deliberately no variant of it that returns an `EndgameEntry`. This closes a real back door: a learner
with a training position open could otherwise have pasted its FEN into `/v1/coach` and read the
answer that `/v1/endgames/next` deliberately withholds.

### 3. The puzzle section is narrowed, and it is the one exception

`/v1/analysis/puzzle` publishes `solutionMove` and `solutionLine`, and should keep doing so: a caller
asking "is my position a tactic, and what is it" is studying their own position.

Inside a coaching response the same fields read differently. "There is a tactic here" is a coaching
prompt; "there is a tactic here and it is `c6d4`" is the answer, and handing a learner the answer to
the exercise they are looking at is precisely the defect ADR-0095 fixed for lesson steps. So
`CoachPuzzleOutcome` carries `kind`, `fen`, `variant` and `difficulty`, and nothing else.

It is built field by field and never by spreading the outcome. A spread would mean any field later
added to `PuzzleGenerationOutcome` — including another form of solution — appears in the coaching
response the day it is added, with no diff here for a reviewer to catch. `additionalProperties:
false` over four named fields makes such a field fail the contract test instead.

### 4. Degrade by section, with a reason, and distinguish permanent from transient

Every section is `{kind:'present', value}` or `{kind:'omitted', reason}` — never an absent key, never
`null`. A client that receives nothing for a section can say why, and "the engine is down" and "your
move was already the best one" are not the same thing to show a learner.

The five reasons are closed: `not_requested`, `not_applicable`, `unsupported`, `unavailable`,
`cancelled`.

`unsupported` and `unavailable` are kept apart deliberately, and the first draft of this conflated
them. A feature this deployment never composed will not appear because someone retried; a search
that failed may well succeed next time. They need different wording in the UI and they mean different
things for the status code.

### 4b. A section that *cannot* serve this request is asked, not caught

Two sections could take the whole request down with them, and both were found by the adversarial
review rather than by design.

Opening exploration serves `standard` only and answers 422 for anything else. `sectionFailure`
rethrows everything that is not a 503 — deliberately, so a caller mistake cannot hide behind a
plausible response — so a Crazyhouse game that supplied its move ledger lost the tactic, mistake and
endgame sections too, none of which have anything to do with openings. The section now asks
`supportsVariant` before calling, and reports `unsupported`.

Move explanation is the one section whose input is not the caller's: the move it explains comes from
the engine, and the caller's own FEN and move were validated at the top of `coach()`. So a 422 there
says the engine offered a move that is not legal in the position it was asked about — a server-side
disagreement the caller can do nothing about, and no reason to discard four sections that answered.
That one section tolerates a 422 as `not_applicable`; every other section still rethrows.

### 5. The request fails only when nothing was delivered *and* something is broken

Two formulations were wrong before this one.

"Every section is unavailable" is unreachable: a request carrying no move leaves three sections
`not_requested`, so a completely broken deployment would answer 200.

"Nothing fired" is too aggressive: a position that is not a book line, not a tactic and not a
catalogue endgame is the most ordinary answer this endpoint gives, and it is coaching, not an error.

What distinguishes them is *why* the sections are empty. If every empty section is empty because
there was nothing to say, that is a 200. If any of them is empty because a dependency failed, the
caller got nothing and a retry might do better — a 503 with `Retry-After`. A permanently absent
capability (`unsupported`) does not count toward this, because no retry will fix it.

### 6. Validation before cost, once, at the top

The FEN, the move's shape and its legality under the requested variant, and the ply cap are all
checked before `onAccepted` and before any service is called. Each feature service validates again —
that is not redundant. A coaching request feeds the same position to up to four of them, so a fault
found by the third would already have been paid for by the first two. Finding it once, first, makes
a malformed request cost nothing.

### 6b. The shape filter is the one the services it feeds use

`UCI_SHAPE` here was `/^[a-h][1-8][a-h][1-8][qrbn]?$/`, while `MistakePredictionService` and
`MoveExplanationService` both used `/^(?:[a-h][1-8][a-h][1-8][qrbn]?|[PNBRQ]@[a-h][1-8])$/`. Because
this one runs *first*, anything narrower refuses a move they would have accepted: a legal Crazyhouse
drop was reported as malformed input before any variant-aware rule saw it, and `betterMoveOf`
silently discarded an engine preference that happened to be a drop.

Making the three regexes match would have fixed the symptom and left three copies to drift again, so
there is now one — `isUciShape` in `analysis/uci.ts` — and all three import it. The first version of
the test for this declared its own copy of the regex and asserted against *that*, which could not
have failed however far the real filter drifted; it now exercises the shared function.

### 6c. A decided game is refused before the charge, but only when a move was supplied

Checkmate and stalemate cannot reach the sections when a move was supplied — `play` rejects the move
first — but a draw by the fifty-move rule, by insufficient material, or by a variant rule leaves
legal moves on the board while the game is over. Mistake prediction and move explanation both refuse
such a position before their own `onAccepted`; this service calls them *after* its own, so the caller
was charged and then handed their 422.

The refusal is scoped to a supplied move deliberately. A finished game still has an opening worth
naming and may still be a catalogue endgame, and refusing the whole request would take those away
over a question nobody asked.

### 7. Four searches, not five, and the client chooses none of them

Worst case for one accepted request:

| Search | MultiPV | Issued by |
|---|---|---|
| the position | 1 | mistake prediction, **and** move explanation |
| the position after the played move | 1 | mistake prediction |
| the position after the engine's preferred move | 1 | move explanation |
| the position | 3 | tactic detection |

Two services independently issue a byte-identical `analyze({fen, variant, multiPv: 1})` of the
starting position. `RequestScopedAnalysis` collapses it: five searches become four. It keys on the
complete argument set, so a hit is a request that could not have produced a different answer, and it
stores the *promise*, so two searches issued concurrently coalesce rather than race.

The engine's own `InMemoryLruCache` (keyed `fingerprint|variant|multiPv|fen`) would collapse the
sequential case too, but it has no single-flight and it is a configurable cache — relying on it would
make the cost bound depend on `cacheEntries` being non-zero. A test asserts the bound directly by
counting what reached the provider.

The request body carries `fen`, `variant`, `move` and `moves`, and `strictObject` refuses anything
else. There is no depth, nodes, movetime, multiPv, threshold, provider, model, temperature or token
field, because each would let a caller decide how much of a shared engine and a metered provider to
spend on itself. What a caller controls is which questions *apply* — omitting `move` means there is
no move to judge — never how expensively they are answered.

### 8. Sections run in sequence

Not `Promise.all`. Concurrency would multiply the engine acquisitions one request can hold, defeat
the de-duplication above (single-flight only helps if there is something to collapse onto), and leave
nothing to cancel between sections. Sequential is both the cheaper and the cancellable order.

### 9. Its own quota, and composing the services charges none of theirs

`coach` is a new bucket at 8/min per user and 16/min per IP, against 20/min for the two-search
features. Four searches is twice two, and the provider call is the part with a bill attached.

Charging happens in exactly one place — the `admit` helper in `routes.ts`, called once with both
buckets. The five services never touch the limiter; they receive an optional `onAccepted` callback
that the *route* supplies. So invoking them internally charges nothing, and the Coach's quota is the
whole price of a coaching request rather than one charge among six. A test sets each sibling bucket
to a single request and proves it is still unspent after two coaching calls.

### 10. Cancellation, finally wired

`AnalysisRequest.signal` has always existed in the engine layer — "aborting removes a queued job or
`stop`s an in-flight one" — but nothing could reach it. `RequestContext` carried no signal, no route
observed client disconnect, and `AnalysisService.analyze` built its own timeout controller and
accepted none from the caller. Two links were missing and both are now in place:

- The router derives an `AbortSignal` from the response's `close` event. Bound to the *response*,
  not the request: `req`'s `close` fires when the request body has been received, which happens long
  before a handler finishes, so aborting on it would cancel every request the moment its body
  arrived. `res.writableFinished` tells a completed response from an abandoned one.
- `AnalysisService.analyze` takes an optional signal and combines it with the timeout via
  `AbortSignal.any`. Combined, never substituted: a caller may shorten a search, never lengthen it
  past the deterministic ceiling.

`CoachService` injects the request's signal through `RequestScopedAnalysis`, which reaches all five
services without any of them growing a parameter, and checks it between sections so a caller that
disconnects stops the work that had not started.

`RequestContext.signal` is required rather than optional so a handler cannot skip cancellation by
forgetting a null check. Every other route ignores it today, which is exactly the behaviour they had
before.

## Consequences

- The Coach is the first endpoint whose availability is derived from other features rather than from
  a dependency of its own. `capabilities.coach` is true when *any* of the five is — the narrowest
  honest claim a single boolean can make about five features. A client that needs to know which
  sections to expect reads the five flags, not this one.
- `AnalysisPort` is extracted from `AnalysisService` so a request-scoped decorator can stand where
  the concrete class was named. TypeScript compares classes with private members nominally, so a
  structural look-alike would not have been assignable. `AnalysisService implements AnalysisPort`
  unchanged; the four feature services and the two composition helpers name the port instead. Types
  only — no runtime behaviour moved.
- The endgame section matches on the exact FEN, as the library's own `findEndgameForFen` does, so it
  fires when a learner is literally on a catalogue position and not otherwise. Recognising an
  arbitrary K+P ending as "a K+P ending" would need a material classifier that does not exist, and
  inventing one here would be the Coach fabricating a lesson — the one thing its own contract says it
  never does.
- Signing out clears the section, not just the button. Refreshing the controls alone disabled the
  control and showed the signed-out note while the previous session's advice stayed rendered beside
  it — the page saying two contradictory things at once. Same rule ADR-0074 applied to the social
  region.
- Cancellation reaches the two engineless sections too. Neither opening identification nor endgame
  lookup touches an engine, so skipping them saves almost nothing — but a caller who has gone is
  owed no work, and a section reporting `cancelled` is a more honest record than one that quietly
  ran anyway.
- The sidebar sends the position a move was played *from*, not the one it produced.
  `GameController.lastReplayedMove` carries `{fen, uci}` where `fen` is the position before the
  move; `controller.fen` is the position after it. Pairing the played move with the resulting
  position asks the server to play a move that has already been played, which is illegal in almost
  every position — so the first version of this answered 422 for every coached move, and passed a
  green suite because the mount tests stubbed the transport and returned a canned 200 regardless of
  the body. A test now asserts the request body itself.
- Move explanation explains the engine's preferred move rather than the played one, following the
  library. When the player found the engine's own choice there is no *better* move, and the section
  is `not_applicable` rather than an explanation of what they already did.

## Deferred

Study Partner (needs a durable `StudySessionStore`: a table, a port, a Pg adapter and a migration,
and it embeds a whole `CoachingResponse` per turn), Voice Coach, Tournament Commentator, the LLM
narrative that `Coach.coach` synthesises over the sections, Chess960, and `studies.variant`
CHECK → FK.

The narrative is the notable one. It is one more provider call over data the response already
carries, and every fact in it would be traceable to a section — but it is also a second place where
model prose could contradict engine fact, and the sections are individually legible without it.
Adding it is a decision about product voice, not a missing piece of this one.
