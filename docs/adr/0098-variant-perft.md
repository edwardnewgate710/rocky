# ADR-0098 — Perft coverage for the chess variants

| Field      | Value                          |
|------------|--------------------------------|
| **Status** | Accepted                       |
| **Date**   | 2026-08-06                     |
| **Scope**  | `packages/chess-core`          |

---

## Context

Perft — counting leaf nodes of the move tree to a fixed depth — is the definitive correctness test
for a move generator. `packages/chess-core/test/perft.test.ts` had five cases, and every one ran the
`standard` variant.

`packages/chess-core/src/types.ts` declares eight variants, and
`packages/chess-core/src/movegen.ts` branches on the variant in six places — drops, castling
suppression, atomic explosion, king adjacency. Seven rule sets had no perft verification of any kind,
in a product whose stated promise to competitive players is that every move is validated.

Recorded under Milestone 1 in `docs/ROADMAP.md` as "perft suites for each variant".

## Decisions

### 1. No expected value may come from running this implementation

The obvious way to cover a variant is to run perft, record what it prints, and paste that in as
`expected`. That produces a **golden master**: it captures whatever the code does on the day it was
written, bugs included, and then passes forever regardless of correctness. In a diff it is
indistinguishable from a real perft suite, which is what makes it worth naming.

The five original cases are legitimate because their node counts are published reference values from
the Chess Programming Wiki, derived independently of this codebase. Every value added here traces to
one of two independent sources: those same published counts, or arithmetic over the board.

### 2. Variants whose move generation is unchanged are pinned by equality

`kingofthehill` and `threecheck` alter only the terminal condition in
`packages/chess-core/src/position.ts`, not move generation. `chess960` differs only in castling, and
the standard array is Chess960 start position 518, where castling is the standard arrangement.

So at depths where the variant's own terminal condition cannot fire, perft for all three must equal
the published standard counts **exactly** — `[20, 400, 8902, 197281]` from the opening position and
`[48, 2039, 97862]` from kiwipete. This is an invariant anchored to published numbers, not a
recording of behaviour.

The depth bound is part of the argument, not an arbitrary cutoff: within five plies of the opening
position a king cannot reach a central square and three checks cannot be delivered, so neither
variant can terminate early and truncate the count.

### 3. Equality alone is not enough, so divergence is pinned too

A suite asserting only that `atomic` matches `standard` would pass on an implementation that had
quietly failed to implement atomic at all. The variants that must differ are therefore asserted to
differ:

- **`atomic`** matches standard through depth 3, where no capture is available, and must **not**
  match at depth 4, where the first captures occur and remove both pieces.
- **`crazyhouse`** matches standard through depth 4 — white's earliest capture is ply 3, so black,
  to move on ply 4, still has an empty pocket — and with a pawn placed in hand via the bracket FEN
  form, `perft(1)` must be exactly **52**: the 20 ordinary moves plus one drop for each of the 32
  empty squares on ranks 3-6, rank 1 and rank 8 being the ranks a pawn may not be dropped on.

That 52 is arithmetic over the starting array, not a reading taken from the engine. An earlier
version of the same test compared `perft(5)` totals instead and asserted only `>`; it cost 12 seconds
of the package's 15-second suite and proved something weaker — that one number exceeded another,
without saying by how much or why. The pocket FEN gives an exact figure in milliseconds.

### 4. `horde` and `racingkings` coverage added from independent published vectors (M14 Increment 42 update)

`horde` and `racingkings` coverage has been added using the official `lichess-org/scalachess` perft resources as the source of truth:
- `https://raw.githubusercontent.com/lichess-org/scalachess/master/test-kit/src/test/resources/horde.perft`
- `https://raw.githubusercontent.com/lichess-org/scalachess/master/test-kit/src/test/resources/racingkings.perft`

Testing against these independent reference vectors surfaced two rule defects in `@chess-platform/core`:

1. **Horde pawn rules (`packages/chess-core/src/movegen.ts`)**:
   - White Horde pawns on ranks 1 and 2 (rank indices 0 and 1) are eligible for a two-square initial move. `generatePseudoLegal` previously checked `rankOf(from) === startRank` (where `startRank` is 1 for White), omitting double pushes for White pawns on rank index 0 (Rank 1).
   - `applyMove` set `epSquare` for all double pawn pushes including rank index 0; however, en-passant target squares are created only when double pushing from standard starting ranks (rank index 1 for White, rank index 6 for Black).
   - Allowing rank index 0 double pushes for White in Horde and restricting `epSquare` creation brought `horde-start`, `horde-open-flank`, and `horde-en-passant` into 100% agreement across all published depths 1..4.

2. **Racing Kings 8th rank terminal and turn logic (`packages/chess-core/src/position.ts`)**:
   - `racingKingsResult()` previously declared `wIn` (White king on 8th rank) an immediate White win regardless of turn. In Racing Kings, when White reaches rank 8, Black receives one final move on `turn === 'b'` to attempt to move Black's king to rank 8 to draw.
   - `racingKingsResult()` inspects `this.legalMoves()` for an authoritative legal king move reaching rank index 7 on Black's turn (`turn === 'b'`). If Black has a goal-reaching reply, the game remains ongoing; if Black cannot reach rank 8, White wins immediately. If Black reaches rank 8 on the next move, the game ends in `variant_draw`.
   - `perft()` and `perftDivide()` both stop at variant-terminal roots, so the aggregate count and root breakdown cannot disagree about a finished Racing Kings position.
   - Correcting this turn logic brought `racingkings-start`, `occupied-goal`, and `near-discovered-check` into 100% agreement across all published depths (`racingkings-start` depths 1..5 including `9472927`, `occupied-goal` 1..6, `near-discovered-check` 1..4). Published `racingkings-start` depth 5 (`9472927`) is verified and included in automated tests.

## Consequences

- All eight variants declared in `@chess-platform/core` now have perft verification.
- The chess-core suite grows from 24 tests to 35 tests (including focused Horde and Racing Kings behavioral regression tests).
- `horde` and `racingkings` move generation and terminal status logic are verified against independent published counts.

## Out of scope

- Chess960 castling-by-file FEN parsing, which this increment found to be **broken** and left for its
  own piece of work. `packages/chess-core/src/fen.ts` ignores file-letter castling rights: on
  kiwipete, rights of `HAha` yield `perft(1) = 46`, identical to no castling rights at all, against
  48 for `KQkq`. The comment there points at a "960 module" that does not exist in
  `packages/chess-core/src/`. Recorded in `docs/ROADMAP.md`.
