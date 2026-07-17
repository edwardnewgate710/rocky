# ADR 0019: Live Tournament Broadcast

## Context
A running tournament plays itself automatically (implemented in Increment 6). However, there is no way for spectators to watch the tournament as a whole. We need a live, spectator-facing view of a whole tournament, showing every active board and live standings, updating in real-time as member games make moves and finish.

The domain boundary dictates that the `@chess-platform/tournament` package must remain pure and not depend on `@chess-platform/realtime-gateway` or any pub/sub infrastructure. Similarly, the `@chess-platform/api` package must not depend on the gateway directly.

## Decision
1. **Pub/Sub Channel**: We introduced a new `tournamentChannel(tournamentId)` in `@chess-platform/realtime-gateway/src/pubsub.ts` to broadcast tournament updates.
2. **Protocol Additions**: Added `LiveBoardView` and `TournamentUpdateBroadcast` to `protocol.ts` to type the data sent to spectators.
3. **API Port**: Defined `TournamentLiveView` in `@chess-platform/api/src/tournament/live-view.ts` as an interface with an `activeGames(tournamentId)` method. This allows the REST API to serve initial state without knowing how the active games are fetched.
4. **REST Endpoint**: Implemented `GET /v1/tournaments/:id/live` which returns `{ games: LiveBoard[], standings: Standing[] }` by orchestrating the tournament service and the injected `TournamentLiveView`.
5. **Broadcaster Implementation**: Built `TournamentBroadcaster` in `packages/e2e-harness/src/broadcaster.ts` which implements the composition root wiring. It listens to the game authority's pubsub for game events (moves, terminations) and publishes aggregated updates to the tournament channel. It also implements the `TournamentLiveView` port by extracting the live board states directly from the `GameAuthority`.
6. **Dependency Injection**: Supplied the broadcaster to the `createApiServer` so the REST endpoint can utilize it.

## Consequences
- Spectators can subscribe to the `tournament:{id}` channel (over the existing WebSocket transport) to receive push updates when any board changes state or when the tournament round advances. (An SSE adapter could be added later but is not implemented here.)
- The `api` package remains decoupled from the `realtime-gateway` package, satisfying architectural boundaries.
- The `e2e-harness` (and future production deployment roots) serves as the mediator, reacting to game events and mapping them to tournament broadcasts.
- The domain layer is kept completely pure.
