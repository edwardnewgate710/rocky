/**
 * Composition root helpers for a production {@link EngineManager} backed by native
 * subprocesses. This is the only place that couples the manager to real binaries and the
 * {@link ChildProcessTransport}; it stays dependency-free (Node built-ins only). The
 * deployable service (M14) may inject a `@chess-platform/core`-backed {@link FenValidator}
 * for authoritative legality; the structural validator is the safe default.
 */
import { ChildProcessTransport } from './child-process-transport.js';
import { EngineManager, type EngineManagerOptions } from './manager.js';
import { builtinPlugins, type EnginePlugin } from './plugin.js';
import { EngineError } from './errors.js';

export interface ResolvedBinary {
  readonly binaryPath: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

/** Resolves an engine plugin id to a concrete binary invocation. */
export interface BinaryResolver {
  resolve(pluginId: string): ResolvedBinary;
}

/**
 * Resolves binaries from an explicit override map, falling back to environment variables
 * (`STOCKFISH_PATH`, `FAIRY_STOCKFISH_PATH`, or `<PLUGIN_ID>_PATH`).
 */
export class EnvBinaryResolver implements BinaryResolver {
  private readonly overrides: Readonly<Record<string, ResolvedBinary>>;

  constructor(overrides: Readonly<Record<string, ResolvedBinary>> = {}) {
    this.overrides = overrides;
  }

  resolve(pluginId: string): ResolvedBinary {
    const override = this.overrides[pluginId];
    if (override) return override;
    const envKey = `${pluginId.replace(/-/g, '_').toUpperCase()}_PATH`;
    const path = process.env[envKey];
    if (!path) {
      throw new EngineError('not_initialized', `No binary configured for engine "${pluginId}" (set ${envKey} or pass an override).`);
    }
    return { binaryPath: path };
  }
}

export interface CreateEngineManagerOptions extends Omit<EngineManagerOptions, 'transportFactory'> {
  /** Binary resolver; defaults to {@link EnvBinaryResolver}. */
  readonly resolver?: BinaryResolver;
  /** Plugins to register; defaults to the built-in Stockfish + Fairy-Stockfish. */
  readonly plugins?: readonly EnginePlugin[];
}

/**
 * Build a production {@link EngineManager} wired to native engines via
 * {@link ChildProcessTransport}, with the built-in plugins registered. Workers warm on
 * first use unless {@link EngineManager.warmup} is called.
 */
export function createEngineManager(options: CreateEngineManagerOptions = {}): EngineManager {
  const resolver = options.resolver ?? new EnvBinaryResolver();
  const plugins = options.plugins ?? builtinPlugins;

  const { resolver: _resolver, plugins: _plugins, ...managerOptions } = options;
  void _resolver;
  void _plugins;

  const manager = new EngineManager({
    ...managerOptions,
    transportFactory: (plugin) => {
      const binary = resolver.resolve(plugin.id);
      return new ChildProcessTransport({
        binaryPath: binary.binaryPath,
        ...(binary.args !== undefined ? { args: binary.args } : {}),
        ...(binary.env !== undefined ? { env: binary.env } : {}),
      });
    },
  });

  for (const plugin of plugins) manager.register(plugin);
  return manager;
}
