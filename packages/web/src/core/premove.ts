/**
 * Premove queue — pure client-side state.
 *
 * A premove is a move the local player commits *before* it is their turn. When
 * the opponent's move arrives, the frontend attempts to play the head of the
 * queue. This module models the queue only; validation against the resulting
 * position is done by the caller with `@chess-platform/core` before submitting.
 *
 * We keep a small bounded queue (chained premoves) and expose explicit
 * transitions so the UI and tests share one source of truth.
 */

export interface Premove {
  readonly from: string;
  readonly to: string;
  /** Promotion piece letter (q,r,b,n) when the premove is a promotion. */
  readonly promotion?: 'q' | 'r' | 'b' | 'n';
}

export interface PremoveQueueOptions {
  /** Max chained premoves retained. Default 1 (single premove, Lichess-style). */
  readonly maxDepth?: number;
}

export class PremoveQueue {
  private readonly maxDepth: number;
  private queue: Premove[] = [];

  constructor(options: PremoveQueueOptions = {}) {
    const depth = options.maxDepth ?? 1;
    if (!Number.isInteger(depth) || depth < 1) {
      throw new RangeError(`maxDepth must be a positive integer, got ${String(depth)}`);
    }
    this.maxDepth = depth;
  }

  /** Number of queued premoves. */
  get size(): number {
    return this.queue.length;
  }

  /** True when at least one premove is queued. */
  get active(): boolean {
    return this.queue.length > 0;
  }

  /** Snapshot of the queued premoves (defensive copy). */
  list(): Premove[] {
    return this.queue.map((m) => ({ ...m }));
  }

  /**
   * Queue a premove. When the queue is at capacity the *oldest* premove is
   * dropped so the most recent intent wins (matches player expectation).
   * Returns the queued premove.
   */
  enqueue(premove: Premove): Premove {
    const normalized: Premove = premove.promotion
      ? { from: premove.from, to: premove.to, promotion: premove.promotion }
      : { from: premove.from, to: premove.to };
    this.queue.push(normalized);
    if (this.queue.length > this.maxDepth) {
      this.queue.shift();
    }
    return normalized;
  }

  /** Remove and return the next premove to attempt, or null when empty. */
  dequeue(): Premove | null {
    return this.queue.shift() ?? null;
  }

  /** Peek the next premove without removing it. */
  peek(): Premove | null {
    return this.queue[0] ? { ...this.queue[0] } : null;
  }

  /** Cancel all premoves (e.g. player right-clicks the board). */
  clear(): void {
    this.queue = [];
  }
}
