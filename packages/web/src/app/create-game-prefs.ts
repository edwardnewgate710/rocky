/**
 * Persistence for the create-a-game panel's last-used settings.
 *
 * Pure and DOM-free: parses/serializes the small preferences blob the panel
 * saves to `localStorage` after a successful create, so a returning player gets
 * their last time control and mode back. Unknown or out-of-range values are
 * rejected (returns `null`), so a corrupt or stale blob falls back to the
 * first-run defaults rather than restoring something invalid.
 */
import { TIME_PRESETS, CUSTOM_LIMITS } from './time-presets.js';

export const PREFS_STORAGE_KEY = 'gambit-create-game';

export type SeekMode = 'casual' | 'rated';

export interface CreateGamePrefs {
  /** A preset id (e.g. `5+3`) or the literal `custom`. */
  readonly time: string;
  /** Present only when `time === 'custom'`. */
  readonly minutes?: number;
  readonly increment?: number;
  readonly mode: SeekMode;
}

/**
 * Parse a stored prefs blob, validating every field. Returns `null` for missing,
 * malformed, unknown-preset, or out-of-range input so the caller uses defaults.
 */
export function parseCreateGamePrefs(raw: string | null): CreateGamePrefs | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;

  const mode: SeekMode | null = o.mode === 'rated' ? 'rated' : o.mode === 'casual' ? 'casual' : null;
  if (mode === null) return null;

  const time = o.time;
  if (typeof time !== 'string') return null;

  if (time === 'custom') {
    const minutes = Number(o.minutes);
    const increment = Number(o.increment);
    const { minMinutes, maxMinutes, minIncrement, maxIncrement } = CUSTOM_LIMITS;
    if (!Number.isFinite(minutes) || minutes < minMinutes || minutes > maxMinutes) return null;
    if (!Number.isFinite(increment) || increment < minIncrement || increment > maxIncrement) return null;
    return { time, minutes, increment, mode };
  }

  if (!TIME_PRESETS.some((p) => p.id === time)) return null;
  return { time, mode };
}

/** Serialize prefs for storage. */
export function serializeCreateGamePrefs(prefs: CreateGamePrefs): string {
  return JSON.stringify(prefs);
}
