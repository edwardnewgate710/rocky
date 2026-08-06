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

### 4. `horde` and `racingkings` are deliberately left uncovered

Both have their own start positions and genuinely different rules, so neither the standard reference
counts nor the equality invariant applies, and no published perft values for them were available to
verify against. Writing plausible-looking numbers would be fabrication, and a fabricated reference is
worse than an absent one: it reports verification that never happened.

The remaining work is sourcing published values from an independent implementation. Tracked in
`docs/ROADMAP.md`.

## Consequences

- Six of eight variants now have perft coverage; the chess-core suite goes from 16 tests to 24 and
  runs in about 2.4 seconds.
- A change that made `kingofthehill` diverge from standard move generation, or that dropped
  crazyhouse drops, now fails a test. Both were verified by mutation rather than assumed.
- `horde` and `racingkings` movegen remains unverified, and the ROADMAP says so.

## Out of scope

- Chess960 castling-by-file FEN parsing, which this increment found to be **broken** and left for its
  own piece of work. `packages/chess-core/src/fen.ts` ignores file-letter castling rights: on
  kiwipete, rights of `HAha` yield `perft(1) = 46`, identical to no castling rights at all, against
  48 for `KQkq`. The comment there points at a "960 module" that does not exist in
  `packages/chess-core/src/`. Recorded in `docs/ROADMAP.md`.
- Any change to move generation. This increment adds tests only.
