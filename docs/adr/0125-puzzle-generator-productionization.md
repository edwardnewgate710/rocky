# ADR-0125 — Puzzle generation borrows the production analysis subsystem

| Field      | Value                                                    |
|------------|----------------------------------------------------------|
| **Status** | Accepted                                                 |
| **Date**   | 2026-08-21                                               |
| **Scope**  | `packages/engine`, `packages/ai-features`, `packages/api`, `packages/web` |

---

## Context

`PuzzleGenerator` existed as a tested M8 library feature, but no production composition imported
it. Its result model also used a numeric gap across unlike engine scores, allowing `Infinity` for
mate, and substituted `"(none)"` when an engine line had no move. Those values are not a truthful
JSON contract. A single line likewise cannot establish that one move is uniquely better than its
alternatives, so partial MultiPV output must not be presented as either a puzzle or a quiet
position.

The API already owns a bounded `AnalysisService` and its engine pool. Giving the library feature an
engine of its own would duplicate processes, queues, cache, lifecycle and capacity ceilings.

## Decision

### 1. One fixed-policy MultiPV search

`PuzzleGenerationService` borrows the existing `AnalysisService`. One accepted request makes
exactly one analysis call (at most one pool acquisition; the shared provider cache may satisfy it)
with:

- MultiPV 3;
- depth 16;
- a 1,000 ms wall-clock search limit;
- a 200 centipawn uniqueness threshold;
- a two-move minimum mate-distance advantage when both alternatives force mate.

These values are server policy. `POST /v1/analysis/puzzle` accepts only `fen` and `variant`; clients
cannot supply depth, time, MultiPV, threshold, engine path, provider or model. The service passes
the already-computed lines to an engineless `PuzzleGenerator`, so there is no second pool or
sequential comparison search. It makes no AI-provider call and produces no generated hint or
theme.

The endpoint is authenticated and has its own fixed-window buckets: 20 accepted searches per user
per minute and 40 per IP per minute. Validation, variant support and terminal adjudication run
before quota is spent or an engine is acquired. Separating the bucket prevents tactic searches
from exhausting ordinary analysis quota.

### 2. Evidence is a JSON-safe tagged contract

The public result is one of `puzzle`, `no_tactic`, or `insufficient`.

- Finite centipawn comparisons use `{ kind: "centipawn_gap", gapCp }`.
- Mate comparisons use `{ kind: "mate", relation, distanceGap }`. `distanceGap` is `null` when a
  mate score is compared with a centipawn score; mate is not converted to a large pawn value.
- Missing or malformed lines/moves, bounded or non-finite evaluations, incomplete or mismatched
  depths, unordered lines, and terminal positions are explicit `insufficient` outcomes. Missing or
  invalid moves are `null`.
- The production path requires all three requested, unique MultiPV ranks at depth 16. UCI
  `lowerbound`/`upperbound` scores are preserved by the engine bridge and cannot be treated as exact
  puzzle evidence. `no_tactic` is returned only after complete, exact evidence supports it.

`Infinity`, `-Infinity`, `NaN`, and `"(none)"` cannot cross the production boundary. Engine/runtime
errors keep the existing opaque analysis error mapping.

### 3. Availability is feature- and variant-specific

The composition root passes the same `AnalysisService` to puzzle generation, but composes the
feature only when analysis limits and engine capabilities can satisfy its stricter policy.
`GET /v1/capabilities` publishes `puzzleGeneration` and `puzzleVariants`; the
variant list is computed from the puzzle service itself. A Stockfish-only deployment therefore
does not advertise Fairy-only variants, and unsupported variants fail before engine acquisition.
Composition also verifies that deployment ceilings can honor depth 16, 1,000 ms and MultiPV 3
unchanged. If an operator tightens any ceiling below that evidence policy, puzzle generation stays
uncomposed and the capability is false rather than silently running a weaker search.
The built-in Stockfish and Fairy-Stockfish plugins each declare a cold-start guarantee of at least
MultiPV 3, which their real-binary smoke tests verify. Once a worker has completed its UCI
handshake, the discovered `MultiPV` option and maximum become authoritative; an unsupported or
clamped request is rejected instead of silently searching fewer lines, and that variant disappears
from `puzzleVariants`.
Chess960 remains uncreatable under ADR-0123; this decision does not implement it or deploy another
engine. Analysis of an externally supplied position is advertised only when the configured engine
claims that variant.

### 4. The existing game panel owns the UI lifecycle

The game sidebar adds one capability-gated **Find tactic** action. Results are structured engine
facts, not prose. A sufficient quiet conclusion and insufficient evidence have distinct messages.
The controller coalesces repeat clicks, sends no automatic retry, keys a response to exact
`variant + FEN`, aborts and invalidates on a position change, and suppresses completion after route
disposal. The persistent DOM is reset on every mount and click listeners are route-scoped.

## Consequences

- Puzzle discovery becomes a production user feature without increasing engine-process ownership.
- Each accepted request makes one MultiPV-3 analysis call, bounded by the existing pool and limits;
  a shared cache hit can avoid fresh engine work.
- Capability, API behavior and UI offering agree for the deployed engine set.
- Puzzle persistence, ratings, sharing, spaced repetition, user-authored puzzles, LLM themes/hints,
  voice, Chess960 implementation and new engine deployment remain out of scope.
