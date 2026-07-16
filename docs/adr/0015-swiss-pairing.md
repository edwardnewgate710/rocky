# ADR-0015 — Swiss pairing and round-by-round port evolution

| Field      | Value                              |
|------------|----------------------------------  |
| **Status** | Accepted                           |
| **Date**   | 2026-07-16                         |
| **Scope**  | `@chess-platform/tournament` (M9)  |

---

## Context

ADR-0014 established the tournament domain with a `PairingStrategy` port that
returns the full schedule up front (`generateRounds(participants): Round[]`).
This fits round-robin but cannot support Swiss: Swiss pairs each round from the
current standings and pairing history (players close in score, never a rematch),
so the schedule is unknowable before earlier rounds complete.

## Decision

### 1. Round-by-round pairing interface

The `PairingStrategy` port evolves to a single-round model:

```typescript
interface PairingStrategy {
  pairNextRound(context: PairingContext): Round | null;
}
```

`PairingContext` provides participants (in seed order), the 0-based next round
number, all completed rounds with their results, and per-player history
(opponents faced, white/black counts, byes received, current points). Returning
`null` signals that the tournament is complete (no further rounds).

**`RoundRobinPairing`** is adapted without changing its behavior: it lazily
pre-computes the full Berger schedule on the first call, then returns one round
per invocation. All existing schedule-correctness properties are preserved.

**`Tournament` aggregate** evolves from "generate all rounds on `start()`" to:
- `start()` generates only round 1 via `pairNextRound()`.
- When all games in the current round have results, `recordResult()` triggers
  auto-advance: it calls `pairNextRound()` to generate the next round. If the
  strategy returns `null`, the tournament flips to `finished`.
- `getRounds()` returns only the rounds generated so far (grows incrementally).

### 2. `TournamentConfig` discriminated union

`TournamentConfig` becomes `RoundRobinConfig | SwissConfig`, discriminated by
`format: 'round_robin' | 'swiss'`. `SwissConfig` adds a `rounds: number` field
(the configured number of Swiss rounds).

### 3. Swiss pairing — deterministic Monrad/Dutch-lite

**Scope:** A clean, deterministic Swiss pairing. Full FIDE Dutch system
compliance (with its intricate color-history backtracking) is explicitly deferred
as a later enhancement.

**Round 1:** If the field is odd, the lowest seed takes the bye first; the
remaining players are then split into equal seed-ordered halves and paired top
vs bottom (seed 1 vs seed ⌈N/2⌉+1, etc.). Higher seed gets white.

**Later rounds:** Sort players into score groups by current points (stable
tie-breaking by seed index), then find a **complete** pairing via a backtracking
search that tries the nearest-in-score partner first. This keeps players inside
adjacent score groups wherever possible while guaranteeing that every player is
paired — a plain top-down greedy pass can strand a player whose only remaining
in-score partners are all previous opponents, silently dropping them from the
round; the backtracking search avoids that. Hard constraint: no two players ever
meet twice. A node budget bounds the search on pathologically large fields.

**Byes:** If the player count is odd, the bye goes to the lowest-scored eligible
player who has not already received a bye. A bye scores 1 point. No player
receives more than one bye. Bye candidates are tried in preference order until
one leaves a remainder that can be completely paired.

**Color allocation (best-effort):** Track each player's white and black game
counts and give each player the color they are "due" (have played fewer of); on
a tie the higher seed gets white. Color balance is **best-effort, not a hard
guarantee**: `|white − black| ≤ 1` cannot always hold together with score-group
integrity — when two players who both just played the same color are the correct
score-group pairing, one of them must repeat, reaching `|white − black| = 2`.
Score-group correctness and the no-rematch constraint take priority over color;
full FIDE color-history backtracking is part of the deferred FIDE work.

**Termination:** The strategy returns `null` after the configured number of
rounds have been emitted, **or earlier** if the field is exhausted (no
rematch-free complete pairing exists, or an odd field has no player left who can
take a bye). Finishing early is preferred over emitting a malformed round.

**Determinism:** Given the same seed order and the same game results, the
strategy produces identical pairings in every run.

## Consequences

- The round-by-round interface is strictly more expressive than the old
  up-front interface: any strategy that can produce a full schedule (like
  round-robin) trivially adapts by caching and returning one round at a time.
- Swiss tournaments now run correctly with the aggregate's state machine.
- Arena pairing (a future format) will also fit naturally into `pairNextRound`.
- Full FIDE Dutch compliance (transpositions, exchanges, color-history
  backtracking) is explicitly deferred. The current Monrad/Dutch-lite is
  deterministic, always produces a complete round (never drops a player),
  avoids rematches, respects score groups, and balances colors best-effort —
  sufficient for all non-FIDE-rated events.
