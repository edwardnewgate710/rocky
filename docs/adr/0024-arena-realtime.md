# 0024: Arena Realtime Game Lifecycle

## Status
Accepted

## Context
In M9 Increment 11, we added the Arena tournament format API and persistence, but left out the real-time game launching, result recording, and settlement. We needed a way to continuously launch games for available players, record results, update the streak standings, and end the tournament when its fixed duration expires.

## Decision
- **Parallel Dispatch**: We introduced a parallel pathway for `ArenaService` alongside `TournamentService`, with `TournamentResultReporter` serving as a cross-format dispatcher using `isArenaSnapshot`.
- **Reconciliation Loop**: We implemented `reconcileLaunch(arena)` in `ArenaService`, which asks the arena for new pairings, launches games, and stores the `gameId` links in the arena state.
- **Settle on Read**: Since the tournament relies on a clock for expiration, it settles its state to `'finished'` upon reading its snapshot if the deadline has passed and no active games remain.

## Consequences
- We successfully integrate the Arena format into the live game lifecycle without polluting the generic round-robin and swiss behaviors.
- Real-time broadcasts, including tracking active games, are shared natively through the existing `GameLauncher` integration.
