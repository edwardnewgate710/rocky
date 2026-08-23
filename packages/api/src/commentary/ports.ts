/**
 * @packageDocumentation
 * What tournament commentary needs from the rest of the system, stated as narrowly as it can be.
 *
 * Three small ports rather than a repository, a launcher and a user table: the service's whole
 * claim is that every fact it publishes came from authoritative server state, and the way to keep
 * that claim checkable is to give it exactly the reads that produce those facts and nothing it
 * could reach further with.
 */
import type { PlayerStanding, Round } from '@chess-platform/tournament';

/**
 * The subset of the tournament aggregate this service reads.
 *
 * Structurally satisfied by `Tournament` itself, which is the point — the aggregate answers these
 * questions and the service restates none of them. `isRoundComplete` in particular is the same
 * condition the aggregate uses to advance a round, so "complete enough to recap" and "complete
 * enough to pair the next round" cannot come apart.
 */
export interface TournamentFacts {
  /** Every round the pairing strategy has generated so far, in order. */
  getRounds(): readonly Round[];
  /** Where a game sits in this tournament, or `null` if it is not part of it. */
  pairingForGame(gameId: string): { roundIndex: number; pairingIndex: number } | null;
  /** The recorded result for one pairing, or `undefined` while it is unresolved. */
  resultFor(roundIndex: number, pairingIndex: number): PairingResult | undefined;
  /** Whether every pairing in a round has a recorded result. */
  isRoundComplete(roundIndex: number): boolean;
  /** The table as it stood at the end of a round, ignoring every later result. */
  standingsAfterRound(roundIndex: number): PlayerStanding[];
}

/**
 * Every value the aggregate can record against a pairing.
 *
 * Stated as a union rather than `string` so that a value the aggregate grows later cannot reach the
 * wire unnoticed: `RecapPairing.result` and the OpenAPI enum both publish exactly these six, and a
 * seventh would now be a compile error here instead of a response that fails its own schema at
 * runtime. Raised in the CodeRabbit review of PR #153.
 */
export type PairingResult =
  | 'white_win'
  | 'black_win'
  | 'draw'
  | 'double_forfeit'
  | 'bye'
  | 'void';

/** Why a tournament cannot be commentated, when it cannot. */
export type TournamentLookupFailure = 'not_found' | 'arena';

/**
 * Loads a round-based tournament.
 *
 * `arena` is a distinct answer rather than a `not_found`: an arena is a real tournament that this
 * feature genuinely cannot describe, because arenas pair continuously and have no rounds at all
 * (`packages/tournament/src/arena.ts`). Collapsing the two would tell a caller their tournament does
 * not exist when it plainly does.
 */
export interface TournamentLookup {
  /**
   * @param tournamentId - the tournament named in the request path.
   * @returns its read surface, or why it cannot be commentated.
   */
  roundBased(tournamentId: string): Promise<TournamentFacts | TournamentLookupFailure>;
}

/**
 * Resolves player ids to the one display value this feature may use.
 *
 * Handles only. The account row behind a player carries an email, an email hash and moderation
 * flags, and a narrative needs none of them; a port that returns the row would make sending them
 * to a third-party provider a matter of remembering not to. Ids with no account are simply absent
 * from the result, and the caller decides what to call them.
 */
export interface PlayerHandles {
  /**
   * @param playerIds - the ids to resolve; duplicates are harmless.
   * @returns the handle for each id, omitting ids with no account.
   */
  handles(playerIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}
