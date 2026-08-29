import { launchChess960StartId, type GameLauncher, type LaunchInput } from '@chess-platform/api';
import type { Variant } from '@chess-platform/core';
import type { TimeControl } from '@chess-platform/game';
import type { GameAuthority } from '@chess-platform/realtime-gateway';

export class AuthorityGameLauncher implements GameLauncher {
  constructor(
    private readonly authority: GameAuthority,
    private readonly onLaunched: (tournamentId: string, gameId: string) => void
  ) {}

  async launch(input: LaunchInput): Promise<{ gameId: string }> {
    // `attempt` is part of the id so a replayed pairing (after an abort) gets a
    // fresh game instead of colliding with the abandoned one.
    const gameId = `t:${input.tournamentId}:m:${input.matchId}:a:${input.attempt}`;

    const variant = input.variant as Variant;
    if (!(await this.authority.knows(gameId))) {
      await this.authority.createGame({
        gameId,
        variant,
        timeControl: input.timeControl as TimeControl,
        players: { white: input.white, black: input.black },
        rated: true,
        // The same derivation the durable launcher uses, for the same reason: a relaunched pairing
        // must resume the arrangement it started with, not a freshly drawn one.
        ...(variant === 'chess960' ? { chess960StartId: launchChess960StartId(input) } : {}),
      });
    }

    this.onLaunched(input.tournamentId, gameId);
    
    return { gameId };
  }
}
