/**
 * Persistence for the create-a-game panel's last-used settings.
 *
 * Pure and DOM-free: parses/serializes the small preferences blob the panel
 * saves to `localStorage` after a successful create, so a returning player gets
 * their last settings back. Unknown or out-of-range values are rejected
 * (returns `null`), while V2/V3 blobs without later fields are normalized to
 * the current defaults.
 */
import {
  OFFERED_VARIANTS,
  SEEK_COLORS,
  type SeekColor,
  type Variant,
} from '../api/models.js';
import {
  CREATE_GAME_PRESETS,
  CUSTOM_PRESET_ID,
  validateCustomTime,
  type CreateGamePresetId,
} from './time-presets.js';

export const PREFS_STORAGE_KEY = 'gambit-create-game';
export const DEFAULT_CREATE_GAME_VARIANT: Variant = 'standard';
export const DEFAULT_CREATE_GAME_COLOR: SeekColor = 'random';
export const OPPONENT_RATING_LIMITS = { min: 0, max: 4000 } as const;

export type SeekMode = 'casual' | 'rated';

export type CreateGamePrefs =
  | {
      readonly time: CreateGamePresetId;
      readonly mode: SeekMode;
      readonly variant: Variant;
      readonly color: SeekColor;
      readonly minRating: number | null;
      readonly maxRating: number | null;
    }
  | {
      readonly time: typeof CUSTOM_PRESET_ID;
      readonly minutes: number;
      readonly increment: number;
      readonly mode: SeekMode;
      readonly variant: Variant;
      readonly color: SeekColor;
      readonly minRating: number | null;
      readonly maxRating: number | null;
    };

export type RatingBoundParseResult =
  | { readonly ok: true; readonly value: number | null }
  | { readonly ok: false };

/** Compare untrusted input against a readonly canonical catalog without widening its values. */
function includesString<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.some((candidate) => candidate === value);
}

/** Narrow untrusted persisted or DOM input to a player-facing offered variant. */
export function isOfferedVariant(value: unknown): value is Variant {
  return includesString(OFFERED_VARIANTS, value);
}

/** Narrow untrusted persisted or DOM input to a canonical seek color preference. */
export function isSeekColor(value: unknown): value is SeekColor {
  return includesString(SEEK_COLORS, value);
}

/** Parse one optional literal base-10 rating bound without converting blank to zero. */
export function parseRatingBound(raw: string): RatingBoundParseResult {
  const literal = raw.trim();
  if (literal === '') return { ok: true, value: null };
  if (!/^\d+$/.test(literal)) return { ok: false };
  const rating = Number(literal);
  return Number.isSafeInteger(rating)
    && rating >= OPPONENT_RATING_LIMITS.min
    && rating <= OPPONENT_RATING_LIMITS.max
    ? { ok: true, value: rating }
    : { ok: false };
}

/** Validate one optional persisted rating bound without trusting its JSON type. */
function parseStoredRating(
  prefs: Record<string, unknown>,
  key: 'minRating' | 'maxRating',
): number | null | false {
  if (!Object.prototype.hasOwnProperty.call(prefs, key) || prefs[key] === null) return null;
  const storedRating = prefs[key];
  return typeof storedRating === 'number'
    && Number.isSafeInteger(storedRating)
    && storedRating >= OPPONENT_RATING_LIMITS.min
    && storedRating <= OPPONENT_RATING_LIMITS.max
    ? storedRating
    : false;
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

  const variant =
    o.variant === undefined
      ? DEFAULT_CREATE_GAME_VARIANT
      : isOfferedVariant(o.variant)
        ? o.variant
        : null;
  if (variant === null) return null;

  const color =
    o.color === undefined
      ? DEFAULT_CREATE_GAME_COLOR
      : isSeekColor(o.color)
        ? o.color
        : null;
  if (color === null) return null;

  const minRating = parseStoredRating(o, 'minRating');
  const maxRating = parseStoredRating(o, 'maxRating');
  if (minRating === false || maxRating === false) return null;
  if (minRating !== null && maxRating !== null && minRating > maxRating) return null;

  const time = o.time;
  if (typeof time !== 'string') return null;

  if (time === CUSTOM_PRESET_ID) {
    const minutes = o.minutes;
    const increment = o.increment;
    if (typeof minutes !== 'number' || typeof increment !== 'number') return null;
    if (!validateCustomTime(minutes, increment).ok) return null;
    return { time, minutes, increment, mode, variant, color, minRating, maxRating };
  }

  const preset = CREATE_GAME_PRESETS.find((candidate) => candidate.id === time);
  return preset ? { time: preset.id, mode, variant, color, minRating, maxRating } : null;
}

/** Serialize prefs for storage. */
export function serializeCreateGamePrefs(prefs: CreateGamePrefs): string {
  return JSON.stringify(prefs);
}
