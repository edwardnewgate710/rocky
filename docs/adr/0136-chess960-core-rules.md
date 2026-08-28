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

**Input is read the same way it is written: in Chess960, king-takes-rook is the only spelling of a
castle.** The king-destination form is refused there, and refused deliberately. It is not merely a
redundant second way to say the same thing — for a king that already stands on its own destination it
degenerates to `g1g1`, a move that appears to go nowhere, and for a king on f1 it collides with the
ordinary one-square step. Accepting it would mean `Position.play` tolerating strings no engine or GUI
produces, in the one place whose job is to refuse illegal moves. Raised in the CodeRabbit review of
PR #10.

Ordinary moves are unaffected, including ones that happen to land on a castling destination: a king
stepping f1→g1 is not a castle, was never resolved through the rook, and keeps the meaning it has in
every other variant. Standard chess likewise keeps `e1g1` and refuses `e1h1` — the mirror image of
the same boundary.

**A defect this surfaced.** `Position.play(move)` matched a caller's move against the generated list
on `from`/`to`/promotion/drop alone. In Chess960 that is not enough: a king on b1 whose queenside
castle lands it on c1 can *also* simply step to c1, so asking to castle silently played the king one
square and left the rook behind — a legal-looking position that was not the one requested. Found by
the exhaustive castling test, not by review.

Whatever the caller supplies is now applied as a constraint, and the constraints are **cumulative**:
`castleRook` must match when given, a castling flag must match when given, and when neither is given
the first match wins as before.

Two earlier versions were wrong in opposite directions, which is why the final shape is worth stating
precisely. Requiring `castleRook` unconditionally silently narrowed the public API —
`play({ from: e1, to: g1, piece: 'K', flags: KingCastle })` is an ordinary way to express standard
castling and began throwing. Treating the two as *alternatives* then accepted contradictory input: a
move naming the queenside rook while carrying `KingCastle` resolved to the queenside castle and
played it, so a caller that had confused itself received a different move instead of an error. Both
were raised in review of PR #10, the second by Qodo.

The through-line is the same as §7: a fix for one variant may not cost the others their existing
contract, and being permissive is not the same as being correct.

### 5. Perft, from published values only

`packages/chess-core/test/fixtures/chess960-perft.csv` holds all 960 starting positions with node
counts to depth 4, taken from lichess-org/scalachess, which cites the Chess Programming Wiki's
Chess960 results and Ethereal's `fischer.epd`. That is the same provenance the horde and racingkings
vectors in `packages/chess-core/test/perft.test.ts` already use.

None of these numbers came from this engine. Recording what the implementation prints and calling it
`expected` is a golden master: it locks in today's bugs and passes forever.

Depth is split on cost. Every one of the 960 runs to depth 2, which is what catches an arrangement
whose moves are generated wrongly; an evenly spaced sample of 32 runs to depth 4, which is where a
castling-rights or transit-safety error that survives two plies shows up. All 960 were additionally
verified to depth 3 locally — 20,607,998 nodes, zero mismatches — but that costs ~28s per Node
version and finds nothing the sample does not.

These vectors are read with `Position.fromFen`, so they cover FEN parsing, move generation and
castling across 960 distinct arrangements — **not** the starting-position generator. A defect in
`chess960BackRank` for some id would leave the whole perft suite green. That guarantee belongs to
`packages/chess-core/test/chess960-positions.test.ts`, which enumerates all 960 ids and checks the
arrangements themselves. Neither suite substitutes for the other, and saying otherwise would be
exactly the sort of overclaim ADR-0079 warns about.

### 6. The suite was checked by breaking the code on purpose

A passing suite proves the tests run, not that they would notice. **47 deliberate defects were
injected one at a time, and all 47 were caught** — bishops onto same-coloured squares, the knight
table shifted, castling destinations moved a file, the outermost-rook rule inverted on each side
independently, the king's transit path shortened, the rook's origin left occupied, each castling
right kept alive past the event that should end it, the king-takes-rook spelling applied to standard
chess. The harness proves each mutation actually landed before trusting the result, because sources
here are CRLF while anchors are written with `\n`, and a substitution that silently fails to apply
reports a cheerful false "caught".

The set grew as the code did: 39 for the rules themselves, then more for the variant gates in §7, the
move-matching rules in §4, and the Horde and Racing Kings guards in §8 — all added during review of
PR #10. **The
denominator counts injected mutations only.** The equivalent mutant described at the end of this
section is not among them — it was identified as equivalent and removed from the set rather than
injected and excused, so it neither inflates the numerator nor shrinks the denominator.

The last of those found a live gap rather than confirming coverage, which is the point of running it
again after every change: the flag-only tie-break was first tested on standard castling, where
`e1`→`g1` is two squares and no ordinary king move competes, so *any* tie-break would have appeared
to work. It is now tested where the two genuinely collide.

Three things it found that review had not:

- **`Position.play(move)` matched on `from`/`to` alone.** Covered in §4.
- **Two guards were unreachable and one was redundant.** A second `RangeError` on the knight lookup
  stood in for the id range check, so loosening the real bound changed nothing; and an explicit
  "cannot castle out of check" return restated what the king's transit walk already covers. Both
  were removed. Unreachable defensive code is worse than none: it absorbs the mutation that should
  have failed a test, and so certifies coverage that does not exist.
- **A test that could not distinguish the parser from its own bug.** The absent-rook case was written
  as `BA`, where the valid `A` overwrites the queenside slot and the field prints `Q` whether or not
  `B` was believed. It now asserts `B` alone.

One mutation is recorded as deliberately not chased: swapping the order of the two `resolveUci`
passes. The king-takes-rook pass only ever matches a square holding the mover's own rook, and no
ordinary move can land there, so the passes are disjoint and either order gives the same answer.
That is an equivalent mutant, and writing a test for it would mean staging a collision that cannot
occur.

### 7. The generalisation applies to Chess960 only

Rewriting `generateCastles` to read the rook from the rights, rather than from a fixed offset, made
it correct for Chess960 and briefly wrong for everything else: it accepted **any** king on its back
rank, in every variant. A standard position with a king on d1 and a rook on h1 generated `d1g1` — a
legal Chess960 castle and an illegal standard one. The same slip let `Position.play('e1h1')` be
accepted in standard chess, where UCI spells castling `e1g1` and nothing else.

Both were caught in review of PR #10, and both are now gated on the variant: outside Chess960 the
king must stand on its e-file home square and the rook on a or h, and the king-takes-rook input
spelling is refused. The traditional squares are a **rule** in ordinary chess, not a coincidence of
the starting array, and generalising them away is the exact failure mode this increment had to avoid.

That is worth recording rather than quietly fixing, because the regression was invisible to the
obvious tests: every published standard perft position has its king on e1, so the whole standard
suite stayed green while non-e-file castling was legal.

### 8. Horde: Black is an ordinary army, and now castles

`generateCastles` returned early for the whole `horde` variant, which suppressed castling for
**Black** as well — an ordinary army with a king, which `HORDE_FEN` starts with `kq` rights. The
engine was handing out rights it then refused to honour. Raised in the CodeRabbit review of PR #10,
and confirmed pre-existing rather than caused here: `main` generates no Horde castles either.

This was initially deferred as out of scope, on the grounds that Horde is a variant this increment
undertook not to change and that no published vector could evidence a fix. The first is true and the
second is the interesting part — but neither survives contact with what the defect actually is. The
guard is not a rule about Horde; it is a rule about *kings*, applied to a variant where only one side
has one. Leaving it meant leaving the code asserting something false about the position it ships.

**The evidence is the rule, and a relationship — not a node count.** No published Horde perft vector
can settle it: all three start with Black's back rank full, so no castle is reachable at any depth
they cover. What settles it instead:

- Lichess states the Horde rule as "a move is legal if and only if it is legal in standard chess for
  a similar position", with an exception only for The Pawns. Castling is not among the exceptions.
- `HORDE_FEN` in this repository, and the identical starting FEN in python-chess's `HordeBoard`,
  both grant `kq` and apply no castling override to Black.
- Horde changes White's pawns and the win conditions, and nothing about how Black moves. So for any
  board with Black to move, **Black's legal moves under `horde` must be exactly those under
  `standard`** — a relationship no fixed output can satisfy, and the form the other variant tests in
  `packages/chess-core/test/perft.test.ts` already take.

Excluding White was also unnecessary as well as insufficient: White has no king, and `generateCastles`
is only ever reached from the king branch of `generatePseudoLegal`. The guard now names Racing Kings
alone, which is the variant that genuinely forbids castling.

All three published Horde perft vectors are unchanged by this, which is the regression check: their
counts depend on Black's back rank being full, so a change that altered them would mean the fix had
reached further than castling.

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
