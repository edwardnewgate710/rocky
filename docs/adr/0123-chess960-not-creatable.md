# ADR-0123 — Chess960 is refused at game creation, not just hidden in the lobby

| Field      | Value                                                          |
|------------|----------------------------------------------------------------|
| **Status** | Superseded by [ADR-0137](0137-chess960-production-integration.md), which lifts the refusal by supplying what it was waiting for: a starting-position id chosen by the server and recorded on `GameCreated`. Four of the five restoration steps below were followed; **step 5 was not** — the seek-accept 409 is deliberately kept, because it guards a stored value the type system cannot reach, and ADR-0137 §6 argues that in full |
| **Date**   | 2026-08-21                                                     |
| **Scope**  | `packages/game`, `packages/api`                                 |
| **Amends** | [ADR-0099](0099-chess960-withheld.md), which deliberately left the server contract open |

---

## Context

ADR-0099 established that Chess960 is a name with nothing behind it. Re-verified on `2a55664`
before this increment, by running the code rather than reading it:

```text
standard : rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
chess960 : rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
IDENTICAL: true
```

`Position.initial('chess960')` returns the standard array, and `generateCastles` pins the king to
e1/e8 with rooks at fixed offsets, so the only Chess960 arrangement the engine can play is the one
that *is* ordinary chess.

ADR-0099 responded by removing the variant from the lobby's `OFFERED_VARIANTS` and said so plainly
in `packages/web/src/api/models.ts`: *"the API really does take `chess960`, and a client that could
not name it would be wrong about the contract."* That was a deliberate choice to fix the browser
and leave the server contract as it was.

**Why that is not sufficient.** `OFFERED_VARIANTS` is a list in the web bundle. It governs what a
button offers, not what the system permits. Everything else that speaks HTTP — a script, a bot
client, a mobile app, a curl command, a future front end — went straight past it. Three routes
reached `Game.create` with whatever variant they were handed:

| route | path to a game |
| --- | --- |
| `POST /v1/seeks` → `POST /v1/seeks/:id/accept` | the stored seek's variant |
| `POST /v1/games/bot` | the request body |
| `POST /v1/tournaments` | the tournament's variant, via `DurableGameLauncher.launch` |

And `Game.create` wrote a `GameCreated` event carrying `variant: 'chess960'` beside a **standard**
`initialFen`. That event store is append-only. The result is not a UI wart but a durable, unfixable
falsehood: a row asserting a rule set the position never used, indistinguishable afterwards from a
real Chess960 game — including to PGN export, ratings, and any future migration that trusts it.

## Decision

Refuse to create a Chess960 game. Do not remove the variant from anything that reads.

**The authoritative boundary is `Game.create`**, in `packages/game/src/game.ts`. It is the single
place a game is born; all three routes and the tournament launcher arrive there, and a fourth caller
added tomorrow inherits the rule rather than having to remember it. It throws `GameError` before any
event object is constructed.

**`CREATABLE_VARIANTS` in `packages/api/src/domain.ts`** carries the same rule at the HTTP edge, via
`parseCreatableVariant`, on exactly the three creation routes. This is not redundancy for its own
sake: `GameError` is mapped to no status, so without it a client sending `chess960` would receive a
500 for what is an ordinary validation failure. With it they get the 422 the rest of the API speaks,
naming the field and listing what is allowed.

The list is **written out**, not derived as `VARIANTS.filter(v => v !== 'chess960')` — the same
reasoning `OFFERED_VARIANTS` records. Subtracting from the contract list makes permitting creation
the default, so a variant added to `VARIANTS` tomorrow becomes creatable the moment it is named,
which is precisely how a variant with nothing behind it became playable in the first place.

**Seek acceptance re-checks the stored variant.** That value comes from a row, not a request, so
input validation cannot reach it: a `chess960` seek written before this decision is still in the
table. It answers 409 rather than 422, because the request is well formed — it is the seek that can
no longer be honoured.

### What does not change

`chess960` stays in `Variant`, in `VARIANTS`, in the `variants` lookup table, and in every **View**
schema (`SeekView`, `GameSummary`, `RatingView`, `TournamentView`, …). Reading, analysing, rating
and exporting an existing Chess960 position are all legitimate, and Stockfish supports the variant
even though this engine does not generate its positions. Only the three **Request** schemas
narrowed, and `packages/api/openapi.json` was regenerated so the published contract says so.

Studies are untouched. `POST /v1/studies` still accepts `chess960`; a study is a move tree, not a
`Game`, and narrowing it is a separate question with its own trade-offs.

## Consequences

- **A pre-existing Chess960 tournament will now fail to launch its games** rather than launch
  mislabelled ones. That is the correct direction — such a tournament cannot legitimately produce a
  Chess960 game — but *what to do with it* (cancel, convert, leave) is a product decision that
  depends on whether any exist. See below.
- **This is a contract narrowing**, and ADR-0099 chose not to make one. The balance changed because
  the cost was found to be durable data rather than a mislabelled session: the browser fix stopped
  new UI-originated games, and left every other client writing permanent falsehoods.
- **Existing rows were not touched.** No migration, no quarantine, no rewriting of history — an
  append-only store is not something to edit on a guess, and this repository has no access to
  production data. Nothing in the migrations or seeds creates a Chess960 *game*; the only seeded
  `chess960` is the `variants` lookup row, which is the enum and stays. The owner can establish
  whether any exist with:

  ```sql
  -- Games and seeks carry the variant as a column; `seeks` holds only open ones, since
  -- acceptance removes the row.
  SELECT count(*) FROM games  WHERE variant = 'chess960';
  SELECT count(*) FROM seeks  WHERE variant = 'chess960';
  SELECT count(*) FROM ratings WHERE variant = 'chess960';

  -- Tournaments have no variant column; it lives in the snapshot document.
  SELECT count(*) FROM tournaments WHERE snapshot ->> 'variant' = 'chess960';
  ```

  If all four are zero, this decision closes the hole with nothing left behind. If they are not,
  they mean different things and should not be read as one number:

  - **`games`** — the actual defect: rows asserting a rule set the position never used. What they
    should say instead is a separate increment.
  - **`seeks`** — open seeks that can no longer be accepted; they answer 409 and want cancelling.
  - **`tournaments`** — will now fail to launch their games rather than launch mislabelled ones.
  - **`ratings`** — *not* a defect. Chess960 ratings stay supported and readable; a row here only
    records what a player was rated at, and this decision does not touch it.

- **Full Chess960 remains unimplemented and out of scope**: 960-position generation, castling from
  arbitrary king and rook squares, Shredder/X-FEN in and out, the UCI king-takes-rook encoding, SAN,
  and perft against published values.

  When that lands, restoring the variant means all of:

  1. add `'chess960'` back to `CREATABLE_VARIANTS` in `packages/api/src/domain.ts`;
  2. remove the guard in `Game.create` (`packages/game/src/game.ts`);
  3. add it back to `OFFERED_VARIANTS` in `packages/web/src/api/models.ts` (ADR-0099 §2);
  4. **regenerate `packages/api/openapi.json`** — the three Request schemas derive their enum from
     `CREATABLE_VARIANTS`, so step 1 changes them automatically, but the committed document does not
     update itself and would otherwise keep publishing a contract that refuses the variant;
  5. drop the 409 from the seek-accept response map, which exists only for seeks stranded by this
     decision.

  `packages/game/test/chess960-creation.test.ts` asserts the premise — that the start position is
  still the standard one — so it fails and demands attention rather than silently passing.
