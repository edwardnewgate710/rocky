# 21. Tournament Robustness: Tiebreaks and Withdrawals

Date: 2026-07-17

## Status

Accepted

## Context

Our round-based tournament formats (round_robin and swiss) needed two major robustness features to handle real-world conditions:
1. **Additional tiebreaks**: In addition to Sonneborn-Berger, we needed Buchholz and Median-Buchholz tiebreaks, with a configurable evaluation order.
2. **Mid-tournament withdrawals**: Players often leave mid-event. The system needs to gracefully handle their departure by forfeiting ongoing games and excluding them from future pairings or auto-resolving their remaining games in fixed formats.

## Decision

### Tiebreaks
We added a `tiebreakOrder` configuration option to `TournamentConfig`. The option accepts an array of keys (`sonneborn_berger`, `buchholz`, `median_buchholz`). 
The `computeStandings` function has been updated to accept this array and dynamically sort players by points first, then sequentially by each specified tiebreak method.
- **Buchholz**: The sum of the scores of all opponents.
- **Median-Buchholz**: The Buchholz score, discarding the highest and lowest scoring opponents.

### Withdrawals
We introduced a `withdrawn` state in the `Tournament` aggregate (persisted in the snapshot). 
When a player is withdrawn:
1. They are marked with a `withdrawn` flag in the `PlayerStandingView`.
2. Any of their currently unfinished games in the active round are immediately forfeited (yielding a `double_forfeit` if both players withdrew, or standard forfeit otherwise).
3. For Swiss tournaments, the withdrawn players are excluded from `participants` in the `PairingContext` so they are never paired in future rounds.
4. For Round Robin tournaments, the original fixed schedule relies on the safety net in `Tournament#indexRound`, which automatically records a forfeit (`double_forfeit` or `bye/void` if applicable) for any generated pairings involving a withdrawn player.

We added `'void'` and `'double_forfeit'` to the game result types to adequately model these edge cases.

## Consequences

- The system now handles dynamic and flexible tiebreaking for round-based tournaments.
- Swiss and Round Robin tournaments are robust against player abandonment and can be cleanly concluded even if players drop out.
- The `Tournament` aggregate remains entirely pure.
- Future integration of the Arena format (a continuous, time-based pairing model) will be done separately, as it uses entirely different grouping/pairing abstractions.
