# ADR-0029 — Anti-Cheat Engine-Correlation Analysis

| Field      | Value                              |
|------------|------------------------------------|
| **Status** | Accepted                           |
| **Date**   | 2026-07-22                         |
| **Scope**  | `@chess-platform/anti-cheat` (M12) |

---

## Context

M12 introduces anti-cheat measures. This ADR covers the first increment: deterministic engine-correlation analysis. 
The analysis is a pure domain package (`@chess-platform/anti-cheat`) that evaluates played moves against engine recommendations. 
Evaluations arrive as DATA via a port (`PositionEvaluator`), keeping the domain hermetic (no real engine subprocesses).

**Crucially, this is a screening heuristic producing a *suspicion signal for human review*, never an automated verdict or ban.**
No single threshold can infallibly prove cheating. Strong human players (especially titled players) will frequently find the engine's top choice in forced lines, simple endgames, or deep opening preparation. 

## False-Positive Risks & Mitigations

1. **Opening Theory**: Book moves perfectly match engine moves.
   - *Mitigation*: The analyzer accepts an `isBook` flag per ply. Book plies are completely excluded from metric calculations.
2. **Forced Lines (Recaptures, Only-Moves)**: When only one reasonable move exists, a human will reliably play it.
   - *Mitigation*: Only-move exclusion. Plies where the evaluation gap between the #1 and #2 top moves is ≥ 200 centipawns are excluded from T1 and T3 match rates (but tracked in `onlyMoveExcluded`).
3. **Strong Players & Deep Calculation**: Grandmasters consistently play top engine moves in complex positions.
   - *Mitigation*: The output is strictly a `suspicion` band for review, not a conviction.
4. **Low Engine Depth**: Shallow engine evaluations might match human blunders or miss human brilliancies.
   - *Mitigation*: The analyzer enforces a `lowConfidence` flag when the provided evaluations are at a low depth (e.g., < 14), the ACPL sample size is small (e.g., < 20), or the T1/T3 denominator is thin (e.g., < 10 non-forced plies). The last guards against a spuriously high T1 computed from only a handful of eligible moves.
5. **Incomplete evaluations**: A `PositionEvaluator` may return an empty/terminal result, or top moves without the played move's own eval.
   - *Mitigation*: Such plies are counted as `unscored` and contribute to no metric — the analyzer never synthesizes a loss for a move it cannot see the eval of.

## Decision

We introduce `@chess-platform/anti-cheat` with the following deterministic metrics and thresholds.

### Per-player analysis (not per-game)

Engine-correlation must flag a **specific player**, so `analyzeGame` splits the
plies by side and returns a `GameCorrelationReport = { white, black }`, each a
full `PlayerCorrelationReport`. Every metric below is computed over one player's
plies only. *Justification: a cheater on one side would otherwise be diluted by
the opponent's human moves in a single blended score, which is the exact signal
we are trying to isolate.* Each `AnalyzedPly` carries the `player` who moved.

### Metrics Definition

- **ACPL (Average Centipawn Loss)**: The mean centipawn loss across the player's non-book, scored plies.
  - Calculated as `max(0, evalBestMove - evalPlayedMove)`, where `evalPlayedMove` is the played move's own eval (`playedCp`) supplied by the evaluator — never synthesized, so a move outside the top list still contributes its *true* loss.
  - Cap: **300 cp** per move. *Justification: A single massive blunder in an otherwise flawless game shouldn't skew the average to mask cheating.*
  - Mate encoding: **10000 cp**. *Justification: Ensures forced mates are highly valued but computationally bounded.*
- **T1 Match Rate**: Fraction of (non-book, non-only-move) plies where the played move exactly matches the engine's top choice.
- **T3 Match Rate**: Fraction of (non-book, non-only-move) plies where the played move is in the engine's top 3 choices.
- **onlyMoveExcluded**: Count of plies excluded from T1/T3 due to forced lines (gap between #1 and #2 ≥ 200 cp, or fewer than two candidates so no gap can be measured). *Justification: 200 cp is a standard threshold (a 2-pawn difference) indicating a clearly inferior alternative; a single-candidate position is likewise effectively forced.* These plies still count toward ACPL and `sampleSize`.
- **unscored**: Count of non-book plies the evaluator could not score (empty top moves, or top moves without a `playedCp`). Excluded from every metric.
- **lowConfidence**: A boolean flag set if `sampleSize < 20`, the T1/T3 denominator `< 10`, or `depth < 14`. *Justification: a tiny sample, a thin match-rate denominator, or shallow depth lacks statistical power to raise suspicions reliably.*

### Suspicion Bands

The analyzer produces a `suspicion` signal derived from fixed, deterministic thresholds:

- **`high`**: `T1 >= 0.70` AND `ACPL <= 15` AND NOT `lowConfidence`
  *Justification: Consistently matching the engine 70% of the time with near-perfect play outside of theory is extremely suspicious.*
- **`review`**: `T1 >= 0.55` AND `ACPL <= 25` AND NOT `lowConfidence`
  *Justification: Playing remarkably well but not impeccably warrants human oversight without sounding alarms.*
- **`clean`**: Everything else.

## Consequences

- The analyzer emits a pure per-player `GameCorrelationReport`. It will be up to a later increment to wire this into a background worker or moderation dashboard.
- The `PositionEvaluator` port must provide the top moves (with side-to-move relative centipawns) so the analyzer can independently calculate the gap for only-move exclusion, plus the played move's own eval (`playedCp`) so the raw ACPL is never synthesized. It receives the `playedUci` for exactly this reason.
