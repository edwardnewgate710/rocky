# ADR-0136 — Chess960 core rules: 960 start positions, castling from arbitrary squares, X-FEN

| Field      | Value                                                                          |
|------------|--------------------------------------------------------------------------------|
| **Status** | Accepted                                                                       |
| **Date**   | 2026-08-28                                                                     |
| **Scope**  | `packages/chess-core`, and the refusal rationale in `packages/game`             |
| **Amends** | [ADR-0099](0099-chess960-withheld.md) §1 and §3, [ADR-0123](0123-chess960-not-creatable.md) — the rules half of both is now done; the creation refusal stands |

---

## Context

ADR-0099 and ADR-0123 both record the same finding: Chess960 was a name with nothing behind it.
Re-verified on `b1a0522` by running the code rather than reading it, before anything was changed:

```text
Position.initial('chess960') : rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
Position.initial('standard') : rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
IDENTICAL: true

castling moves generated, back ranks cleared to king + two rooks:
  king e1, rooks a1/h1 (SP518 — standard)  2
  king b1, rooks a1/h1                     0
  king g1, rooks f1/h1                     0
  king b1, rooks a1/c1                     0

kiwipete with castling field "KQkq" -> perft(1) = 48
kiwipete with castling field "HAha" -> perft(1) = 46, reserialised as "-"
kiwipete with castling field "-"    -> perft(1) = 46
```

Three separate defects, not one. The start position was never shuffled. `generateCastles` pinned the
king to e1/e8 and read rooks at `from + 3` and `from - 4`. And the FEN reader dropped Shredder-FEN
file letters on the floor — `HAha` parsed to *no rights at all*, which is not merely lossy on output:
it changed the legal moves and then re-serialised as `-`, destroying the rights permanently.

The third is the one worth pausing on. The old code carried the comment
`// Chess960 uses file letters (A-H/a-h); handled by the 960 module` above a `default: break`. There
was no 960 module. A reader checking whether Chess960 FEN was handled would have found a note saying
yes.

## Decisions

### 1. Starting positions: the Scharnagl numbering, generated, never drawn

`chess960BackRank(id)` in `packages/chess-core/src/chess960.ts` derives the back rank for id 0..959
by the standard Scharnagl construction — two bishops by remainder onto the light and dark files, the
queen onto the *n*-th remaining file, two knights from the ten five-slot combinations, then rook,
king, rook into what is left. It is derived, not tabulated: a 960-entry literal cannot be reviewed,
and a transcription error in it would be invisible.

Id 518 is the traditional array. That is not a convenience we chose but a property of the numbering,
and it is what lets Chess960 and standard chess agree exactly where they should.

**`Position.initial('chess960')` returns position 518 on every call, and the core never draws a
random one.** A rules engine that reached for entropy here would make every position it produced
unreproducible, and callers that legitimately want a *fixed* arrangement — tests, analysis, replaying
a stored game — would have no way to ask. Choosing among the 960 is a decision for whoever starts a
game; `Position.chess960(id)` is how they express it.

### 2. Castling rights name a rook, because a bitmask cannot

`PositionState.castling` changed type. It was a four-bit mask (`CastleRight`); it is now
`CastlingRights`, holding for each colour and side the **file of the rook that carries the right**,
or `-1`.

A mask works for standard chess only because the rook is implied — kingside means h, queenside means
a. Chess960 starts the rooks anywhere, so the implication fails, and a position with two rooks on the
same side of the king cannot be expressed at all. That is not hypothetical: it is reachable by
promotion in ordinary chess too.

**The mask was removed rather than kept alongside.** Storing both "does the right exist" and "which
rook holds it" is two facts that must agree, and nothing would have made them. The rook file alone
answers both questions — `-1` *is* the absence of the right — so there is no state in which they can
disagree. `CastleRight` had no consumer outside `packages/chess-core`, which is what made this
affordable; that was checked before the type was changed, not assumed.

### 3. FEN: read both spellings, write X-FEN

Two conventions are in circulation and a reader does not get to choose which arrives:

- **Shredder-FEN** names the rook's file outright (`HFhf`). Every published Chess960 perft corpus is
  written this way, so reading it is a hard requirement, not a nicety.
- **X-FEN** keeps `KQkq`, defining the right to belong to the **outermost** rook on that side of the
  king, and falls back to a file letter only when an inner rook holds it.

`parseCastlingField` accepts both. They cannot collide: file letters run a–h and `k`/`q` are outside
that range. Both are resolved against the board, because a right names a rook and only the board says
where the rooks are — and a right naming a rook that is not there is dropped rather than believed,
since move generation would otherwise be pointed at an empty square.

**Output is X-FEN.** This is the decision that keeps standard chess untouched: rooks on a and h are
always the outermost on their side, so every standard position — and every Chess960 *starting*
position, which has exactly one rook per side of the king — serialises to the ordinary `KQkq` that
the rest of the world reads. Shredder-FEN would have rewritten every standard FEN in the system as
`HAha`. A file letter appears only when it carries information `KQkq` cannot.

One consequence is worth stating because it looks like a bug and is not: **the spelling of a right
tracks the board while the right itself stays put.** A right held by an inner rook on f1 spells `F`
while a rook stands on h1, and spells `K` once that h1 rook moves away — the same right, still held
by f1, now correctly described. `chess960-fen.test.ts` pins this.

**X-FEN's other divergence is deliberately not adopted.** X-FEN also narrows the en-passant field to
squares where a capture is genuinely available. That would change the FEN of every variant including
standard, it is a separate question from castling, and this codec already normalises en passant where
it actually matters — in `repetitionKey`.

### 4. Move representation: `to` stays the king's destination; the wire speaks king-takes-rook

The UCI convention for Chess960, once `UCI_Chess960` is set, is that castling is sent as **king takes
rook** — `e1h1`, not `e1g1`. `packages/engine/src/plugin.ts` already sets that option for the variant,
so this is the contract the engine on the other end is speaking.

Internally, `Move.to` remains the king's final square in every variant, and a new optional
`Move.castleRook` carries the rook's origin. The engine spelling is applied at one place,
`Position.toUci`. Keeping `to` meaning one thing everywhere is what stops the convention leaking into
move generation and legality, where it would be a standing trap.

The convention exists because the king's destination is not always distinct. A king starting on g1
finishes on g1 when it castles kingside — `g1g1` names a move that appears to go nowhere — and a king
on f1 would emit `f1g1`, indistinguishable from stepping one square right. The rook's square is
always unambiguous, because the king starts strictly between the two rooks.

Both spellings are accepted on input, with the ordinary reading taking precedence: a king on f1 next
to a rook on g1 can both step to g1 and castle, and `f1g1` keeps the meaning it has in every other
variant. The castle stays reachable as `f1h1`.

**A defect this surfaced.** `Position.play(move)` matched a caller's move against the generated list
on `from`/`to`/promotion/drop alone. In Chess960 that is not enough: a king on b1 whose queenside
castle lands it on c1 can *also* simply step to c1, so asking to castle silently played the king one
square and left the rook behind — a legal-looking position that was not the one requested. Found by
the exhaustive castling test, not by review. `castleRook` is now part of the comparison.

### 5. Perft, from published values only

`packages/chess-core/test/fixtures/chess960-perft.csv` holds all 960 starting positions with node
counts to depth 4, taken from lichess-org/scalachess, which cites the Chess Programming Wiki's
Chess960 results and Ethereal's `fischer.epd`. That is the same provenance the horde and racingkings
vectors in `packages/chess-core/test/perft.test.ts` already use.

None of these numbers came from this engine. Recording what the implementation prints and calling it
`expected` is a golden master: it locks in today's bugs and passes forever.

Depth is split on cost. Every one of the 960 runs to depth 2, which is what proves no arrangement is
mis-generated; an evenly spaced sample of 32 runs to depth 4, which is where a castling-rights or
transit-safety error that survives two plies shows up. All 960 were additionally verified to depth 3
locally — 20,607,998 nodes, zero mismatches — but that costs ~28s per Node version and finds nothing
the sample does not.

## Consequences

- Chess960 is genuinely implemented at the rules layer. All 960 arrangements generate, castle, and
  match published node counts.
- Standard chess is unchanged, and this is checked rather than asserted: every pre-existing test in
  `packages/chess-core` passes untouched, including the published standard and variant perft suites.
- **Chess960 still cannot be created.** See below.
- `PositionState` gained a field and one changed type. `Position.snapshot()` must clone it, which
  `packages/chess-core/test/snapshot.test.ts` enforces by enumerating the state's fields.

## Phase B — what must exist before Chess960 can be created or offered

The refusal in `packages/game/src/game.ts` stays, and its reason has changed rather than gone away.
The engine can now play any arrangement, but nothing can *tell* it which one: no creation parameter,
no `GameCreated` field, and no client carries a starting-position id. A game created today could only
ever be position 518, recorded as `chess960` without anyone having chosen it — the same durable
falsehood ADR-0123 refused, arrived at from the opposite direction.

Before the variant becomes creatable, all of:

1. a starting-position id in the creation contract and on the `GameCreated` event, so the arrangement
   a game used is recorded rather than inferred — an append-only store cannot be corrected later;
2. a decision on who draws the id, and from what source of randomness, with the draw recorded;
3. `CREATABLE_VARIANTS` in `packages/api/src/domain.ts`, and the guard in `packages/game/src/game.ts`;
4. `packages/api/openapi.json` regenerated, since the three Request schemas derive their enum from
   `CREATABLE_VARIANTS` and the committed document does not update itself;
5. the 409 dropped from the seek-accept response map, which exists only for seeks stranded by
   ADR-0123;
6. `OFFERED_VARIANTS` in `packages/web/src/api/models.ts` (ADR-0099 §2);
7. board rendering and move input in the client for a non-standard back rank, including castling by
   king-takes-rook, which is how a Chess960 player expects to express it.

Items 3–7 are all outside this increment's scope by design: they are API, web and product decisions,
and none of them is safe to make while the rules are the thing under review.

## Out of scope

- Any change to API, web, OpenAPI, or the creation path. Deliberately untouched.
- Horde and racingkings perft values, still pending published references (ADR-0098 §4).
- X-FEN's narrower en-passant field (§3).
