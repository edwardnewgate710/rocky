# 116. Decided Positions Are Results, Not Evaluations

Date: 2026-08-18

## Status

Accepted

## Context

A position with no legal moves gives a UCI engine nothing to search. It answers `bestmove (none)`
without emitting any `info score` line, and `UciEngineInstance.assembleResults` fills the gap with a
placeholder:

```ts
// No scored info (e.g. an instant book/terminal reply). Emit a minimal result.
results.push({ multipv: 1, evaluation: { type: 'cp', value: 0 }, depth: 0, /* … */ });
```

Sound as an internal marker. A lie the moment it is served as an evaluation — and it was, on two
surfaces. `POST /v1/analysis` answered a checkmate with `+0.00` at depth 0, and Move Explanation
grounded its prose in the same number, telling the model *"Evaluation after f3f7: +0.00"* about
Scholar's Mate. The most consequential thing an explanation can get wrong, on the move a beginner is
most likely to ask about.

Found in the independent review of the merged PR #134, verified by running
`Position.status()` on the position (`legalMoves().length === 0`, `isCheck() === true`) and by
reading `assembleResults`. It predates PR #134: the same placeholder reached `/v1/analysis` from
ADR-0113 onward.

## Decisions

### 1. Adjudicate at the API boundary, not in the engine package — ADOPTED

`EngineResult` is consumed by anti-cheat's evaluator and the gateway's bot mover as well as by these
two routes. Changing what a result *means* for every consumer, to correct a presentation defect on
two HTTP surfaces, is a far larger blast radius than the defect. The placeholder stays; nothing
publishes it as an evaluation.

### 2. Reuse `Position.status()` — do not implement terminal detection twice — ADOPTED

Core already answers this authoritatively and variant-aware. `status()` resolves King of the Hill
centre occupation, Three-check counts, Atomic king explosion, Racing Kings promotion and Horde
annihilation **before** the generic no-legal-moves check, so `analysis/terminal.ts` needs no
per-variant knowledge and cannot drift from the rules the rest of the platform plays by.

This is why the obvious shortcut is wrong. "Zero legal moves" would look equivalent and is not: a
King of the Hill win with material on the board has legal moves and is over, and standard rules call
the same position ongoing. A test pins exactly that pair, and mutation-testing the shortcut in
confirms it fails.

### 3. Terminal means `status().over`, including draws by rule — ADOPTED

Not only checkmate and stalemate. Insufficient material, the fifty-move rule and variant draws are
equally decided, and an evaluation of a drawn-by-rule position is equally a claim about a game that
is over. One predicate, no compound condition, no second definition of "finished".

### 4. An explicit discriminator on the wire, never a sentinel — ADOPTED

`AnalysisResponse` gains `terminal`, present only when decided, with `lines: []`. The Move
Explanation citation replaces its post-move evaluation trio with a tagged union:

```ts
moveOutcome:
  | { kind: 'evaluation'; evalKind: 'cp' | 'mate'; evalValue: number; evalLabel: string }
  | { kind: 'terminal'; reason: TerminalReason; result: '1-0' | '0-1' | '1/2-1/2' }
```

No magic score, no magic depth, no empty string to interpret. `reason` mirrors core's `GameStatus`
reasons; `result` is the platform's existing `ResultString`, the same strings `GameSummaryView.result`
already puts on the wire — so a client that can render a finished game can render this without
learning a second spelling of "White won". `winner` is deliberately absent: `1-0` already says it,
and two fields that must agree are two fields that can disagree.

`threefold` is not offered. It cannot be derived from a single FEN — repetition needs the move
history, which no analysis request carries. The switch maps it anyway so a future core change fails
to compile here rather than silently reporting a decided position as ongoing.

This breaks the shape of `citation` published by ADR-0115, which shipped hours earlier. Correctness
takes precedence over preserving a demonstrably false evaluation.

### 5. A decided position costs no engine search — ADOPTED

There is no move to find, so the correct answer and the cheapest request are the same one. This makes
Move Explanation's cost contract conditional, and ADR-0115's flat "exactly two searches" no longer
true:

| Request | Engine searches |
|---|---|
| Rejected (invalid FEN, illegal move, unsupported variant) | **0** |
| Accepted, move ends the game | **1** |
| Accepted, play continues | **2** |

All three are pinned by tests, because a cost claim nobody checks is a cost claim that drifts.

## What is NOT covered

- **No game-result redesign.** `Termination`, `ResultString` and the game aggregate are untouched;
  this reuses their vocabulary and adds no state.
- **`EngineResult` semantics are unchanged**, so anti-cheat and the bot mover see exactly what they
  saw before.
- **Repetition is still not adjudicated** from a FEN, and cannot be.
- **No capacity claim.** Skipping a search on decided positions reduces load by an unmeasured amount.
