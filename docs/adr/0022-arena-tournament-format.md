# 22. Arena Tournament Format Domain Model

Date: 2026-07-17

## Status

Accepted

## Context

We need to support "Arena" tournaments, a very popular format popularized by platforms like Lichess. Unlike traditional round-based tournaments (Swiss, Round-Robin) where everyone waits for a round to finish before the next one starts, Arena tournaments are continuous and time-based:
- Players join a shared pool and are paired continuously as they become free.
- The tournament runs for a fixed wall-clock duration rather than a fixed number of rounds.
- Players can join late or withdraw at any time seamlessly.
- Scoring typically involves a "streak" mechanism (e.g., doubling points after two consecutive wins).

## Decision

We have implemented the Arena tournament format as a pure, self-contained domain model in `@chess-platform/tournament` (`ArenaTournament` aggregate).

### Key Decisions
1. **Separate Aggregate**: The Arena format is fundamentally incompatible with the existing `PairingStrategy` port used by round-based formats. Round-based formats generate a fixed list of pairings per "round." Arena is pull-based, requiring the caller to actively poll `pairAvailable()` over time. Therefore, we chose to implement `ArenaTournament` as its own standalone aggregate rather than awkwardly shoehorning it into the round-based abstractions.
2. **Configuration**: Arena introduces its own config type (`ArenaConfig`) which is separate from the union type `TournamentConfig` to avoid breaking changes in the API and persistence layers during this initial domain modeling phase. Integration with the outer layers will occur in a follow-up increment.
3. **Time Injection**: To maintain domain purity and determinism, the `ArenaTournament` does not use `Date.now()`. Instead, all time-sensitive methods (`start()`, `settle()`, `pairAvailable()`, `recordResult()`) accept a `nowMs` argument.
4. **Streak Scoring**: We implemented Lichess-style streak scoring:
   - Base scoring: Win = 2, Draw = 1, Loss = 0.
   - On Fire (Streak): Once a player wins 2 consecutive games, they are "on fire". All subsequent scores are doubled (Win = 4, Draw = 2, Loss = 0) until they fail to win.
5. **Pairing Logic**: `pairAvailable` sorts available players by points (competitiveness) and avoids pairing the same players back-to-back if alternative partners are available. Color balancing is preserved.
6. **Snapshotting**: The `ArenaTournament` supports full JSON serialization and deserialization via `toSnapshot()` and `ArenaTournament.restore()` to be compatible with event sourcing / snapshots in `@chess-platform/persistence`.

## Consequences

- The `tournament` package now natively supports time-based, continuous tournaments.
- The domain remains completely hermetic and pure.
- Future work (Increment 11) will bridge this domain model into the API, real-time gateway, and persistence layers.
- The existing round-based formats remain completely isolated and unaffected by this addition.
