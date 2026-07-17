# 23. Parallel Arena Service

Date: 2026-07-17

## Status

Accepted

## Context

In M9 Increment 10, we introduced the `ArenaTournament` domain model. Arena tournaments are continuous, time-based events where players are continuously paired as they become free, unlike round-robin or swiss tournaments which proceed in discrete, synchronized rounds.

In M9 Increment 11, we needed to expose this new domain model through the REST API and persist it. The existing `TournamentService` and API routes were heavily coupled to the assumptions of round-based tournaments (e.g., specific round indices, synchronous progression, fixed number of rounds). Attempting to modify `TournamentService` to accommodate both models natively would introduce complex conditional logic, threatening the stability of the already fully-functional and tested round-based logic.

## Decision

We decided to implement a parallel `ArenaService` to handle the business logic for arena tournaments.
- The shared REST API endpoints (e.g., `POST /v1/tournaments`, `GET /v1/tournaments/:id`) inspect the incoming request or the loaded tournament snapshot to branch their behavior. If `format === 'arena'`, they delegate to `ArenaService`; otherwise, they delegate to the existing `TournamentService`.
- Both models share the underlying `TournamentsRepository` by utilizing a unified `TournamentAnySnapshot` type, allowing heterogeneous persistence in PostgreSQL's JSONB column without requiring database schema divergence.
- Presenters (`ArenaTournamentView`, `ArenaStandingView`) were created specifically for the Arena model and combined into union types in the OpenAPI specification (`TournamentAnyView`, `StandingAnyList`).

## Consequences

**Positive:**
- Complete isolation: Modifying or expanding the Arena functionality will not break round-based logic.
- Simpler typing: We split `TournamentConfig` into `RoundBasedConfig` and `ArenaConfig`, which provided strict compile-time safety and avoided widening types across the whole codebase.
- Reuses the existing persistence and HTTP transport infrastructure without polluting the domain or service layers.

**Negative:**
- Some duplication in boilerplate at the routing layer (e.g., fetching the tournament to determine its format before delegating to the appropriate service).
- If additional tournament formats are added in the future, the branching in the HTTP layer could grow.
