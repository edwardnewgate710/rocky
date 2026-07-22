# ADR-0030 — Anti-Cheat Cross-Game Aggregation

| Field      | Value                              |
|------------|------------------------------------|
| **Status** | Accepted                           |
| **Date**   | 2026-07-22                         |
| **Scope**  | `@chess-platform/anti-cheat` (M12) |

---

## Context

Increment 1 (ADR-0029) produces a **per-player, per-game** engine-correlation
report (`PlayerCorrelationReport`). A single game is statistically weak evidence:
a strong human can match engine lines in one game through preparation or forced
sequences. Moderation needs an **account-level** signal that combines a player's
history into one screening result.

## Decision

We add a pure `aggregatePlayer(games)` function that combines the per-game
reports **for the side the account played in each game** into one
`PlayerAggregateReport`.

### Pool, never average

Averaging per-game rates is statistically unsound — it weights a 3-ply game the
same as a 60-ply game. Instead we POOL the raw counts, which Increment 1 now
exposes on every report (`t1Matches`, `t3Matches`, `tRateSampleCount`,
`rawCentipawnLossTotal`, `cappedCentipawnLossTotal`, `sampleSize`):

- `t1Rate` = Σ`t1Matches` ÷ Σ`tRateSampleCount` (pooled), likewise `t3Rate`.
- `acpl` / `acplCapped` = Σ loss ÷ Σ`sampleSize` (sample-weighted means).

### Per-player, not per-game

Aggregation consumes `PlayerCorrelationReport`, not the blended game report. The
caller selects the report for the side the account played in each game, so a
cheater is never diluted by an opponent's human moves — the same isolation
Increment 1 established, carried through to the account level.

### Aggregate confidence gate

The aggregate must clear its own gate before it can escalate:

- **`AGG_MIN_GAMES = 3`** — a single anomalous game can never flip an account.
- **`AGG_MIN_POOLED_TRATE = 40`** — the pooled T1/T3 denominator must be large
  enough for statistical power.

If either fails, the aggregate is forced to `clean` with `lowConfidence = true`.
Crucially, a set of *individually* low-confidence games (e.g. many short games)
**can** form a confident aggregate once pooled — that is the point of pooling —
but only if the pooled totals clear this gate.

### Suspicion bands

The `high`/`review`/`clean` bands reuse the **exact** numeric thresholds from
Increment 1, imported as shared constants (`SUSPICION_HIGH_T1_RATE`, etc.) so the
per-game and account-level bands can never silently diverge, applied to the
pooled rates.

### Duplicate rejection

`aggregatePlayer` throws on a repeated `gameId`. A retried or overlapping history
read must not double-count a game and thereby inflate the pooled denominators
(confidence) and correlation metrics.

## Consequences

- **Human review only.** The aggregate is a screening signal, never an automated
  ban. `flaggedGameIds` points reviewers at the specific games (per-game
  `review`/`high`) that warrant a closer look.
- **Pure domain.** `aggregatePlayer` is deterministic, dependency-free, with no
  I/O — wiring it into persistence, a worker, or a moderation dashboard is a
  later increment.
- **Shaped for correct pooling.** Increment 1's report gained the raw
  numerators/denominators; this is additive and does not change its existing
  fields or bands.
