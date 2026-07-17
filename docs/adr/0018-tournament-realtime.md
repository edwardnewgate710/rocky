# ADR 0018: Tournament Real-time Integration

**Date**: 2026-07-17  
**Status**: Accepted  

## Context

We need to close the loop on tournaments. Previously, a tournament generated pairings, but these pairings were not connected to real gameplay. They were launched via an `InMemoryGameLauncher` that fabricated game IDs without creating actual games. We needed a way to launch real games, track when they end, and record the results back into the tournament to automatically advance the standings and launch subsequent rounds.

A strict architectural constraint is that `@chess-platform/api` (the stateless REST API) must not depend on `@chess-platform/realtime-gateway` (which contains the `GameAuthority` and `PubSub`). We must keep the tournament domain pure.

## Decision

We decided to implement the real-time tournament integration entirely within the composition root (`e2e-harness` and eventually the production entry point), keeping the `api` and `tournament` packages decoupled from `realtime-gateway`.

1. **`AuthorityGameLauncher`**: We implemented the `GameLauncher` port from `@chess-platform/api` using an `AuthorityGameLauncher`. This launcher takes the `GameAuthority` and creates real games within the authority. It generates deterministic game IDs using the pattern `t:${tournamentId}:m:${matchId}` to easily map games back to their tournament context.
2. **`TournamentResultReporter`**: We created a `TournamentResultReporter` that subscribes to the realtime `PubSub` for `EndedBroadcast` messages on specific game channels. When a game ends, the reporter maps the broadcast result (`1-0`, `0-1`, `1/2-1/2`) to the domain's `GameResult` (`white_win`, `black_win`, `draw`).
3. **Idempotency and Resilience**: For completed games the reporter unsubscribes immediately upon receiving the first broadcast and catches any errors (such as "Already recorded") thrown by the `TournamentService`, so duplicate broadcasts or manual director overrides never crash the subscriber. The launch id is `t:<tid>:m:<matchId>:a:<attempt>`, where `attempt` is a per-pairing counter carried in the tournament snapshot. Making `attempt` part of the id keeps launch idempotent per `(tournamentId, matchId, attempt)` (crash-safe between launch and snapshot save) while still allowing a pairing to be replayed with a distinct game.
4. **Aborted games (`*`) auto-relaunch**: When a game ends aborted, the reporter calls `TournamentService.abandonGame`, which unlinks the dead game, bumps the pairing's `attempt`, and reconciles — launching a fresh game for the same pairing so the round can still finish autonomously. Without the `attempt` bump the deterministic id would collide with the abandoned (terminal) game and no new game could be created.
5. **Wiring via Composition Root**: The `e2e-harness` wires these pieces together. The `AuthorityGameLauncher` is injected into the `TournamentService`. When the launcher creates a game, it notifies the `TournamentResultReporter` to begin watching that game's channel.

## Consequences

- **Positive**: The `@chess-platform/tournament` domain remains pure and mathematically sound. It knows nothing about the real-time layer, web sockets, or pub-sub.
- **Positive**: Tournaments play fully autonomously. When all games in a round end, the domain's internal logic automatically generates the next round, which calls the launcher, which creates the next set of games and wires up the reporter.
- **Negative**: The reporter needs its own instance of `TournamentService` to commit the results back to the repository. This requires care to ensure it uses the same underlying `TournamentsRepository` and `GameLauncher` instances as the rest of the application, avoiding cyclic dependency issues during instantiation.
- **Known limitation**: Aborted games auto-relaunch without a cap, so a client that aborts on repeat could relaunch indefinitely. Bounding retries (and forfeiting the offender) is an anti-abuse concern deferred to the security/anti-cheat milestone (M12). Concurrent writers (the API service and the reporter service both saving snapshots) rely on last-write-wins; optimistic concurrency on `TournamentsRepository.save` is a tracked follow-up.
