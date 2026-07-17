# ADR 0017: Tournament Game Lifecycle

## Status
Accepted

## Context
M9 (Tournaments) established the pure domain for pairings and standings (Inc 1-2) and the database persistence via Postgres (Inc 3-4). However, for a tournament to be playable, each generated `GamePairing` needs an actual game to be played by the clients via the realtime gateway. 

We needed a way to translate a domain-level pairing into a `gameId` without leaking the realtime game rules (the `GameAuthority` or `engine`) into the `Tournament` aggregate, which should remain pure. Also, we must safely map incoming game results back to the specific pairing.

## Decision
1. **Game Links in the Aggregate**: We extended the `Tournament` aggregate to maintain a bidirectional mapping between `matchId` (e.g. `0-1` for round 0, pairing 1) and an opaque `gameId` (string). 
2. **Game Launcher Port**: We defined a `GameLauncher` port in the API layer. The port has a single `launch(input)` method returning a `{ gameId: string }`.
3. **Reconciliation Loop**: The `TournamentService` invokes a `reconcileLaunch(tournament)` method every time the tournament is mutated (e.g. `start()` or `recordResult()`). This method scans all game pairings, identifies those missing a `gameId`, and calls the launcher to get one, linking it to the aggregate.
4. **By-Game-ID Result Recording**: We added `recordResultByGame(gameId, result)` to the aggregate and service. The API exposes `POST /v1/tournaments/:id/games/:gameId/result` to record the outcome of a launched game.

## Consequences
### Positive
- **Purity**: The `Tournament` aggregate remains pure. It doesn't know *how* games are launched, only that a specific match maps to a string `gameId`.
- **Testability**: We implemented `InMemoryGameLauncher` to allow fully synchronous, isolated testing of the tournament lifecycle without booting the realtime `GameAuthority`.
- **Idempotency**: The `reconcileLaunch` loop is idempotent. If a game is already launched, it is skipped. This prepares us for crash-recovery if the server goes down between launching a game and persisting the tournament snapshot.

### Negative
- **Latency**: Launching games sequentially in the `reconcileLaunch` loop could be slow if there are hundreds of pairings in a Swiss round. (We can optimize to `Promise.all` later if needed).

## Notes
- Backward compatibility: `TournamentSnapshot.gameLinks` is optional, and the `restore` method gracefully handles older snapshots.
