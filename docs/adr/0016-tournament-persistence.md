# 16. Tournament Persistence and API

Date: 2026-07-16

## Status

Accepted

## Context

M9 Increments 1 and 2 established `@chess-platform/tournament` as a pure, dependency-free domain for tournament logic, handling round-robin and Swiss pairing algorithms, Sonneborn-Berger standings, and state transitions (registration -> running -> finished).

However, the domain alone is not accessible to clients. We need to expose tournaments via the REST API, persist their state between server restarts, and allow clients to query and mutate them.

Following our Hexagonal Architecture, the domain must remain agnostic to databases and HTTP frameworks.

## Decision

We will implement the persistence and API layers for tournaments using the established adapter patterns in the `persistence` and `api` packages.

### 1. Snapshot-based Persistence
Instead of mapping complex aggregate internals (like `PairingStrategy` state and deep arrays of `Round`s) to normalized relational tables, we adopt a **Snapshot Pattern**.

- The `Tournament` aggregate provides a `toSnapshot(): TournamentSnapshot` method.
- The aggregate provides a static `restore(snapshot: TournamentSnapshot, strategy: PairingStrategy): Tournament` method.
- `TournamentSnapshot` is a plain, JSON-serializable representation of the tournament's entire state.
- The `TournamentsRepository` persists and retrieves these snapshots. 
- Because tournaments are naturally bounded in size (a few hundred players, a dozen rounds), serializing the entire state as a single JSON document (or in-memory clone) is efficient and drastically reduces object-relational impedance mismatch.

### 2. API Service Layer
We introduce `TournamentService` in `@chess-platform/api` to coordinate the load-mutate-save cycle:
- It fetches the snapshot from the repository.
- It reconstitutes the `Tournament` aggregate (injecting the correct `PairingStrategy` based on the config).
- It invokes the domain method (e.g., `register()`, `recordResult()`).
- It extracts the new snapshot and saves it back to the repository.
- Domain errors are caught and translated into `HttpError.conflict` (HTTP 409).

### 3. REST Endpoints
We expose the following standard REST endpoints in `routes.ts`:
- `POST /v1/tournaments`: Create a tournament (requires `tournament_director` role).
- `GET /v1/tournaments`: List tournaments.
- `GET /v1/tournaments/:id`: Get tournament details.
- `POST /v1/tournaments/:id/participants`: Register for a tournament.
- `DELETE /v1/tournaments/:id/participants/:playerId`: Withdraw from a tournament.
- `POST /v1/tournaments/:id/start`: Start the tournament (requires `tournament_director`).
- `GET /v1/tournaments/:id/rounds`: List generated rounds.
- `POST /v1/tournaments/:id/rounds/:roundIndex/results`: Record a game result (requires `tournament_director`).
- `GET /v1/tournaments/:id/standings`: Get computed standings.

### 4. OpenAPI Validation
We extended the OpenAPI component schemas (`packages/api/src/openapi/schemas.ts`) to validate all incoming and outgoing tournament payloads, ensuring type safety and documentation generation.

## Consequences

**Positive:**
- The domain remains completely pure and decoupled from HTTP/database logic.
- Snapshot persistence simplifies saving complex pairing histories and standings state without requiring deeply nested SQL inserts.
- The API is fully documented and verifiable via `npm run openapi` and the test harness.

**Negative:**
- The JSON snapshot pattern means querying deep inside a tournament (e.g., "find all tournaments where player X played black against player Y") requires fetching the entire snapshot or relying on JSONB indexing capabilities in the future Postgres adapter. Given our read patterns, this is an acceptable tradeoff for write simplicity.
