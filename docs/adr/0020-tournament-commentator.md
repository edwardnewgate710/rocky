# ADR 0020: Tournament Commentator (AI Feature)

## Context
As part of the M9 Tournament milestone (and carrying over a deferred M8 AI feature), we need an AI-driven commentator for tournaments. This feature must provide live broadcast-style commentary on ongoing tournament games, as well as narrative recaps for completed rounds.

A strict architectural guardrail is that the `@chess-platform/ai-features` package must remain decoupled from specific domain packages like `tournament`, `api`, or `realtime-gateway`.

## Decision
We implemented the `TournamentCommentator` feature inside `@chess-platform/ai-features` with two distinct modes:

1. **`commentateMoment(request)`**:
   - **Grounding**: Engine-grounded. It converts the position and move into an `EngineGrounding` object via the M7 `engineResultsToGrounding()` bridge.
   - **Context**: Accepts a plain-data `TournamentMomentContext` object (containing player names, round, event, and stakes).
   - **Behavior**: Uses a slightly higher default temperature (e.g. 0.6) for livelier, broadcast-style prose, but enforces factual assessment by requiring the LLM to cite the engine evaluation and best line (which are also returned as a structured `EngineCitation`).

2. **`recapRound(request)`**:
   - **Grounding**: Data-grounded (no engine analysis).
   - **Context**: Accepts an array of structured match results and standings.
   - **Behavior**: Constructs a prompt explicitly instructing the LLM to act as a factual chess journalist and *not* to hallucinate games, players, or moves that are not present in the supplied data.

3. **Decoupling**:
   - The feature takes simple, primitive data structures (`string`, `number`, plain objects). It does not import or depend on the `Tournament` aggregate or any realtime gateway constructs. The caller (typically a composition root or an API handler) is responsible for extracting the necessary strings from the domain objects and passing them to the commentator.

## Consequences
- **Testability**: The feature remains completely hermetically testable using `FakeEngineTransport` and `FakeProvider`. Tests do not need to mock complex tournament domain aggregates.
- **Maintainability**: The strict package boundaries are preserved. The AI layer only knows about core chess concepts and generic text completion.
- **Accuracy**: Engine-grounding prevents hallucinated positional assessments in live commentary, while strict prompting guardrails prevent hallucinated matches in round recaps.
