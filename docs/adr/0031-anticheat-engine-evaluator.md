# ADR 0031: Anti-Cheat Engine Evaluator Adapter

| Status | Date | Scope |
|---|---|---|
| Accepted | 2026-07-23 | `@chess-platform/anti-cheat` |

## Context

Increments 1 and 2 established a hermetic, pure-domain anti-cheat analyzer that evaluates games using deterministic mocks. To make the anti-cheat system usable in production on real stored games, we need an adapter that bridges the `PositionEvaluator` port to the actual `@chess-platform/engine` and `@chess-platform/core` packages. This bridge must extract plies from an ordered list of UCI moves and map engine results to the analyzer's centipawn scale.

## Decision

We will implement a production evaluator (`EngineBackedEvaluator`) and a game-to-plies extractor (`extractPlies`) inside `@chess-platform/anti-cheat`, strictly isolated from the root exports.

1. **Subpath Boundary for Purity**: 
   The main `@chess-platform/anti-cheat` package root (`src/index.ts`) remains strictly dependency-free. The new adapter code is placed in `src/engine.ts` and exported explicitly via the `"./engine"` subpath in `package.json`'s `exports`. This mirrors our existing conventions (like `/pg` for Postgres adapters) and ensures the core domain logic stays completely decoupled from engine or core packages.

2. **Negating the Resulting Position (`playedCp`)**:
   The engine provides evaluations for the top N moves. If the player makes a move outside this set, the analyzer needs to know the exact evaluation of that played move without synthesizing or guessing a loss. We achieve this by:
   - Playing the move on a `Position` to get the resulting position.
   - Analyzing the resulting position at `multiPv: 1`.
   - Negating the resulting evaluation. Since the side to move flips after a move is made, the evaluation of the resulting position (relative to the *opponent*) must be negated to accurately reflect the move's value for the *mover*.

3. **Checkmate Encoding**:
   If playing a move directly results in a terminal state (checkmate or draw), we immediately map it without calling the engine. A delivered checkmate receives `+MATE_ENCODING`, and a draw receives `0`. For non-terminal mates found during analysis, the evaluator converts the moves-to-mate magnitude to a scale clamped within `[0, MATE_ENCODING]`, ensuring mates are correctly priced as massive advantages.

4. **Unscorable Pass-Through**:
   If the original position is terminal (no legal moves), or if the engine unexpectedly returns zero usable lines, the evaluator gracefully returns an empty `topMoves` array. The pure domain logic inherently treats this as unscorable, bypassing any false loss accumulation.

## Consequences

- **Hermetic Domain Maintained**: The core engine-correlation logic continues to function without pulling heavy dependencies into unrelated contexts. Downstream consumers can decide whether to import the pure domain or the engine-backed adapter.
- **Accurate Sub-Optimal Valuations**: Negating the resulting position's evaluation is the only mathematically sound way to price moves outside the top N, avoiding arbitrary loss caps or inaccurate estimations.
- **Robustness**: Handling terminal states directly protects the engine from being invoked on positions with no legal moves, preventing crashes or hanging analysis.
