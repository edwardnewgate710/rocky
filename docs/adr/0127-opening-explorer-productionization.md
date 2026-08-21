# ADR-0127: Opening identification in production, without the statistics

- **Status:** Accepted
- **Date:** 2026-08-21
- **Milestone:** M15 Increment 19
- **Supersedes:** nothing. Extends ADR-0006 (M8 feature architecture) into production, as
  ADR-0115, ADR-0118 and ADR-0125 did for Move Explanation, Mistake Prediction and the
  Puzzle Generator.

## Context

`OpeningExplorer` and `BundledOpeningDatabase` have existed in `@chess-platform/ai-features`
since M8 Increment 4 with no importer, no route, no capability and no UI. Of the six M8
features still in that state, this one is different in a way that decides the increment: its
load-bearing half needs neither the engine nor an AI provider. `OpeningDatabase.lookup` is a
synchronous scan of a bundled table, and the engine eval and the LLM narrative that
`OpeningExplorer` can add are declared optional by the library itself. A deployment with no
`STOCKFISH_PATH` and no provider key can serve the whole feature.

That also makes it the first M8 productionization whose risk is not cost. The three before it
each had to answer "how much engine time may one request buy?". This one has to answer a
different question, and the dataset asks it in its own header:

> Stats are approximate aggregate figures for illustration; they are not sourced from a
> specific database.

The entries carry fields like `{ games: 50000, whiteWins: 0.39, draws: 0.36, blackWins: 0.25 }`.
Those numbers were authored, not measured.

## Decision

### 1. The statistics do not exist on the wire

`OpeningExplorationOutcome` and `OpeningContinuationOutcome` have no statistics field, and
`OpeningExplorationResponse` / `OpeningContinuationView` publish `additionalProperties: false`
over exactly `move`, `san`, `eco`, `name`.

This is the whole reason the service owns a projection rather than returning the library's
`ExplorationResult` directly. Serving `games: 50000` through a production API would put an
invented number in front of a reader with nothing on the page to say it was invented, and a
client would be right to render it as a measured win rate. That is the same class of durable
falsehood ADR-0123 refused for `chess960`: a value that is wrong in a way nothing downstream
can detect.

The alternative — ship them labelled "illustrative" — was rejected. A label is a caption, and
captions do not survive a client, a screenshot or a second consumer. Real statistics need a
real corpus; until there is one the field does not exist. This is a deferral of the data, not
of the schema: adding the field later is additive.

The projection lives in the service and not in the presenter so that dropping the statistics is
a property of the only path to the wire, rather than a step a second caller could skip.

### 2. Standard variant and standard start position, refused explicitly

`OpeningExplorer.explore` replays from `Position.initial()` with no variant argument, and the
bundled dataset is standard opening theory. Answering for another variant would attach a real
ECO code to a game those moves never described.

`POST /v1/openings/explore` therefore requires `variant` and refuses anything but `standard`
with a 422 that names the rule. `variant` is required rather than defaulted precisely so the
refusal happens: a defaulted field would let a Crazyhouse client receive a confident answer
about a different game, which is how `chess960` became a label with nothing behind it.

`initialFen` is optional and, when present, must equal the standard start position. It is
optional because the browser cannot supply it — the gateway's `StateView` carries `variant` but
no start position, and adding one is a protocol change, not part of this feature. Omitting it is
accurate today: no creation route accepts an `initialFen`, so every game this deployment can
create begins at `Position.initial(variant)`. The field exists so that the day a custom-start
game becomes creatable, a caller that passes it through is refused instead of being told which
opening was played from a position it never started from.

`STANDARD_START_FEN` is derived from `Position.initial().fen()` rather than written out, so it
cannot drift from the rule set.

### 3. A hard ply ceiling, and a refusal rather than a truncation

`MAX_EXPLORED_PLIES = 60`. Every ply is replayed through `Position.play`, which generates legal
moves, so an unbounded array is a CPU-amplification surface on an endpoint that otherwise has
none. The deepest bundled line is 10 plies, so 60 leaves a wide margin in which `outOfBook` is a
measured answer rather than an artefact of the ceiling; a test computes the deepest entry from
the dataset and fails if the ceiling ever drops below it.

A longer sequence is refused, never truncated. Truncating would answer about a prefix of what
was asked, confidently, with nothing in the response to say so — and because `lookup` matches on
a prefix, the answer would usually even look right.

Validation is ordered cheapest-first: variant, then start position, then length, then a UCI
shape regex, and only then the replay. A malformed or oversized request never constructs a
position.

### 4. Ordinary rate limiting, charged up front

`openingExploration` gets its own bucket at 60/user/minute and 120/IP/minute — an ordinary
ceiling, not the expensive-work quota the engine routes use. The engine routes admit *after*
cheap validation because there is an expensive phase to protect; here there is no such phase, so
the bucket protects the replay itself and is charged before it.

Its own bucket rather than a share of `analysis`: identifying an opening must not consume the
quota a player needs to analyse a position, and charging a cheap request against an expensive
ceiling would misprice both.

### 5. `openingExplorer` is a capability, derived from a dependency

The flag is published rather than left for a client to infer, for the reason ADR-0118 gives:
a client that infers a capability is a client that keeps working after the inference stops being
true. Alone among the feature flags it neither implies nor is implied by `analysis` — it is true
on a deployment with no engine binary and false on one whose bundled dataset is empty however
good its engine is.

`createOpeningExploration` returns `undefined` for an empty database so that the flag is derived
from something real, by the same mechanism every other flag uses, rather than being a constant
`true` that stops meaning anything the day the dataset moves.

There is deliberately no variant list beside it. The feature serves exactly `standard`, and a
one-element array would invite a client to treat it as a set that could grow without the server
saying so.

### 6. `/v1/openings/`, not `/v1/analysis/`

The prefix is a claim about what serves the request, and no engine does. A deployment with no
engine configured answers this endpoint in full, which `/v1/analysis/` would misdescribe. Same
reasoning as ADR-0118's note on why mistake prediction is not under `/v1/ai/`.

### 7. Only `IllegalMoveError` becomes a 422

The replay happens inside the library, so illegality surfaces as a thrown
`IllegalMoveError`. The service narrows its catch to that type and rethrows anything else.
A blanket catch would report a defect of ours as the caller's mistake and hide it from the error
rate.

## Transpositions are not recognised, and that is the current contract

`BundledOpeningDatabase.lookup` matches an entry whose move list is a **prefix of the submitted
sequence**. It does not look at the resulting position. So `1.Nf3 Nc6 2.e4 e5 3.Bb5` reaches the
Ruy Lopez position and returns `found: false`, while `1.e4 e5 2.Nf3 Nc6 3.Bb5` returns `C60`.

This is pinned by a test rather than fixed. Position-keyed lookup is a different data structure
and a different dataset — it is the corpus question again — and quietly widening the matcher
would change what every stored ECO code means. The UI's "no known opening" state is therefore an
honest answer to a real limitation, not a bug being papered over.

## The move sequence, and why the client may not always have one

`GameController.moveSequence` returns the full UCI ledger from ply 1, or `null`. The gateway's
snapshot carries every `MoveView.uci` back to the first even for a game joined mid-play, which is
why this is available where `lastReplayedMove` (ADR-0117) is not: that needs the position each
move was played *from*, and the snapshot carries no per-move FEN.

It returns `null` rather than a best effort when the ledger is not a contiguous run from ply 1.
An opening is identified by a sequence read from the start, so a gap would name an opening for
moves never played in that order. There is no partial answer to give.

## Consequences

- Opening identification is available on every deployment, including ones with no engine and no
  AI provider — the first M8 feature of which that is true.
- No invented statistic can reach a client, because no field carries one.
- A non-standard variant, a non-standard start position, an illegal sequence and an over-long one
  are each refused with a 422 that says which rule refused it.
- The endpoint cannot be used to amplify CPU: one request replays at most 60 moves and consults a
  16-entry table.
- Transposed move orders are not identified. This is stated, tested, and left alone.

## Out of scope, and staying so

Opening statistics; a real corpus or master-game database; engine evaluation of the current
position; LLM narrative; a position-keyed (transposition-aware) matcher; Chess960; the remaining
library-only M8 features (Endgame Trainer, Coach, Study Partner, Voice Coach, Tournament
Commentator); and the `studies.variant` CHECK-to-FK conversion, which remains deferred for the
reasons in ADR-0120 and the M15 Increment 10 notes.
