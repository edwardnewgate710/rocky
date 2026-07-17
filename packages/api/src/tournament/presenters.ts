import type { TournamentSummaryRow } from '@chess-platform/persistence';
import type { Tournament, Round } from '@chess-platform/tournament';
import type { PlayerStanding } from '@chess-platform/tournament';

export function summaryView(row: TournamentSummaryRow) {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    state: row.state,
    participantCount: row.participantCount,
  };
}

export function tournamentView(tournament: Tournament) {
  const snap = tournament.toSnapshot();
  return {
    id: snap.config.id,
    name: snap.config.name,
    format: snap.config.format,
    variant: snap.config.variant,
    timeControl: snap.config.timeControl,
    rounds: snap.config.format === 'swiss' ? snap.config.rounds : undefined,
    state: snap.state,
    participants: snap.participants,
    roundsGenerated: snap.rounds.length,
  };
}

export function roundView(round: Round, tournament: Tournament) {
  return {
    roundIndex: round.roundIndex,
    pairings: round.pairings.map((p, pIndex) => {
      if (p.kind === 'game') {
        return {
          kind: 'game',
          white: p.white,
          black: p.black,
          gameId: tournament.gameIdFor(round.roundIndex, pIndex) ?? null,
        };
      } else {
        return { kind: 'bye', player: p.player };
      }
    }),
  };
}

export function standingView(standing: PlayerStanding, index: number) {
  return {
    rank: index + 1,
    playerId: standing.playerId,
    points: standing.points,
    tiebreak: standing.tiebreak,
  };
}
