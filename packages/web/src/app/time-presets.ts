/**
 * Time-control presets for the create-a-game panel.
 *
 * Pure and DOM-free: the panel renders chips from {@link TIME_PRESETS} and calls
 * {@link presetToTimeControl} / {@link estimateSpeed} to build the request body
 * and the speed-bucket label. Keeping the mapping here (not in markup) means the
 * clock maths are unit-tested in one place.
 */
import type { TimeControl } from '../api/models.js';

export interface TimePreset {
  /** Stable id and display label, e.g. `5+3`. */
  readonly id: string;
  /** Initial time in minutes. */
  readonly minutes: number;
  /** Increment per move in seconds. */
  readonly increment: number;
}

/** The curated preset ladder: bullet → classical. `Custom` is handled separately. */
export const TIME_PRESETS: readonly TimePreset[] = [
  { id: '1+0', minutes: 1, increment: 0 },
  { id: '2+1', minutes: 2, increment: 1 },
  { id: '3+0', minutes: 3, increment: 0 },
  { id: '3+2', minutes: 3, increment: 2 },
  { id: '5+0', minutes: 5, increment: 0 },
  { id: '5+3', minutes: 5, increment: 3 },
  { id: '10+0', minutes: 10, increment: 0 },
  { id: '10+5', minutes: 10, increment: 5 },
  { id: '15+10', minutes: 15, increment: 10 },
  { id: '30+20', minutes: 30, increment: 20 },
];

/** Preselected preset — a rapid game most players reach for. */
export const DEFAULT_PRESET_ID = '10+0';

/** Bounds for the custom-time inputs (minutes, increment seconds). */
export const CUSTOM_LIMITS = {
  minMinutes: 0.5,
  maxMinutes: 180,
  minIncrement: 0,
  maxIncrement: 60,
} as const;

export type SpeedLabel = 'Bullet' | 'Blitz' | 'Rapid' | 'Classical';

/**
 * Build a `TimeControl` from a minutes/increment pair. `sudden_death` when there
 * is no increment, otherwise `increment`. Values are clamped to whole
 * milliseconds; half-minute (30s) initial times round correctly.
 */
export function presetToTimeControl(minutes: number, increment: number): TimeControl {
  const initialMs = Math.round(minutes * 60_000);
  const incrementMs = Math.round(increment * 1_000);
  return {
    initialMs,
    incrementMs,
    delayMs: 0,
    kind: incrementMs > 0 ? 'increment' : 'sudden_death',
  };
}

/**
 * Speed bucket for display only — mirrors the server's estimator
 * (`initial + 40 × increment`, in seconds). The authoritative `speed` on a
 * created seek still comes from the server.
 */
export function estimateSpeed(tc: TimeControl): SpeedLabel {
  const estimateSeconds = (tc.initialMs + 40 * tc.incrementMs) / 1000;
  if (estimateSeconds < 180) return 'Bullet';
  if (estimateSeconds < 480) return 'Blitz';
  if (estimateSeconds < 1500) return 'Rapid';
  return 'Classical';
}
