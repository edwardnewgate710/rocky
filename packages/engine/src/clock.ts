/**
 * Injectable time source. Every timeout, watchdog, and aging computation in the
 * engine bridge goes through a {@link Clock} so tests can drive time deterministically
 * (mirroring the injected `Clock` used by `@chess-platform/api`).
 */

/** Opaque handle returned by {@link Clock.setTimeout}. */
export interface TimerHandle {
  readonly __timer: unique symbol;
}

export interface Clock {
  /** Milliseconds since an arbitrary but monotonic-enough epoch (wall clock is fine). */
  now(): number;
  /** Schedule `fn` after `ms` milliseconds. */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  /** Cancel a previously scheduled timer. Safe to call with an already-fired handle. */
  clearTimeout(handle: TimerHandle): void;
}

/** Production clock backed by the Node runtime. */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = setTimeout(fn, ms);
    // Do not keep the event loop alive purely for an engine watchdog.
    if (typeof handle.unref === 'function') {
      handle.unref();
    }
    return handle as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    clearTimeout(handle as unknown as NodeJS.Timeout);
  }
}
