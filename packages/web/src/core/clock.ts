/**
 * Chess clock model — pure, with an injected time source.
 *
 * The UI ticks a rendering loop; this module holds the authoritative local
 * countdown between server syncs. Time is injected (`nowMs`) so the logic is
 * deterministic and unit-testable without real timers — the same seam pattern
 * used by `@chess-platform/engine`'s `Clock`.
 */

import type { Color } from './board.js';

export interface ClockConfig {
  /** Initial time per side, milliseconds. */
  readonly initialMs: number;
  /** Fischer increment added after each move, milliseconds. Default 0. */
  readonly incrementMs?: number;
}

export interface ClockSnapshot {
  readonly white: number;
  readonly black: number;
  readonly turn: Color;
  readonly running: boolean;
}

export class ChessClock {
  private readonly incrementMs: number;
  private remaining: Record<Color, number>;
  private turn: Color = 'white';
  private running = false;
  private lastTickMs = 0;

  constructor(config: ClockConfig) {
    if (config.initialMs <= 0) {
      throw new RangeError(`initialMs must be positive, got ${config.initialMs}`);
    }
    this.incrementMs = config.incrementMs ?? 0;
    if (this.incrementMs < 0) {
      throw new RangeError(`incrementMs must be >= 0, got ${this.incrementMs}`);
    }
    this.remaining = { white: config.initialMs, black: config.initialMs };
  }

  /** Start (or resume) the active side's clock at `nowMs`. */
  start(nowMs: number): void {
    if (this.running) return;
    this.running = true;
    this.lastTickMs = nowMs;
  }

  /** Fold elapsed time into the active side. Clamps at zero (flag fall). */
  private accrue(nowMs: number): void {
    if (!this.running) return;
    const elapsed = Math.max(0, nowMs - this.lastTickMs);
    this.remaining[this.turn] = Math.max(0, this.remaining[this.turn] - elapsed);
    this.lastTickMs = nowMs;
  }

  /**
   * Register a move by the active side: accrue time, apply increment (only if
   * they have not flagged), then hand the clock to the opponent.
   */
  move(nowMs: number): void {
    this.accrue(nowMs);
    if (this.remaining[this.turn] > 0) {
      this.remaining[this.turn] += this.incrementMs;
    }
    this.turn = this.turn === 'white' ? 'black' : 'white';
  }

  /** Pause without switching sides (e.g. game over / disconnect). */
  stop(nowMs: number): void {
    this.accrue(nowMs);
    this.running = false;
  }

  /** Overwrite from an authoritative server sync. */
  sync(state: { white: number; black: number; turn: Color; nowMs: number }): void {
    this.remaining = { white: Math.max(0, state.white), black: Math.max(0, state.black) };
    this.turn = state.turn;
    this.lastTickMs = state.nowMs;
  }

  /** True when the side to move has run out of time. */
  hasFlagged(nowMs: number): boolean {
    this.accrue(nowMs);
    return this.remaining[this.turn] <= 0;
  }

  /** Current remaining times and turn at `nowMs`. */
  snapshot(nowMs: number): ClockSnapshot {
    this.accrue(nowMs);
    return {
      white: this.remaining.white,
      black: this.remaining.black,
      turn: this.turn,
      running: this.running,
    };
  }
}
