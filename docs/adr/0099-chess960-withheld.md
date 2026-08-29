# ADR-0099 — Chess960 withheld from the lobby, and a variant audit

| Field      | Value                                      |
|------------|--------------------------------------------|
| **Status** | Superseded by [ADR-0137](0137-chess960-production-integration.md) — the withholding is lifted; the *reason* it was written out rather than derived still stands. Earlier: the server-contract half was amended by [ADR-0123](0123-chess960-not-creatable.md) |
| **Date**   | 2026-08-06                                 |
| **Scope**  | `packages/web`, `packages/chess-core` (findings only) |

---

## Context

`docs/ROADMAP.md` tracked "Chess960 castling-by-file" under Milestone 1 as a FEN-parsing detail.
Scoping it revealed something larger: **Chess960 is a label with no implementation behind it, and it
has been selectable in the lobby the whole time.**

Two independent gaps, each verified by running the code rather than by reading it:

**The start position is not shuffled.** `Position.initial('chess960')` returns
`rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR` — the standard array — on every call, and
`packages/game/src/game.ts:92` uses `Position.initial(variant).fen()` when no explicit FEN is
supplied, which is the matchmaking path. A Chess960 seek produces an ordinary chess game.

**Castling is hardcoded to the standard squares.** `generateCastles` in
`packages/chess-core/src/movegen.ts` sets `homeKing` to e1/e8 and returns immediately unless the king
is there, then looks for rooks at fixed offsets (`from + 3`, `from - 4`). Measured on legal Chess960
arrangements:

| position | castling moves generated |
|---|---|
| king e1, rooks a1/h1 (SP518 — standard) | 2 |
| king b1, rooks a1/h1 | **0** |
| king g1, rooks f1/h1 | **0** |

So castling works for exactly one of the 960 start positions, and that one is standard chess.

The FEN gap recorded in ADR-0098 is a symptom of the same thing: `packages/chess-core/src/fen.ts`
discards file-letter castling rights, so `HAha` on kiwipete yields `perft(1) = 46`, identical to no
rights at all, against 48 for `KQkq`.

## Decisions

### 1. Stop offering it before building it

Withholding costs one small change and stops players receiving a mislabelled standard game today.
Building it properly is a multi-part piece of work — 960-position generation, castling from arbitrary
king and rook squares, Shredder/X-FEN in and out, the UCI king-takes-rook encoding, SAN, and perft
against published values — and there is no reason for a broken option to stay on the board while that
happens.

The variant is **not** removed from the domain. `packages/chess-core` keeps `chess960` as a rule set
and the server enum keeps accepting it; what changes is what a player may pick.

### 2. Separate "what the contract accepts" from "what the lobby offers"

These were the same array, which is the structural reason a variant with nothing behind it stayed
selectable: there was no way to withhold one without lying about the contract.

`VARIANTS` in `packages/web/src/api/models.ts` continues to mirror the server enum exactly — a client
that could not name `chess960` would be wrong about what the API takes. `OFFERED_VARIANTS` is the
subset the lobby renders. `packages/web/test/create-game-prefs.test.ts` asserts both directions, so
quietly dropping `chess960` from the contract list would fail too.

**`OFFERED_VARIANTS` names what is offered rather than subtracting what is not.** The first version
of this change was `VARIANTS.filter(v => v !== 'chess960')`, and the test asserted "every contract
variant except `chess960` must be offered". That reproduces the very defect this ADR exists for: it
makes offering the default and withholding the exception, so a variant added to `VARIANTS` tomorrow
becomes selectable the moment it is named, and stays selectable unless someone remembers to write
another exclusion. Found in the PR review of #96.

The same reasoning as the allowlist in ADR-0094's projection test: an exhaustive statement of what is
permitted fails closed when something new appears; a list of exclusions fails open. Adding a variant
now requires a deliberate entry in `OFFERED_VARIANTS` **and** in the test's expected set, and the
test fails until both happen.

### 3. What the audit found in the other seven variants

Chess960 was the only hollow one. Each of the following was checked by running it:

| variant | start position | rules |
|---|---|---|
| `standard` | correct | perft-verified (ADR-0098) |
| `chess960` | **standard array, not shuffled** | **castling hardcoded to e1/a1/h1** |
| `kingofthehill` | correct | reaching a central square gives `variant_win` |
| `threecheck` | correct | three checks give `variant_win` |
| `atomic` | correct | diverges from standard at the first capture (ADR-0098) |
| `crazyhouse` | correct, with pocket | drops generated and pocket survives FEN (ADR-0098) |
| `horde` | own array | capturing every white pawn gives Black `variant_win` |
| `racingkings` | own array | reaching rank 8 wins; both kings arriving is a draw |

Two corrections to first impressions, recorded because the wrong version was believable:

- `racingkings` initially looked wrong, returning `variant_draw` where a win was expected. The test
  position had **both** kings on rank 8, which genuinely is a draw. The implementation was right.
- `threecheck` initially looked as though it never counted checks. It does; three checks end the game
  through `play()`. The measurement was taken through `snapshot()`, which is lossy — see below.

### 4. `Position.snapshot()` loses three-check state

`snapshot()` in `packages/chess-core/src/position.ts` is implemented as
`parseFen(this.fen(), variant)`, and `toFen` does not serialise `checkCount`. Anything that persists
or transports a three-check position through `snapshot()` silently resets both counters to zero.

This is latent rather than live: the only production uses of `Position.snapshot()` are
`repetitionKey(...)` calls in `packages/game/src/game.ts`, and a repetition key is built from the
first four FEN fields, where the check count plays no part. Live games rebuild state by replaying
their event log, not by restoring a snapshot.

Recorded rather than fixed. It is a real trap for the next feature that snapshots a position, and it
belongs with whatever work makes the FEN round-trip lossless.

> **Correction (2026-08-18, M15 Increment 8).** The paragraph above is wrong where it says the
> check count plays no part, and the conclusion drawn from it — "latent rather than live" — is
> wrong with it. `packages/chess-core/src/repetition.ts` had appended the delivered-check counters
> to the key for `threecheck` since 2026-07-13, three weeks before this ADR was written. Its
> summary docblock said the key was the first four FEN fields; its code appended the counters
> three lines further down, and this audit took the docblock at its word.
>
> The consequence was a live, player-visible wrong result. Because the key was built from the
> lossy snapshot, every three-check position reported `0+0`, so boards that repeated while the
> check counts climbed compared equal. `Re1+ Kf8 Rd1 Ke8 Re1+ Kf8 Rd1 Ke8` was declared a threefold
> draw with White two checks in and one from winning; it now correctly continues, and White wins
> `1-0` on the third check.
>
> Increment 8 fixed the fidelity of `Position.snapshot()`, which now clones the live state instead
> of round-tripping through FEN. The FEN round-trip remained lossy for three-check at that point,
> exactly as described above — that part of the finding stood, and making it lossless needed a wire
> format and an engine convention. Both were settled in M15 Increment 9
> ([ADR-0120](0120-threecheck-fen-and-engine-interop.md)): the FEN now carries the counters in the
> canonical Fairy-Stockfish field, and the paragraph above is fully resolved.

## Consequences

- The lobby offers seven variants. Every one of them does what its label says.
- `chess960` remains a valid value in the API contract and in `chess-core`; only the lobby withholds
  it. *(Amended by [ADR-0123](0123-chess960-not-creatable.md): the server now refuses to **create** a
  Chess960 game. Withholding it in the browser turned out to protect only browser users — every
  other client went on writing `variant: 'chess960'` beside a standard `initialFen` into an
  append-only event store. It remains a valid value everywhere that reads.)*
- Restoring it is one line in `OFFERED_VARIANTS`, and the test named in §2 says so. *(No longer one
  line: since [ADR-0123](0123-chess960-not-creatable.md) it also means `CREATABLE_VARIANTS` in
  `packages/api/src/domain.ts`, the guard in `Game.create`, regenerating `packages/api/openapi.json`
  so the published contract stops refusing the variant, and dropping the 409 from the seek-accept
  response map. The full list is in ADR-0123's consequences.)*

## Out of scope

- Implementing Chess960. Tracked in `docs/ROADMAP.md` with the scope named in §1.
- Making the FEN round-trip lossless for three-check (§4). *(Out of scope at the time; done in M15 Increment 9 — see the correction note in §4 and [ADR-0120](0120-threecheck-fen-and-engine-interop.md).)*
- `horde` and `racingkings` perft values, still pending published references (ADR-0098 §4).
