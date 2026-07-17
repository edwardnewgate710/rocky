import type { IdGenerator } from '../ports/ids';

export interface LaunchInput {
  readonly tournamentId: string;
  readonly matchId: string;
  readonly white: string;
  readonly black: string;
  readonly variant: string;
  readonly timeControl: unknown;
  /**
   * How many games have already been launched for this pairing (0 for the
   * first). Part of the launch identity so a replayed pairing (after an abort)
   * gets a fresh, non-colliding game rather than resolving to the dead one.
   */
  readonly attempt: number;
}

/**
 * Port for turning a tournament pairing into a concrete, playable game.
 *
 * Idempotency contract: `launch` MUST be idempotent per
 * `(tournamentId, matchId, attempt)`. Calling it more than once for the same
 * triple must return the SAME `gameId` rather than creating a second game. The
 * `TournamentService.reconcileLaunch` loop relies on this: it launches a game,
 * then persists the tournament snapshot as a separate step. If the process
 * crashes between those two writes, the link is not persisted, so on reload the
 * loop calls `launch` again for the same pairing. An idempotent launcher hands
 * back the original `gameId`, keeping the whole flow crash-safe with no
 * duplicate games. A durable adapter enforces this with a unique key on
 * `(tournamentId, matchId, attempt)`.
 */
export interface GameLauncher {
  launch(input: LaunchInput): Promise<{ gameId: string }>;
}

/**
 * In-memory {@link GameLauncher} for tests and local runs. Idempotent per
 * `(tournamentId, matchId, attempt)` for the lifetime of the instance, which is
 * enough to honor the port contract within a single process.
 */
export class InMemoryGameLauncher implements GameLauncher {
  public readonly launched: LaunchInput[] = [];
  private readonly byKey = new Map<string, string>();

  constructor(private readonly ids: IdGenerator) {}

  async launch(input: LaunchInput): Promise<{ gameId: string }> {
    const key = `${input.tournamentId}:${input.matchId}:${input.attempt}`;
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      return { gameId: existing };
    }
    const gameId = this.ids.next();
    this.byKey.set(key, gameId);
    this.launched.push(input);
    return { gameId };
  }
}
