/**
 * One live engine worker: the UCI state machine over a single {@link EngineTransport}.
 * Owns the handshake (`uci`/`uciok`, capability discovery, `isready`/`readyok`), one
 * search at a time (analyze/play), cooperative cancellation (`stop`), a per-search
 * watchdog, crash detection, and graceful `quit`. Transport-agnostic: identical logic
 * runs against a native subprocess and the deterministic fake.
 */
import type { Clock, TimerHandle } from './clock.js';
import { SystemClock } from './clock.js';
import type { EngineTransport } from './transport.js';
import type { AnalysisLimits, EngineCapabilities, EngineConfig, EngineResult, Evaluation, UciOptionSpec } from './types.js';
import type { PlayResult, StrengthSpec } from './provider.js';
import { buildCapabilities, negotiateVersion } from './capabilities.js';
import {
  buildGoCommand,
  buildPositionCommand,
  buildSetOption,
  parseBestMove,
  parseIdLine,
  parseInfoLine,
  parseOptionLine,
  type ParsedInfoLine,
} from './uci/protocol.js';
import { CancelledError, EngineCrashError, EngineError, EngineTimeoutError } from './errors.js';

export interface EngineOption {
  readonly name: string;
  readonly value?: string | number | boolean;
}

export interface AnalyzeParams {
  readonly fen: string;
  readonly limits: AnalysisLimits;
  readonly multiPv: number;
  /** Options (variant selection, strength) applied via `setoption` before the search. */
  readonly setup?: readonly EngineOption[];
  readonly signal?: AbortSignal;
}

export interface PlayParams extends AnalyzeParams {
  readonly strength?: StrengthSpec;
}

export interface DeadInfo {
  /** True when the worker exited because we asked it to (`dispose`); false on a crash/watchdog kill. */
  readonly expected: boolean;
  readonly error?: EngineCrashError;
}

export interface EngineInstanceOptions {
  readonly id: string;
  readonly config?: EngineConfig;
  readonly clock?: Clock;
  /** Max ms with no engine output during a search before it is presumed hung and killed. */
  readonly watchdogMs?: number;
  /** Max ms for each handshake phase. */
  readonly initTimeoutMs?: number;
  /** Grace period after `quit` before a hard kill during dispose. */
  readonly quitGraceMs?: number;
  /** Reject initialization if the engine reports a version below this floor. */
  readonly minVersion?: string;
}

export interface EngineInstance {
  readonly id: string;
  readonly alive: boolean;
  readonly busy: boolean;
  readonly jobsCompleted: number;
  readonly lastReadyOkMs: number | null;
  readonly capabilities: EngineCapabilities;
  init(): Promise<EngineCapabilities>;
  analyze(params: AnalyzeParams): Promise<readonly EngineResult[]>;
  play(params: PlayParams): Promise<PlayResult>;
  dispose(): Promise<void>;
  onDead(listener: (info: DeadInfo) => void): void;
}

type State = 'new' | 'initializing' | 'ready' | 'busy' | 'dead';

interface LineConsumer {
  feed(line: string): void;
  fail(error: unknown): void;
}

function clampToSpec(value: number, spec: UciOptionSpec | undefined): number {
  if (!spec) return value;
  let result = value;
  if (spec.min !== undefined) result = Math.max(result, spec.min);
  if (spec.max !== undefined) result = Math.min(result, spec.max);
  return result;
}

function infoToResult(info: ParsedInfoLine, fallbackTimeMs: number): EngineResult {
  const evaluation: Evaluation =
    info.scoreMate !== undefined ? { type: 'mate', value: info.scoreMate } : { type: 'cp', value: info.scoreCp ?? 0 };
  return {
    multipv: info.multipv ?? 1,
    evaluation,
    ...(info.scoreBound !== undefined ? { evaluationBound: info.scoreBound } : {}),
    principalVariation: info.pv ?? [],
    depth: info.depth ?? 0,
    ...(info.selDepth !== undefined ? { selDepth: info.selDepth } : {}),
    nodes: info.nodes ?? 0,
    nps: info.nps ?? 0,
    timeMs: info.timeMs ?? fallbackTimeMs,
  };
}

export class UciEngineInstance implements EngineInstance {
  readonly id: string;
  private readonly transport: EngineTransport;
  private readonly clock: Clock;
  private readonly config: EngineConfig;
  private readonly watchdogMs: number;
  private readonly initTimeoutMs: number;
  private readonly quitGraceMs: number;
  private readonly minVersion: string | undefined;

  private state: State = 'new';
  private capabilitiesValue: EngineCapabilities | undefined;
  private current: LineConsumer | null = null;
  private readonly deadListeners: Array<(info: DeadInfo) => void> = [];

  private idName = '';
  private idAuthor = '';
  private readonly optionSpecs: UciOptionSpec[] = [];

  private jobs = 0;
  private lastReadyOk: number | null = null;
  private disposing = false;
  private disposeResolve: (() => void) | null = null;
  private disposeKillTimer: TimerHandle | null = null;

  constructor(transport: EngineTransport, options: EngineInstanceOptions) {
    this.transport = transport;
    this.id = options.id;
    this.config = options.config ?? {};
    this.clock = options.clock ?? new SystemClock();
    this.watchdogMs = options.watchdogMs ?? 15_000;
    this.initTimeoutMs = options.initTimeoutMs ?? 10_000;
    this.quitGraceMs = options.quitGraceMs ?? 2_000;
    this.minVersion = options.minVersion;
    this.transport.onLine((line) => this.handleLine(line));
    this.transport.onExit((code, signal) => this.handleExit(code, signal));
  }

  get alive(): boolean {
    return this.state !== 'dead';
  }

  get busy(): boolean {
    return this.state === 'busy';
  }

  get jobsCompleted(): number {
    return this.jobs;
  }

  get lastReadyOkMs(): number | null {
    return this.lastReadyOk;
  }

  get capabilities(): EngineCapabilities {
    if (!this.capabilitiesValue) throw new EngineError('not_initialized', `Engine ${this.id} is not initialized.`);
    return this.capabilitiesValue;
  }

  onDead(listener: (info: DeadInfo) => void): void {
    this.deadListeners.push(listener);
  }

  async init(): Promise<EngineCapabilities> {
    if (this.state !== 'new') throw new EngineError('protocol', `Engine ${this.id} already initialized.`);
    this.state = 'initializing';

    await this.runConsumer(
      this.initTimeoutMs,
      (line, done) => {
        const id = parseIdLine(line);
        if (id) {
          if (id.field === 'name') this.idName = id.value;
          else this.idAuthor = id.value;
          return;
        }
        const option = parseOptionLine(line);
        if (option) {
          this.optionSpecs.push(option);
          return;
        }
        if (line.trim() === 'uciok') done();
      },
      () => this.transport.send('uci'),
    );

    this.capabilitiesValue = buildCapabilities(this.idName, this.idAuthor, this.optionSpecs);
    if (this.minVersion) negotiateVersion(this.capabilitiesValue, this.minVersion);

    this.applyConfig();
    await this.awaitReady();

    this.state = 'ready';
    return this.capabilitiesValue;
  }

  async analyze(params: AnalyzeParams): Promise<readonly EngineResult[]> {
    return this.search(params);
  }

  async play(params: PlayParams): Promise<PlayResult> {
    const results = await this.search(params, this.strengthSetup(params.strength));
    const best = this.lastBestMove;
    if (!best) throw new EngineError('protocol', 'Engine returned no move.');
    const line = results.length > 0 ? results[0] : undefined;
    return {
      move: best.best,
      ...(best.ponder !== undefined ? { ponder: best.ponder } : {}),
      ...(line !== undefined ? { line } : {}),
    };
  }

  async dispose(): Promise<void> {
    if (this.state === 'dead') return;
    this.disposing = true;
    await new Promise<void>((resolve) => {
      this.disposeResolve = resolve;
      this.transport.send('quit');
      this.disposeKillTimer = this.clock.setTimeout(() => this.transport.kill(), this.quitGraceMs);
    });
  }

  // --- internals ---

  private lastBestMove: { best: string; ponder?: string } | null = null;

  private strengthSetup(strength: StrengthSpec | undefined): readonly EngineOption[] {
    if (!strength || !this.capabilitiesValue) return [];
    const caps = this.capabilitiesValue;
    const options: EngineOption[] = [];
    if (strength.elo !== undefined && caps.supportsLimitStrength) {
      options.push({ name: 'UCI_LimitStrength', value: true });
      if (caps.options.has('UCI_Elo')) {
        options.push({ name: 'UCI_Elo', value: Math.round(clampToSpec(strength.elo, caps.options.get('UCI_Elo'))) });
      }
    } else if (strength.skill !== undefined && caps.supportsSkillLevel) {
      options.push({ name: 'Skill Level', value: Math.round(clampToSpec(strength.skill, caps.options.get('Skill Level'))) });
    }
    return options;
  }

  private async search(params: AnalyzeParams, extraSetup: readonly EngineOption[] = []): Promise<readonly EngineResult[]> {
    if (this.state === 'dead') throw new EngineCrashError(`Engine ${this.id} is dead.`);
    if (this.state !== 'ready') throw new EngineError('protocol', `Engine ${this.id} is not ready (state=${this.state}).`);
    if (params.signal?.aborted) throw new CancelledError();

    this.state = 'busy';
    try {
      // Always pin MultiPV for this search so a prior multi-line search cannot leak
      // extra lines into a later single-line request (stale-option bug). Validate it before sending
      // any variant or strength setup: a rejected request must not leave unacknowledged `setoption`
      // commands on a worker that `finally` returns to the ready pool.
      const multiPvSpec = this.capabilitiesValue?.options.get('MultiPV');
      if (params.multiPv > 1 && !this.capabilitiesValue?.supportsMultiPv) {
        throw new EngineError('protocol', `Engine ${this.id} cannot honor MultiPV ${params.multiPv}.`);
      }
      const appliedMultiPv = this.capabilitiesValue?.supportsMultiPv
        ? clampToSpec(Math.max(1, params.multiPv), multiPvSpec)
        : params.multiPv;
      if (appliedMultiPv !== params.multiPv) {
        throw new EngineError('protocol', `Engine ${this.id} cannot honor MultiPV ${params.multiPv}.`);
      }

      const setup = [...extraSetup, ...(params.setup ?? [])];
      let applied = this.applyOptions(setup);
      if (this.capabilitiesValue?.supportsMultiPv) {
        this.transport.send(buildSetOption('MultiPV', appliedMultiPv));
        applied = true;
      }

      if (applied) await this.awaitReady();

      const results = await this.runSearch(params);
      this.jobs += 1;
      return results;
    } finally {
      if (this.state === 'busy') this.state = 'ready';
    }
  }

  private runSearch(params: AnalyzeParams): Promise<readonly EngineResult[]> {
    return new Promise<readonly EngineResult[]>((resolve, reject) => {
      const linesByMultipv = new Map<number, ParsedInfoLine>();
      const startMs = this.clock.now();
      let settled = false;
      let cancelling = false;
      let watchdog: TimerHandle | null = null;

      const signal = params.signal;
      const onAbort = (): void => {
        if (settled || cancelling) return;
        cancelling = true;
        this.transport.send('stop');
      };

      const cleanup = (): void => {
        if (watchdog) this.clock.clearTimeout(watchdog);
        if (signal) signal.removeEventListener('abort', onAbort);
        this.current = null;
      };

      const armWatchdog = (): void => {
        if (watchdog) this.clock.clearTimeout(watchdog);
        watchdog = this.clock.setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          this.killDead();
          reject(new EngineTimeoutError(`Engine ${this.id} produced no output for ${this.watchdogMs}ms during search.`));
        }, this.watchdogMs);
      };

      this.current = {
        feed: (line) => {
          armWatchdog();
          const best = parseBestMove(line);
          if (best) {
            settled = true;
            cleanup();
            this.lastBestMove = best;
            if (cancelling) {
              reject(new CancelledError());
            } else {
              resolve(this.assembleResults(linesByMultipv, this.clock.now() - startMs, best));
            }
            return;
          }
          const info = parseInfoLine(line);
          if (info && (info.scoreCp !== undefined || info.scoreMate !== undefined || (info.pv && info.pv.length > 0))) {
            linesByMultipv.set(info.multipv ?? 1, info);
          }
        },
        fail: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      };

      armWatchdog();
      this.transport.send(buildPositionCommand(params.fen));
      this.transport.send(buildGoCommand(params.limits));
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private assembleResults(
    linesByMultipv: Map<number, ParsedInfoLine>,
    totalMs: number,
    best: { best: string },
  ): readonly EngineResult[] {
    const multipvs = [...linesByMultipv.keys()].sort((a, b) => a - b);
    const results = multipvs.map((mp) => infoToResult(linesByMultipv.get(mp) as ParsedInfoLine, totalMs));
    if (results.length === 0) {
      // No scored info (e.g. an instant book/terminal reply). Emit a minimal result.
      results.push({
        multipv: 1,
        evaluation: { type: 'cp', value: 0 },
        principalVariation: best.best === '(none)' ? [] : [best.best],
        depth: 0,
        nodes: 0,
        nps: 0,
        timeMs: totalMs,
      });
    }
    return results;
  }

  private applyConfig(): void {
    const caps = this.capabilitiesValue;
    if (!caps) return;
    if (this.config.threads !== undefined && caps.options.has('Threads')) {
      this.transport.send(buildSetOption('Threads', clampToSpec(this.config.threads, caps.options.get('Threads'))));
    }
    if (this.config.hashMb !== undefined && caps.options.has('Hash')) {
      this.transport.send(buildSetOption('Hash', clampToSpec(this.config.hashMb, caps.options.get('Hash'))));
    }
    if (this.config.options) {
      for (const [name, value] of Object.entries(this.config.options)) {
        const spec = caps.options.get(name);
        // Clamped on this route too: `analysisCacheFingerprint` gives `{ threads: n }` and
        // `{ options: { Threads: n } }` one identity, so they must apply one value.
        if (spec) this.transport.send(buildSetOption(name, typeof value === 'number' ? clampToSpec(value, spec) : value));
      }
    }
  }

  /** Sends only options the engine actually advertises; returns true if any were sent. */
  private applyOptions(options: readonly EngineOption[]): boolean {
    const caps = this.capabilitiesValue;
    let sent = false;
    for (const option of options) {
      if (caps && !caps.options.has(option.name)) continue;
      this.transport.send(buildSetOption(option.name, option.value));
      sent = true;
    }
    return sent;
  }

  private awaitReady(): Promise<void> {
    return this.runConsumer(
      this.initTimeoutMs,
      (line, done) => {
        if (line.trim() === 'readyok') {
          this.lastReadyOk = this.clock.now();
          done();
        }
      },
      () => this.transport.send('isready'),
    );
  }

  private runConsumer(
    timeoutMs: number,
    onLine: (line: string, done: () => void) => void,
    start: () => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(watchdog);
        this.current = null;
        resolve();
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(watchdog);
        this.current = null;
        reject(error);
      };
      const watchdog = this.clock.setTimeout(() => {
        this.killDead();
        fail(new EngineTimeoutError(`Engine ${this.id} timed out during handshake after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.current = { feed: (line) => onLine(line, done), fail };
      start();
    });
  }

  private handleLine(line: string): void {
    if (this.current) this.current.feed(line);
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.state === 'dead') return;
    const expected = this.disposing;
    this.state = 'dead';

    if (this.disposeKillTimer) {
      this.clock.clearTimeout(this.disposeKillTimer);
      this.disposeKillTimer = null;
    }

    const error = expected
      ? undefined
      : new EngineCrashError(`Engine ${this.id} exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`);

    if (this.current && error) {
      const consumer = this.current;
      this.current = null;
      consumer.fail(error);
    }

    for (const listener of [...this.deadListeners]) listener({ expected, ...(error ? { error } : {}) });

    if (this.disposeResolve) {
      const resolve = this.disposeResolve;
      this.disposeResolve = null;
      resolve();
    }
  }

  private killDead(): void {
    if (this.state === 'dead') return;
    this.transport.kill();
  }
}
