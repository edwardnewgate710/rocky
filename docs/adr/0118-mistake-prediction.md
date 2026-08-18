# 118. Mistake Prediction as an Engine-Only Product Capability

Date: 2026-08-18

## Status

Accepted

Extends [ADR-0113](0113-analysis-endpoint.md) (dedicated analysis pool), [ADR-0116](0116-terminal-position-semantics.md)
(terminal semantics) and [ADR-0117](0117-move-explanation-ui.md) (sidebar lifecycle).

## Context

`MistakePredictor` has existed in `@chess-platform/ai-features` since M8 increment 3 and has never
had an importer outside its own two test files. Reading it against current `main` rather than against
the M8 write-up turned up six defects, four of them correctness rather than style:

1. **The variant never reached the rules engine.** `Position.fromFen(request.fen)` was called with no
   variant while `variant` was carried separately into the engine request. Legality, the resulting
   FEN and any adjudication were therefore decided by *standard* rules on an Atomic, Horde or Racing
   Kings position, while the engine analysed the same position as the variant it actually was. One
   request, two disagreeing opinions about which game was being played.
2. **Legacy vocabulary.** `defaultVariant ?? 'chess'`. `chess` is not in `VARIANTS`, fails
   `parseVariant` at the API boundary, and matches no engine pool. Its tests asserted `chess` too, so
   the suite was evidence for the defect rather than against it.
3. **Delivering checkmate was classified as a blunder.** The predictor always ran a post-move search.
   A decided position gives the engine nothing to score, so it answered with the `{ cp: 0, depth: 0 }`
   placeholder of ADR-0116; negated to `0` and subtracted from a winning `evalBefore`, mate-in-one
   scored as a several-hundred-centipawn loss. The worst possible answer on the most satisfying move
   in chess.
4. **`centipawnLoss` could be `Infinity`.** `JSON.stringify(Infinity)` is `null`, so any serialising
   caller already received an absence — with none of the intent, and no way to tell it from a field
   that was never set.
5. **Classification policy was caller-supplied.** `PredictRequest` exposed `inaccuracyThreshold`,
   `mistakeThreshold`, `blunderThreshold` and `limits`.
6. **Grounding was built twice** — `buildGroundedMessages(...)` *and* `grounding` on the
   `CompletionRequest` — the same defect removed from `MoveExplainer` in ADR-0115.

Plus two structural ones: `engine: AnalysisProvider` was **required**, so there was no way to compose
the class without handing it an engine; and `resultsBefore[0].evaluation` was indexed unguarded,
which compiles because this package's `tsconfig.json` has no `noUncheckedIndexedAccess` and throws a
`TypeError` at runtime on an empty result set.

## Decisions

### 1. No AI provider on this path — ADOPTED

The classification, the centipawn loss, the better move and both sides of the evidence are facts
about the rules and the engine. Nothing about them needs a language model, and the M8 design already
said so — the LLM only ever wrote optional prose beside them.

The question for this increment was whether to keep that prose. It is dropped, and the reason is
specific rather than budgetary: **"Explain last move" already ships in the same panel**, reads the
same previous-FEN and full-UCI target, and already produces engine-grounded prose about that exact
move (ADR-0117). A second paid completion producing a second paragraph about the same move, six
pixels away, is duplicate spend with no distinct role.

The payoff is larger than the saving. With no provider on the path the capability depends on the
analysis subsystem alone, so **every deployment with an engine gets Mistake Prediction**, configured
AI provider or not — where Move Explanation needs both halves and goes dark without either. Provider
calls per request: **0**.

The library's `ai` option is kept. The class stays exported, M8 shipped it, and the duplicated
grounding is a real defect worth fixing whether or not this increment calls it. It is simply not
composed in production.

### 2. Reuse the one analysis subsystem; make a second pool unrepresentable — ADOPTED

`MistakePredictor.engine` becomes optional, exactly as `MoveExplainer.engine` did in ADR-0115. The
composition root builds it with **no `engine` key at all** and hands pre-computed analysis on every
call. There is no parameter through which a second `EngineManager` could arrive, so "do not create a
second pool" is enforced by the type rather than by review. `predict` throws a composition error if
asked for analysis it was given no way to obtain.

`MistakePredictionService` lives in `packages/api/src/analysis/`, not `ai/`, because the directory is
a claim about what serves the request and no AI provider does.

### 3. Server-owned classification policy — ADOPTED

Thresholds move from `PredictRequest` to `MistakePredictorOptions`, fixed at construction. A request
that can raise the blunder threshold can declare that its blunder was fine, which makes the verdict
an opinion the caller supplied rather than a fact about the move.

The ladder keeps its M8 values — **inaccuracy ≥ 50 cp, mistake ≥ 100 cp, blunder ≥ 300 cp** — because
investigation found them to be the established product contract and conventional across the field,
not because they were there. They are compiled constants with no environment override: a threshold
has no meaningful *ceiling* (a larger one is more lenient, not more expensive), so a clamped env var
would be a knob with no safe direction and one more thing to misconfigure.

The public vocabulary stays four values: `ok`, `inaccuracy`, `mistake`, `blunder`. No `brilliant`,
`great` or `excellent` — those are claims about *why* a move is good, and no centipawn difference
supports them: a forced-mate finish and a quiet best move produce the same zero loss.

### 4. A decided game is a result, and a draw is the only one with a centipawn measure — ADOPTED

**The class adjudicates terminality itself; a caller may override.** The first draft of this ADR read
the terminal outcome only from `PredictRequest.terminalAfterMove`, on the reasoning that the API owns
the rules engine and `ai-features` sits below it. That reasoning confused *phrasing* with *detecting*.
It fixed defect 3 above for the one caller that pre-adjudicates and left it live for every other:
`Coach` calls `predict` with no terminal field, so a checkmating move was still searched, still
scored `+0.00`, and still classified a blunder — while this document claimed the defect was gone from
the class. `predict` now derives the outcome from the `Position` it already built, through core's own
variant-aware `status()`, which is not a second implementation of the rules but a call to the same
one the API reaches through. A caller-supplied outcome still wins, because it can know what a single
position cannot — repetition needs the move history — and because it owns the wording. Found in the
independent review of PR #136.


The response carries a tagged `after`, `{ kind: 'evaluation' } | { kind: 'terminal' }`, per ADR-0116.
`centipawnLoss` is `number | null` and never `Infinity`.

Classification from a terminal result, in precedence order:

| Situation | Verdict | `centipawnLoss` |
|---|---|---|
| The move wins the game | `ok` | `null` |
| The mover was already being forcibly mated | `ok` | `null` |
| The move loses the game | `blunder` | `null` |
| The move draws, from a forced win (`mate` before) | `blunder` | `null` |
| The move draws, from a centipawn evaluation | ladder | `evalBefore − 0` |

**A draw genuinely has a measure, and this is not a fabrication:** zero is exactly where the engine's
own scale puts an equal game, so the loss against a drawn result is real arithmetic. Throwing away
+5.00 into stalemate is a 500 cp blunder; holding a draw from −8.00 is a negative loss and reads as
`ok`. A win and a loss sit on no shared scale with a pawn count, so they are classified directly and
report no number rather than an invented one.

**"Already lost" outranks everything except winning**, in the terminal path and the evaluation path
alike. If the mover was being forcibly mated before the move, the move cost them nothing — every move
loses. Calling that a blunder blames the player for the position rather than for the move, and this
feature only ever measures the move.

Mate scores are not large centipawn values but a different kind of claim, so any transition touching
one reports `null` and is classified on what happened: walked into mate → `blunder`; threw away a
forced win → `blunder`; found a forced win → `ok`.

### 5. `bestMove` is nullable, and equality is the answer — ADOPTED

`null` rather than the M8 `'(none)'`: a placeholder string is a value a client can render, compare and
store as though it were a move. When `bestMove === move` the player found the engine's own choice —
expressed by the equality, not by a boolean beside it. Two fields that must agree are two fields that
can disagree; the same reasoning that kept `winner` off `TerminalOutcome` in ADR-0116.

### 6. Endpoint under `/v1/analysis/`, not `/v1/ai/` — ADOPTED

`POST /v1/analysis/mistake-prediction`. The prefix is a claim about what serves the request, and
`/v1/ai/` would be false here and would imply the wrong capability gate. The router matches on
segment count, so there is no collision with `POST /v1/analysis`.

Request body is exactly `{ fen, variant, move }` under `strictObject`. No thresholds, depth,
movetime, MultiPV, provider, model, temperature, token or retry field — none of them exists, so none
can be smuggled.

### 7. Cost contract: 0 / 1 / 2 searches — ADOPTED

| Request | Engine searches | Provider calls |
|---|---|---|
| Rejected (bad FEN, illegal move, unsupported variant, already-decided position) | **0** | 0 |
| Accepted, the move ends the game | **1** | 0 |
| Accepted, play continues | **2** | 0 |

All three pinned by tests. The pre-move search always runs — it is what the engine would have played
instead, and the gap is the whole verdict. The post-move search runs only when something is left to
evaluate.

Quota is charged **after** validation and legality and **before** any search, through the same
`onAccepted` seam ADR-0115 introduced: a stream of malformed FENs must not empty a user's budget, nor
their neighbours' through the shared per-IP bucket.

Its own rate-limit bucket, 20/min per user and 40/min per IP — tighter than analysis because an
accepted request can be two searches, looser than move explanation because there is no money in it.
Not a share of the analysis bucket: assessing moves must not exhaust a user's ability to analyse a
position, and the two limits describe different costs.

**No capacity claim is made.** Concurrency is still bounded by ADR-0113's `maxWorkers`, and no load
test has been run against this endpoint.

### 8. Capability tracks the engine, not the provider — ADOPTED

`capabilities.mistakePrediction` is true exactly when `deps.mistakePrediction` is set, which happens
exactly when the analysis subsystem composed. Variant gating reuses `analysisVariants` — the same
list, not a second one free to drift. Published as its own flag rather than left for a client to infer
from `analysis`, because a client that infers a capability keeps working after the inference stops
being true.

## Consequences

- Delivering checkmate is `ok`, not `blunder`. This is a behaviour change to a class M8 shipped, and
  the M8 tests that asserted otherwise were asserting a defect.
- `MistakeVerdict` loses `evalAfterMoverPerspective` / `evalAfterLabel` and gains a tagged
  `moveOutcome`. `centipawnLoss` becomes `number | null` and `betterMove` becomes `MoveUci | null`.
  In-repo consumers (`coach.ts`, `voice-coach.ts`) read only `classification` and `centipawnLoss` and
  are unaffected; their test fixtures were updated.
- `evalToCpLoss` returns `number | null`. `EndgameTrainer` — not part of this increment — projects
  that back onto the number it published before, with the projection stated at the call site. Changing
  its published shape belongs with productionising *that* feature.
- The remaining seven M8 features are still library-only.
- Repetition is still not adjudicable from a bare FEN (ADR-0116); a threefold draw cannot be detected
  by an endpoint that receives only a position.
- No cost accounting and no client-disconnect cancellation, both inherited from ADR-0113.
