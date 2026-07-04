import type { Clock, TimerHandle } from '../src/clock.js';

/** Drains the microtask queue (the fake transport emits on microtasks). */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface ManualTimer {
  id: number;
  at: number;
  fn: () => void;
}

/** Deterministic clock: timers fire only when the test advances virtual time. */
export class ManualClock implements Clock {
  private ms = 0;
  private seq = 0;
  private timers: ManualTimer[] = [];

  now(): number {
    return this.ms;
  }

  setTimeout(fn: () => void, delay: number): TimerHandle {
    const id = ++this.seq;
    this.timers.push({ id, at: this.ms + delay, fn });
    return { id } as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    const { id } = handle as unknown as { id: number };
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  advance(delay: number): void {
    const target = this.ms + delay;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers.find((t) => t.at <= target);
      if (!next) break;
      this.timers = this.timers.filter((t) => t !== next);
      this.ms = Math.max(this.ms, next.at);
      next.fn();
    }
    this.ms = target;
  }
}

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
