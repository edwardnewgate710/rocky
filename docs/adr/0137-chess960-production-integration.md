# ADR-0137 — Chess960 production integration: the server draws the starting position and records it

| Field      | Value                                                                          |
|------------|--------------------------------------------------------------------------------|
| **Status** | Accepted                                                                       |
| **Date**   | 2026-08-29                                                                     |
| **Scope**  | `packages/game`, `packages/api`, `packages/realtime-gateway`, `packages/web`   |
| **Amends** | [ADR-0099](0099-chess960-withheld.md), [ADR-0123](0123-chess960-not-creatable.md) — both refusals are lifted; [ADR-0136](0136-chess960-core-rules.md) §"Phase B", which listed what had to exist first |

---

## Context

Three ADRs have now said the same thing from three directions: Chess960 was a name with nothing
behind it. ADR-0099 removed it from the lobby, ADR-0123 refused it at `Game.create` because
`OFFERED_VARIANTS` is a list in a JavaScript bundle and every other client walked straight past it,
and ADR-0136 implemented the rules — all 960 arrangements, castling from arbitrary king and rook
squares, Shredder-FEN and X-FEN, verified against published perft counts — and *kept the refusal*.

The reason it kept the refusal is the whole of this ADR's context. Re-verified on `1572e98` by
running the code rather than reading it:

```text
Game.create({ variant: 'chess960', ... })
  GameError: chess960 games cannot be created: the rules are implemented but there is no way yet
  to choose and record which of the 960 starting arrangements the game uses. See ADR-0136.

Position.initial('chess960') : rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
chess960Fen(0)               : bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1
chess960Fen(341)             : nrbbkqrn/pppppppp/8/8/8/8/PPPPPPPP/NRBBKQRN w KQkq - 0 1
```

The engine can play any arrangement. Nothing could *tell* it which one. A game created in that state
could only ever have been position 518 — the traditional array — recorded as `chess960` without
anyone having chosen it: the same durable falsehood ADR-0123 refused, arrived at from the opposite
direction.

## Decisions

### 1. The starting position is a recorded fact, and the record is the creation event

`GameCreatedEvent` gains an optional `chess960StartId: number`. `Game.create` requires it for
`chess960` and refuses it for every other variant.

**`initialFen` already pinned the position, so this field is not what makes replay work.** It never
was: `Game.reduce` has always rebuilt from `Position.fromFen(event.initialFen, event.variant)`, and a
Chess960 game would have replayed to the right board with no new field at all. What the id records is
the arrangement's **identity** — *which of the 960* — and that is a different fact, recoverable from
nowhere else the moment the first move is played. After 1.e4 the FEN describes the position, not the
start. "Position 348" is how Chess960 players name the game they are in, and a question about durable
history has to be answered from durable history.

**The id is required rather than defaulted.** Defaulting to 518 would make the traditional array the
silent answer to "which arrangement?" — the falsehood in its most plausible costume, because a real
game of position 518 and a caller that forgot to draw an id would be indistinguishable afterwards.

**`initialFen` is refused for Chess960.** The id already determines the position, and two ways to
state one fact is two facts that can disagree. Every other variant keeps `initialFen` untouched.

### 2. Optional and unversioned, because that is the smallest change that keeps every stored event decoding

Events are persisted as JSON payloads and normalised through `upcast(type, version, payload)`, which
passes rows at `CURRENT_EVENT_VERSION` through unchanged. A **new optional field** is therefore
readable by the existing decoder: no upcaster, no version bump, no migration. Bumping the version
would have required an upcaster for every event type to do nothing at all, and a migration system
invented for a change that does not need one is a cost paid forever.

Optional is also the honest shape. Seven of the eight variants have no starting-position id, and
`chess960StartId: null` on a Horde game would be a field asserting the absence of something that was
never applicable.

### 3. Replay validates the stored pair, and refuses rather than repairs

`Game.reduce` checks the creation event on **every replay**, not only at creation. That is the half
that matters: `Game.create` runs once, in a process that no longer exists by the time anyone asks what
the game started as, while `Game.fromEvents` runs on every reconnect, eviction and restart — reading
JSON written by some earlier version of this code. A creation-time check alone leaves the store's own
contents unchecked, and the append-only log is precisely the thing that cannot be corrected later.

Three ways an event can be wrong, all of which throw:

- an id on a non-Chess960 event — only Chess960 has one;
- an id that is not an integer in 0..959 — `-1`, `960` and `3.5` name no arrangement;
- an id that disagrees with `initialFen`, compared as exact string equality against `chess960Fen(id)`.

The third is the one that earns its keep. Both fields are stored, so both can be tampered with
independently, and a client that fabricated an initial state would surface here and nowhere else.

**A `chess960` event with no id is the one case that is not an error.** It predates the field. It
replays from `initialFen` exactly as it always did and reports `null` — genuinely unknown. It is never
filled in with 518, which would be a guess wearing the shape of a fact, and 518 is exactly the guess
that would look plausible on the mislabelled games ADR-0123 was worried about. Making such rows
undecodable was considered and rejected: it would break `GET /v1/games/:id`, PGN export and Game
Review for games that are readable today, to punish them for a defect they did not cause.

### 4. The server draws, at the moment a game certainly exists

`Chess960StartSelector` in `packages/api/src/ports/chess960.ts` is a port beside `Clock` and
`IdGenerator`, for the reason those are ports: the value is drawn once, written to an append-only log,
and never reproducible afterwards, so a test that cannot pin it can only assert that *something* was
chosen. `Position.chess960(id)` being deterministic (ADR-0136 §1) is what makes pinning it worth
anything — an injected id names an exact board.

The production implementation is `randomInt(960)` from `node:crypto`. Not `Math.random`: it is not
seeded from a cryptographic source, and a start position an opponent could predict before accepting a
seek is a small but real competitive edge in a variant whose entire difficulty is unfamiliarity.
`randomInt` also rejects the biased tail of the underlying range rather than taking a modulus, so all
960 arrangements are genuinely equally likely.

**The draw happens at seek *acceptance*, not seek creation.** A seek is an offer that may never be
taken up. Drawing at creation would mint a position for every abandoned seek and — the deciding half —
would publish it in `SeekView`, letting an opponent study the board before deciding whether to accept.

Exactly one id survives per game, including under concurrent acceptance, and not because of anything
added here: `seekAcceptor.accept` claims the seek row and writes the events in a single transaction,
so a loser's draw is discarded with the rest of its attempt. Two acceptors cannot produce two starts
for one game because they cannot produce one game between them.

### 5. The tournament launcher derives instead of drawing

`DurableGameLauncher` is the one creation path that must **not** use the selector, and getting this
wrong would have been invisible in every single-replica test.

Its design is that every API replica computes the same `gameId` from a SHA-256 of
`(tournamentId, matchId, attempt)` and races to append, with the losers accepting the winner's row:
`if (!(await this.events.exists(gameId))) throw error`. A random draw would mean each replica built a
*different* `GameCreated` for the same id — the store keeps one, and the others return success for a
game whose start position they never agreed on.

`launchChess960StartId` reads bytes 16..31 of the same digest (the half the game id does not use) as a
128-bit integer, modulo 960. Every replica therefore derives the *same arrangement*, so which one wins
the append stops mattering for the thing this ADR is about, and a crashed-and-relaunched pairing
resumes the arrangement it started with rather than a freshly shuffled one.

The events are not byte-identical, and it would be an overclaim to say so: `GameCreated.at` comes from
`this.clock.now()`, so racing replicas still stamp different creation times. That difference predates
this change and is harmless — only one event is ever persisted — but the guarantee added here is
specifically that the *starting position* cannot differ between them. Raised in the CodeRabbit review
of PR #12. The modulus biases towards low ids by at most 2⁻¹¹⁸ — a
quantity, not a hand-wave, and far below anything 960 buckets could express. The e2e harness's
`AuthorityGameLauncher` uses the same derivation for the same reason.

### 6. The refusals are replaced, not merely deleted

Following ADR-0123's own restoration checklist and ADR-0136 §"Phase B":

1. `'chess960'` is back in `CREATABLE_VARIANTS`;
2. the `Game.create` guard is replaced by the start-id contract rather than removed;
3. `'chess960'` is back in `OFFERED_VARIANTS`;
4. `packages/api/openapi.json` is regenerated — the three Request schemas derive their enum from
   `CREATABLE_VARIANTS`, and the committed document does not update itself;
5. the seek-accept **409 is kept**, against the checklist, with its reason rewritten.

Point 5 is a deliberate departure from both prior ADRs, so it needs its argument made rather than
asserted.

ADR-0123 added that guard for `chess960` seeks stranded by its refusal, and ADR-0136 listed removing
it among the steps to restoring the variant. The case for removal is real: with Chess960 creatable,
`CREATABLE_VARIANTS` and `VARIANTS` hold the same eight names, so for any value the enum can produce
the branch is dead — and ADR-0136 §6 records exactly what unreachable defensive code costs, since it
absorbs the mutation that should have failed a test and certifies coverage that does not exist.

**It was kept because the branch is not unreachable, and the reason it is not is this repository's own
finding.** `seek.variant` is typed `Variant`, but it is read from a database column, and
`scripts/check-variant-parity.mjs` exists precisely because *the type system does not span the SQL* —
that guard was written after a variant present in every TypeScript list and in the `variants` lookup
table, but missing from one `CHECK`, produced a green build and a production constraint violation. A
value this build cannot honour therefore arrives at seek acceptance as a well-typed string. Delete the
check and `Game.create` falls through to `Position.initial`, which returns the standard board for an
unrecognised variant, and writes a `GameCreated` carrying a variant nothing implements into an
append-only store. That is the durable falsehood ADR-0123 was written to prevent, reached by a
different door.

So the guard stays, and its comment now states the rule it actually enforces — a stored variant this
build cannot start — rather than the chess960 special case that motivated it. Removing it would have
been following a checklist past the point where its reasoning held.
`chess960-creation.test.ts` reaches it by writing a seek through the repository, which is the only way
such a row can exist now that the creation route refuses one.

**`CREATABLE_VARIANTS` and `OFFERED_VARIANTS` stay separate lists even though all three now agree,
and both stay written out rather than derived from `VARIANTS`.** They answer different questions —
what the enum can name, what may be created, what a player may pick — and deriving any of them makes
permission the default, so a variant added to `VARIANTS` tomorrow becomes creatable and selectable the
moment it is named. That is precisely how a variant with nothing behind it became playable. The lists
were last equal before that happened; re-deriving the distinction later is not the same as never
having lost it.

### 7. Public API: the realtime state view carries the id; the REST game summary does not

`StateView.chess960StartId` is on the wire. `GameSummaryView` is not changed.

The split follows what each surface is for. `GET /v1/games/:id` returns a summary — variant, result,
speed, ply count — and renders no board; a client reading it has no use for the arrangement. The
realtime snapshot is what the game screen renders, and it is the surface that cannot derive the id:
`fen` is the *current* position, so after the first move nothing on the wire says which of the 960 the
game began as.

The deciding argument against also adding it to the summary is that `StateView` is folded from the
creation event on every send, so it cannot drift from the log that owns the fact. A `games` table
column would be a second copy that could — and this codebase has repeatedly reasoned that two fields
which must agree are two fields that can disagree (ADR-0136 §2 removed a castling bitmask for exactly
this reason). Durable history keeps the authoritative identity either way.

**The client is never given the id as a way to build a board.** It renders `fen` and nothing else, so
a browser that disagreed with the server about what position 700 looks like would still show the
server's board. The id is displayed, beside the variant, and otherwise unused.

### 8. The browser needed no Chess960 knowledge, which is a finding rather than a plan

The expectation going in was that Chess960 castling input would be the hard part of Phase B: the
UCI boundary spells a castle king-takes-rook (`d1a1`, not `d1c1`), and the obvious way to build that
in a client is a special case.

None was needed, and the reason is worth recording because it is load-bearing rather than lucky.
`BoardInteraction` contains no chess rules: it asks a `LegalMoveOracle` for a square's destinations
and returns whichever the user picked. The oracle is fed the server's `legalMoves` map, which
`GameAuthority` builds with `position.toUci(move)` — already the king-takes-rook spelling in Chess960
and already `e1g1` in standard chess. So selecting the king highlights the rook's square, and tapping
or dragging onto it submits `d1a1`.

The one line this rests on is in `BoardInteraction.attempt`: a tap on a square holding one of your own
pieces reselects it *unless* it is a legal target, and legality is checked first. A rook is one of your
own pieces. Reorder those two branches and Chess960 castling breaks while every ordinary move keeps
working — which is why `chess960-board.test.ts` pins both branches rather than only the castle.

The `d1a1` / `d1c1` collision is the case that proves the client is not quietly resolving castles by
king destination: both moves put the king on c1, and only the rook-square spelling tells them apart.

## Consequences

- **Chess960 is creatable, seekable, acceptable, playable, reconnectable and replayable**, through
  seek acceptance, the bot route and tournaments.
- **Chess960 games are rated.** Ratings for the variant were always supported and readable
  (ADR-0123); they now have games to move.
- **The leaderboard offers Chess960**, because its variant selector renders `OFFERED_VARIANTS`. That
  is a consequence rather than a separate decision, and the right one: the ratings are real now.
- **A pre-existing Chess960 tournament will now launch its games** rather than fail. It launches
  genuine Chess960 games, which is what it always claimed to be.
- **Legacy `chess960` rows, if any exist, still read.** They report an unknown start id. The queries
  in ADR-0123 §Consequences still identify them; nothing here rewrites history.

### 9. Enabling the variant changed what every game *replayer* must know

The part of this increment that was not on anyone's checklist, and the one worth recording.

`Position.initial(variant)` was a safe way to start replaying a stored game for as long as no game
could start anywhere else. Making Chess960 creatable retired that guarantee everywhere at once, and
the compiler could not say so: the call sites still type-check, they just describe a different game.

Anti-cheat was where it bit. `EventStoreGameSource` folded the whole event history — so it *had* the
starting position — and returned only `moves` and `variant`; `extractPlies` then replayed from
`Position.initial(variant)`, which is position 518. A Chess960 game from any other arrangement would
either throw on the first move that is illegal there or, worse, silently produce evaluations for
positions nobody played and attribute them to a player. Found in the Qodo review of PR #12, not by me.

The fix carries `initialFen` through the source and makes `extractPlies` **require** the start
position rather than defaulting it. Defaulting is what left the trap, and a default that is right for
seven variants and wrong for the eighth is worse than no default, because it reads as considered.

Every other `Position.initial(` call site was then swept:

- **Bot detection** reads only `by` and `moveTimeMs` and never reconstructs a board — unaffected.
- **The opening explorer** is gated to `standard` (`OPENING_EXPLORER_VARIANT`), so it refuses Chess960
  before reading a position and is correct either way. Its `initialFen` field carried a comment
  justifying itself with "every game this deployment can create starts from `Position.initial(variant)`
  — no creation route accepts an `initialFen`", which this ADR made false. The comment is rewritten:
  the gate, not that claim, is what keeps the feature honest, and the field is what would have to
  become required if the gate ever widened.
- **`fen-validator.ts`** uses it to compare *piece placement shape*, not to replay a game.

The general lesson is the one ADR-0123 keeps restating from a different angle: a variant is not only a
rule set, it is a set of assumptions other code has already made about it. Turning one on means going
to find them.

## Out of scope

Genuinely deferred, not required for correctness:

- **Player-chosen starting positions.** The server draws; there is no product case yet for letting a
  player name an arrangement, and exposing one would need its own thinking about fairness in rated
  play.
- **Showing the arrangement in the REST game summary, PGN export headers, or the game list.** PGN has
  a conventional `Variant`/`SetUp`/`FEN` triple for this; wiring it is a separate increment with its
  own export-compatibility questions.
- **Chess960-aware opening classification and analysis caching.** Both key off standard openings and
  are unaffected rather than extended.
