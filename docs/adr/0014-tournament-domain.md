# ADR-0014 — Tournament domain model and pairing port

| Field      | Value                              |
|------------|------------------------------------|
| **Status** | Accepted                           |
| **Date**   | 2026-07-16                         |
| **Scope**  | `@chess-platform/tournament` (M9)  |

---

## Context

M9 introduces tournaments (Arena / Swiss / round-robin). Following the project's
architecture — a dependency-free domain core with infrastructure behind ports —
the first increment establishes a self-contained tournament **domain package**
before any persistence, API, or realtime wiring. It must be deterministic and
fully unit-testable with `node --test`, with no I/O and no wall-clock reads.

Multiple pairing formats exist and differ substantially: round-robin has a fixed
up-front schedule; Swiss pairs each round from current scores while avoiding
rematches; Arena pairs continuously as players become available. The design must
let formats be added later without reworking the aggregate.

## Decision

New package `@chess-platform/tournament`, depending only on the dependency-free
domain packages `@chess-platform/core` (`Variant`) and `@chess-platform/game`
(`TimeControl`). Public pieces:

- **`Tournament` aggregate** — a pure, deterministic object with an explicit state
  machine `registration → running → finished`. `register`/`withdraw` are allowed
  only during registration; `start()` (rejects < 2 players) freezes the participant
  list, generates the schedule via the injected pairing strategy, indexes each
  pairing by a `roundIndex-pairingIndex` match id, and auto-records byes;
  `recordResult()` (running only) rejects unknown pairings and byes; the tournament
  flips to `finished` once every scheduled game has a result.
- **`PairingStrategy` port** — `generateRounds(participants): Round[]`. This is the
  seam that lets Swiss and Arena drop in later. A `Round` is a list of `Pairing`s,
  each either a `game` (with assigned white/black) or a `bye`.
- **`RoundRobinPairing`** — the only strategy in this increment. Circle-method /
  Berger-table scheduling: every player meets every other exactly once; even *N* →
  *N−1* rounds, odd *N* → *N* rounds with exactly one bye per player; colors are
  assigned so each player's white/black counts differ by at most one.
- **Scoring & standings** (`computeStandings`) — win = 1, draw = 0.5, loss = 0,
  bye = 1. Ordering is deterministic: points, then the **Sonneborn-Berger** tiebreak
  (sum of defeated opponents' final scores plus half of drawn opponents' final
  scores), then player id as a stable final tiebreak.

## Consequences

- The aggregate is pure and deterministic — no persistence, API, WebSocket, or web
  wiring in this increment. Those are explicit later M9 increments (durable
  tournament store, REST endpoints, live standings over the realtime channel).
- **Formats roadmap:** Swiss and Arena are follow-up increments implementing the
  same `PairingStrategy` port. The port currently returns the full schedule up
  front, which fits round-robin; Swiss/Arena, which pair round-by-round from live
  results, will likely need a richer per-round interface (given current standings +
  pairing history) — a deliberate, contained extension when those formats land.
- Sonneborn-Berger is the only tiebreak for now; a fuller tiebreak chain
  (direct encounter, Buchholz, wins) can be layered on without changing the model.
