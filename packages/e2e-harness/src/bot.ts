/**
 * Bot player: auto-joins games and plays random legal moves.
 *
 * The bot subscribes to game channels via pub/sub. When it sees a `move`
 * broadcast, it checks the current authoritative state via `authority.getState`
 * and, if it is the side to move, picks a random legal move and submits it
 * via `authority.apply`.
 *
 * The bot is co-located in the same process as the authority — it calls
 * `authority.apply` directly (no WebSocket). This is the minimal integration;
 * the M14 deployable service would use the engine bridge for bot moves.
 */
import type { GameAuthority } from '@chess-platform/realtime-gateway';
import type { PubSub, Broadcast, StateView } from '@chess-platform/realtime-gateway';

/** A simple random-move bot that plays in any game where it is seated. */
export class BotPlayer {
  private running = false;
  private readonly botUserId: string;
  private readonly games = new Map<string, { white: string; black: string }>();

  constructor(
    private readonly authority: GameAuthority,
    private readonly pubsub: PubSub,
  ) {
    this.botUserId = 'bot-0000-0000-0000';
  }

  /** The bot's user id (used when creating games with the bot as a player). */
  get userId(): string {
    return this.botUserId;
  }

  /** Start the bot. */
  start(): void {
    this.running = true;
  }

  /** Stop the bot. */
  stop(): void {
    this.running = false;
    this.games.clear();
  }

  /**
   * Register a game so the bot monitors it. Called when a game is created
   * with the bot as a player. Subscribes to the game's pub/sub channel.
   */
  registerGame(gameId: string, whiteUserId: string, blackUserId: string): void {
    this.games.set(gameId, { white: whiteUserId, black: blackUserId });

    this.pubsub.subscribe(`game:${gameId}`, (msg: Broadcast) => {
      void this.onBroadcast(gameId, msg);
    });

    // Also try to play immediately (in case it's the bot's turn first)
    this.tryPlay(gameId);
  }

  private async onBroadcast(gameId: string, _msg: Broadcast): Promise<void> {
    if (!this.running) return;
    // After any move or ended broadcast, check if it's our turn
    this.tryPlay(gameId);
  }

  private tryPlay(gameId: string): void {
    if (!this.running) return;

    const gameInfo = this.games.get(gameId);
    if (!gameInfo) return;

    let state: StateView;
    try {
      state = this.authority.getState(gameId);
    } catch {
      return; // game doesn't exist yet
    }

    if (state.status.over) return;

    const botIsWhite = gameInfo.white === this.botUserId;
    const botIsBlack = gameInfo.black === this.botUserId;

    if (state.turn === 'w' && !botIsWhite) return;
    if (state.turn === 'b' && !botIsBlack) return;

    // Pick a random legal move
    const legalMoves = state.legalMoves;
    const origins = Object.keys(legalMoves);
    if (origins.length === 0) return;

    const origin = origins[Math.floor(Math.random() * origins.length)];
    const destinations = legalMoves[origin];
    if (!destinations || destinations.length === 0) return;

    const dest = destinations[Math.floor(Math.random() * destinations.length)];
    const uci = `${origin}${dest}`;

    // Submit the move via the authority (co-located, no WebSocket needed)
    void this.authority
      .apply(gameId, this.botUserId, { kind: 'move', uci })
      .catch(() => {
        // Illegal move or not our turn — ignore
      });
  }
}
