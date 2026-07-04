/**
 * Priority scheduler with aging and per-class backpressure. Lower {@link JobPriority}
 * ordinal is served first, but a job's *effective* priority improves the longer it has
 * waited (aging), which prevents a flood of low-priority batch work from starving it
 * indefinitely. Each priority class has a bounded capacity; exceeding it is signalled to
 * the caller (backpressure) rather than growing memory without limit.
 */
import type { Clock } from './clock.js';
import { JobPriority } from './types.js';
import { QueueFullError } from './errors.js';

export interface ScheduledEntry<T> {
  readonly value: T;
  readonly priority: JobPriority;
  readonly signal?: AbortSignal;
  /** Invoked exactly once if the entry is removed because its signal aborted while queued. */
  readonly onCancel: () => void;
}

export interface SchedulerOptions {
  readonly clock: Clock;
  /** Max queued entries per priority class (default 1000). */
  readonly capacityPerClass?: number;
  /** Every `agingMs` a job waits, its effective priority improves by one class (default 250ms). */
  readonly agingMs?: number;
}

interface InternalEntry<T> {
  readonly value: T;
  readonly priority: JobPriority;
  readonly enqueuedAt: number;
  readonly signal?: AbortSignal;
  readonly onCancel: () => void;
  abortListener?: () => void;
}

export class PriorityScheduler<T> {
  private readonly items: Array<InternalEntry<T>> = [];
  private readonly clock: Clock;
  private readonly capacityPerClass: number;
  private readonly agingMs: number;

  constructor(options: SchedulerOptions) {
    this.clock = options.clock;
    this.capacityPerClass = options.capacityPerClass ?? 1000;
    this.agingMs = options.agingMs ?? 250;
  }

  get size(): number {
    return this.items.length;
  }

  countByClass(priority: JobPriority): number {
    return this.items.reduce((count, item) => (item.priority === priority ? count + 1 : count), 0);
  }

  /** Enqueue an entry. Throws {@link QueueFullError} if its priority class is at capacity. */
  enqueue(entry: ScheduledEntry<T>): void {
    if (this.countByClass(entry.priority) >= this.capacityPerClass) {
      throw new QueueFullError(`Priority class ${JobPriority[entry.priority]} is at capacity (${this.capacityPerClass}).`);
    }
    const internal: InternalEntry<T> = {
      value: entry.value,
      priority: entry.priority,
      enqueuedAt: this.clock.now(),
      ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
      onCancel: entry.onCancel,
    };
    if (entry.signal) {
      const listener = (): void => this.cancel(internal);
      internal.abortListener = listener;
      entry.signal.addEventListener('abort', listener, { once: true });
    }
    this.items.push(internal);
  }

  /**
   * Remove and return the highest-effective-priority entry's value, or `undefined` if
   * empty. Aborted entries are purged (and their `onCancel` fired) before selection.
   */
  dequeue(): T | undefined {
    this.purgeAborted();
    if (this.items.length === 0) return undefined;

    const now = this.clock.now();
    let bestIndex = 0;
    let bestEffective = this.effectivePriority(this.items[0], now);
    for (let i = 1; i < this.items.length; i++) {
      const effective = this.effectivePriority(this.items[i], now);
      if (
        effective < bestEffective ||
        (effective === bestEffective && this.items[i].enqueuedAt < this.items[bestIndex].enqueuedAt)
      ) {
        bestIndex = i;
        bestEffective = effective;
      }
    }
    const [entry] = this.items.splice(bestIndex, 1);
    this.detach(entry);
    return entry.value;
  }

  private effectivePriority(entry: InternalEntry<T>, now: number): number {
    const waited = Math.max(0, now - entry.enqueuedAt);
    const boost = Math.floor(waited / this.agingMs);
    return Math.max(0, entry.priority - boost);
  }

  private purgeAborted(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const entry = this.items[i];
      if (entry.signal?.aborted) {
        this.items.splice(i, 1);
        this.detach(entry);
        entry.onCancel();
      }
    }
  }

  private cancel(entry: InternalEntry<T>): void {
    const index = this.items.indexOf(entry);
    if (index < 0) return;
    this.items.splice(index, 1);
    this.detach(entry);
    entry.onCancel();
  }

  private detach(entry: InternalEntry<T>): void {
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener('abort', entry.abortListener);
      entry.abortListener = undefined;
    }
  }
}
