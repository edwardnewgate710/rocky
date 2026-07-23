# ADR-0037 — Anti-Cheat Bot Detection Cross-Game Aggregation

| Field      | Value                           |
|------------|---------------------------------|
| **Status** | Accepted                        |
| **Date**   | 2026-07-23                      |
| **Scope**  | `@chess-platform/anti-cheat` (M12) |

---

## Context

Increment 1 (ADR-0036) introduced per-game behavioral move-time timing analysis (`analyzeBotBehavior`). However, a single game is statistically weak evidence for account-level decisions: short games or isolated blitz scrambles may exhibit fast or uniform move times without indicating automated bot usage across a player's history. Moderation needs an account-level screening signal combining multiple games into a unified behavioral aggregate.

## Decision

We introduce account-level cross-game aggregation for the behavioral move-time signal via a pure, dependency-free `aggregateBotBehavior` function in `@chess-platform/anti-cheat`.

### 1. Pool Raw Moments, Never Average Per-Game Rates

Averaging per-game means, standard deviations, or instant-reply rates is statistically unsound because it weights short games equally with long ones. Instead, we pool raw sample moments across all games:

- `BotBehaviorReport` is extended with raw poolable numerators `sumMs` ($\Sigma \text{ms}$) and `sumSqMs` ($\Sigma \text{ms}^2$).
- `pooledMeanMs` = $\Sigma \text{sumMs} \div \Sigma \text{sampleSize}$.
- `pooledVariance` = $\max(0, \Sigma \text{sumSqMs} \div \Sigma \text{sampleSize} - \text{pooledMeanMs}^2)$.
- `pooledStdevMs` = $\sqrt{\text{pooledVariance}}$.
- `pooledCoefficientOfVariation` = $\text{pooledStdevMs} \div \text{pooledMeanMs}$ ($0$ when mean is $0$).
- `pooledInstantFraction` = $\Sigma \text{instantMoves} \div \Sigma \text{sampleSize}$.

### 2. Confidence Gate

The aggregate must clear its own confidence gate before escalating suspicion:

- **`BOT_AGG_MIN_GAMES = 3`**: An account cannot escalate suspicion with fewer than 3 analyzed games.
- **`BOT_AGG_MIN_POOLED_SAMPLE = 40`**: The total pooled move count ($\Sigma \text{sampleSize}$) across all games must reach 40 moves.

If either condition fails, `lowConfidence` is `true` and `suspicion` remains forced to `clean`.

### 3. Shared Banding Helper (`behaviorSuspicion`)

To guarantee per-game (`analyzeBotBehavior`) and account-level (`aggregateBotBehavior`) suspicion bands never diverge, the two-band severity mapping logic is extracted into a shared exported pure helper `behaviorSuspicion(coefficientOfVariation, instantFraction)`. The suspicion band takes the more severe of the CV band ($\le 0.25 \rightarrow \text{high}$, $\le 0.50 \rightarrow \text{review}$) and the near-instant band ($\ge 0.90 \rightarrow \text{high}$, $\ge 0.70 \rightarrow \text{review}$).

### 4. Duplicate Rejection

`aggregateBotBehavior` throws an `Error` on duplicate `gameId`s. This prevents retried or overlapping history fetches from double-counting games and artificially inflating sample size or confidence metrics.

### 5. Human Moderation Screening & Deferrals

- **Human Review Only:** Per ARCHITECTURE §7, aggregate behavioral signals serve strictly for human reviewer queues and never trigger automated bans. `flaggedGameIds` surfaces games with individual `review` or `high` suspicion for drill-down.
- **Deferrals:** Real-time timing extraction from clock events/game history, persistence in Postgres, moderation REST API endpoints, and auto-triggering workers are deferred to subsequent increments.

## Consequences

- **Statistically Sound Aggregation:** Account-level move-time signals pool raw timing moments across games without weighting short games disproportionately.
- **Shared Thresholds:** One shared helper prevents drift between per-game and aggregate suspicion thresholds.
- **Pure Seams:** Remains a pure, zero-dependency domain module ready to be composed into storage, API, or worker pipelines.
