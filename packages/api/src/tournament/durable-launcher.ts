import { createHash } from 'node:crypto';
import type { Variant } from '@chess-platform/core';
import { Game, type TimeControl } from '@chess-platform/game';
import type { EventStore } from '@chess-platform/persistence';
import type { Clock } from '../ports/clock';
import type { GameLauncher, LaunchInput } from './launcher';

/**
 * Production tournament launcher backed by the shared durable game event log.
 * The game id is a SHA-256 digest of the launch identity, so every API replica
 * converges on the same id even before either process has written anything.
 */
export class DurableGameLauncher implements GameLauncher {
  constructor(
    private readonly events: EventStore,
    private readonly clock: Clock,
  ) {}

  async launch(input: LaunchInput): Promise<{ gameId: string }> {
    const gameId = launchGameId(input);
    if (await this.events.exists(gameId)) return { gameId };

    const { events } = Game.create({
      gameId,
      variant: input.variant as Variant,
      timeControl: input.timeControl as TimeControl,
      players: { white: input.white, black: input.black },
      rated: true,
      at: this.clock.now(),
    });

    try {
      await this.events.append(gameId, -1, events);
    } catch (error) {
      // A concurrent replica may have won the deterministic-id race. Only
      // accept that failure when the exact game now exists durably.
      if (!(await this.events.exists(gameId))) throw error;
    }
    return { gameId };
  }
}

export function launchGameId(input: LaunchInput): string {
  const identity = JSON.stringify([input.tournamentId, input.matchId, input.attempt]);
  const bytes = createHash('sha256').update(identity).digest().subarray(0, 16);
  // RFC 4122 variant + version-5-style marker. The digest is SHA-256 rather
  // than SHA-1, but the UUID representation remains accepted by the existing
  // UUID Postgres schema and deterministic across replicas.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
