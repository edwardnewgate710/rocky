/**
 * @packageDocumentation
 * Command routing: directs game commands to the owning node.
 *
 * In a single-node deployment, commands go straight to the local
 * {@link GameAuthority}. In a multi-node deployment, exactly one node owns
 * each game's authoritative state; non-owner nodes forward commands to the
 * owner via a reliable inter-node channel (see ADR-0010).
 *
 * The {@link CommandRouter} port is the seam: the {@link RealtimeGateway}
 * calls `route()` instead of `authority.apply()` directly. A
 * {@link LocalCommandRouter} (used in tests and single-node dev) delegates
 * straight to the authority. A Redis-backed router (in the deployable service)
 * checks ownership and forwards when necessary.
 */

import { GameAuthority, type ApplyResult, type Command } from './authority';

/**
 * Routes a game command to the owning node (local or forwarded).
 *
 * If this node owns the game, the command is applied locally. If not, it is
 * forwarded to the owner via a reliable channel and the result is relayed back.
 * Returns the {@link ApplyResult} or throws {@link AuthorityError}.
 */
export interface CommandRouter {
  route(gameId: string, userId: string, cmd: Command): Promise<ApplyResult>;
}

/**
 * A {@link CommandRouter} that applies commands directly to the local
 * authority. Used in single-node deployments, tests, and local dev.
 *
 * In multi-node deployments, a Redis-backed router replaces this — but the
 * gateway code is identical because it depends only on the {@link CommandRouter}
 * interface.
 */
export class LocalCommandRouter implements CommandRouter {
  constructor(private readonly authority: GameAuthority) {}

  route(gameId: string, userId: string, cmd: Command): Promise<ApplyResult> {
    return this.authority.apply(gameId, userId, cmd);
  }
}
