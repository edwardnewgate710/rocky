# ADR-0038 — Anti-Cheat Bot Detection Move-Timing Extraction

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-23                      |
| **Scope**  | `@chess-platform/anti-cheat` (M12) |

---

## Context

Increment 1 (ADR-0036) introduced per-game behavioral move-time timing analysis (`analyzeBotBehavior`), and Increment 2 (ADR-0037) introduced cross-game behavioral aggregation (`aggregateBotBehavior`). However, game event streams record move timings chronologically intermixed between both players (`MovePlayedEvent` with `moveTimeMs` and `by: Color`).

To feed the single-player `analyzeBotBehavior(moves: TimedMove[])` function without coupling the pure domain package to game event schemas or platform event stores, we need a pure, decoupled extraction bridge that projects a game's ordered move timings into per-player `TimedMove[]` arrays (white and black).

## Decision

We introduce `extractTimedMoves` in `@chess-platform/anti-cheat` (`src/bot-extract.ts`) as a pure, deterministic domain bridge mirroring the `extractPlies` pattern from engine correlation.

### 1. Minimal Decoupled Projection (`MoveTiming`)

`extractTimedMoves` accepts a minimal, decoupled `MoveTiming` interface rather than depending on `@chess-platform/game` or event objects:

```ts
export interface MoveTiming {
  readonly by: Color;
  readonly moveTimeMs: number;
}
```

Caller services map real game events (e.g. `MovePlayedEvent`) to `{ by: ev.by, moveTimeMs: ev.moveTimeMs }`.

### 2. Pre-Computed Clock Timings

`MovePlayedEvent.moveTimeMs` is already calculated by the game clock (wall-clock milliseconds spent by the mover). `extractTimedMoves` passes `moveTimeMs` directly into `TimedMove.ms` without requiring timestamp-delta math or clock state tracking.

### 3. Pure Splitting and Book Marking

- `extractTimedMoves(moves, isBook)` iterates `moves` with game index `i`.
- Each move is converted to `TimedMove` (`{ ms: moves[i].moveTimeMs, ...(isBook(i) ? { isBook: true } : {}) }`).
- Moves are routed to `white` when `by === 'w'` and to `black` when `by === 'b'`.
- Trusting the domain contract, `moveTimeMs >= 0` is accepted as-is (no clamping).
- Returns `{ white, black }` as `GameTimings`.

### 4. Opening-Book Seam

An optional `isBook: (moveIndex: number) => boolean` predicate enables callers to flag opening-book plies by 0-based game move index, so `analyzeBotBehavior` excludes them from timing statistics.

### 5. Scope & Deferrals

- **Pure Domain Boundary:** `extractTimedMoves` is pure, deterministic, and dependency-free.
- **Deferrals:** Real opening-book detection providers, an application service composing game loading with extract -> analyze -> aggregate, persistence, moderation REST API endpoints, and automatic triggering workers are deferred to subsequent increments.

## Consequences

- **Purity & Isolation:** `@chess-platform/anti-cheat` remains completely dependency-free without importing `@chess-platform/game`.
- **Symmetrical Seam:** Move-timing extraction mirrors the established `extractPlies` pattern for engine correlation, creating a predictable domain architecture across anti-cheat analyzers.
- **Composable Pipeline:** Enables clean composition: `load -> extractTimedMoves -> analyzeBotBehavior -> aggregateBotBehavior`.
