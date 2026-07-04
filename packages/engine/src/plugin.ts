/**
 * Plugin-oriented engine registration. An {@link EnginePlugin} is a small descriptor
 * plus a worker factory. Engine-specific quirks (how to select a variant, the version
 * floor, expected variants for pre-warmup routing) live here — never as conditionals in
 * the pool or manager. Adding a new engine is a new plugin, not a code change elsewhere.
 */
import type { Clock } from './clock.js';
import type { EngineConfig } from './types.js';
import type { EngineTransport } from './transport.js';
import { UciEngineInstance, type EngineInstance, type EngineOption } from './instance.js';

export interface CreateInstanceOptions {
  readonly id: string;
  readonly config?: EngineConfig;
  readonly clock?: Clock;
  readonly watchdogMs?: number;
  readonly initTimeoutMs?: number;
  readonly quitGraceMs?: number;
}

export interface EnginePlugin {
  readonly id: string;
  readonly displayName: string;
  readonly minVersion: string;
  /** Variants this engine is expected to serve, for routing before a worker has warmed up. */
  readonly expectedVariants: readonly string[];
  /** The `setoption` commands that select `variant` on this engine. */
  variantSetup(variant: string): readonly EngineOption[];
  /** Construct (but do not `init`) one worker over `transport`. */
  createInstance(transport: EngineTransport, options: CreateInstanceOptions): EngineInstance;
}

function makeUciInstance(minVersion: string, transport: EngineTransport, options: CreateInstanceOptions): EngineInstance {
  return new UciEngineInstance(transport, {
    id: options.id,
    minVersion,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.watchdogMs !== undefined ? { watchdogMs: options.watchdogMs } : {}),
    ...(options.initTimeoutMs !== undefined ? { initTimeoutMs: options.initTimeoutMs } : {}),
    ...(options.quitGraceMs !== undefined ? { quitGraceMs: options.quitGraceMs } : {}),
  });
}

/** Stockfish: standard chess + Chess960 (via the `UCI_Chess960` toggle). */
export const stockfishPlugin: EnginePlugin = {
  id: 'stockfish',
  displayName: 'Stockfish',
  minVersion: '15',
  expectedVariants: ['chess', 'chess960'],
  variantSetup(variant: string): readonly EngineOption[] {
    if (variant === 'chess960') return [{ name: 'UCI_Chess960', value: true }];
    if (variant === 'chess' || variant === 'standard') return [{ name: 'UCI_Chess960', value: false }];
    return [];
  },
  createInstance(transport, options) {
    return makeUciInstance(this.minVersion, transport, options);
  },
};

/** Maps platform variant names to Fairy-Stockfish `UCI_Variant` values. */
const FAIRY_VARIANT_NAMES: Readonly<Record<string, string>> = {
  chess: 'chess',
  standard: 'chess',
  kingofthehill: 'kingofthehill',
  atomic: 'atomic',
  crazyhouse: 'crazyhouse',
  threecheck: '3check',
  horde: 'horde',
  racingkings: 'racingkings',
};

/** Fairy-Stockfish: the variant engine. Selects variants via `UCI_Variant`. */
export const fairyStockfishPlugin: EnginePlugin = {
  id: 'fairy-stockfish',
  displayName: 'Fairy-Stockfish',
  minVersion: '14',
  expectedVariants: [
    'chess',
    'chess960',
    'kingofthehill',
    'atomic',
    'crazyhouse',
    'threecheck',
    'horde',
    'racingkings',
  ],
  variantSetup(variant: string): readonly EngineOption[] {
    if (variant === 'chess960') {
      return [
        { name: 'UCI_Variant', value: 'chess' },
        { name: 'UCI_Chess960', value: true },
      ];
    }
    const fairyName = FAIRY_VARIANT_NAMES[variant] ?? variant;
    return [{ name: 'UCI_Variant', value: fairyName }];
  },
  createInstance(transport, options) {
    return makeUciInstance(this.minVersion, transport, options);
  },
};

/** The engines registered by the default composition root. */
export const builtinPlugins: readonly EnginePlugin[] = [stockfishPlugin, fairyStockfishPlugin];
