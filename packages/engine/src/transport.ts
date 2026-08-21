/**
 * The I/O isolation boundary. An {@link EngineTransport} is the *only* object that
 * touches a worker's actual I/O — line in, line out, exit, kill. Everything above it
 * (instance state machine, pool, manager) is transport-agnostic, which is what lets
 * the same domain code run against a native subprocess in production and a
 * deterministic fake in CI. Additional transports (WASM, remote worker) implement the
 * same three methods.
 */

export type ExitListener = (code: number | null, signal: string | null) => void;
export type LineListener = (line: string) => void;

export interface EngineTransport {
  /** Write one command line to the engine (the transport appends the newline). */
  send(line: string): void;
  /** Register a listener for each complete output line. */
  onLine(listener: LineListener): void;
  /** Register a listener for process exit (natural or killed). */
  onExit(listener: ExitListener): void;
  /** Forcibly terminate the worker. Idempotent. */
  kill(signal?: NodeJS.Signals): void;
}

/** A scripted response to a `go` command. */
export interface FakeGoResponse {
  readonly info?: readonly string[];
  readonly bestmove: string;
  readonly ponder?: string;
}

/**
 * Decides how the fake answers a search. Return a {@link FakeGoResponse} to emit info
 * lines then `bestmove`, or `'hang'` to stay silent (used to exercise cancellation and
 * the watchdog).
 */
export type FakeGoHandler = (goCommand: string, positionFen: string | null) => FakeGoResponse | 'hang';

export interface FakeEngineOptions {
  readonly name?: string;
  readonly author?: string;
  /** Raw `option ...` lines to advertise; a sensible Stockfish-like default is used otherwise. */
  readonly optionLines?: readonly string[];
  /** Convenience: advertise these as a `UCI_Variant` combo (in addition to `chess`). */
  readonly variants?: readonly string[];
  readonly go?: FakeGoHandler;
  /** Default bestmove when no `go` handler is supplied (or a hung search is stopped). */
  readonly bestmove?: string;
  /** If true, never answer `isready` — exercises the initialization watchdog. */
  readonly hangOnReady?: boolean;
}

const DEFAULT_OPTIONS: readonly string[] = [
  'option name Threads type spin default 1 min 1 max 512',
  'option name Hash type spin default 16 min 1 max 33554432',
  'option name MultiPV type spin default 1 min 1 max 256',
  'option name Ponder type check default false',
  'option name UCI_LimitStrength type check default false',
  'option name UCI_Elo type spin default 1320 min 1320 max 3190',
  'option name Skill Level type spin default 20 min 0 max 20',
];

/**
 * Fully deterministic in-process transport for tests. It emits output on microtasks
 * (never real timers), so awaited operations resolve without touching the clock, while
 * `'hang'` responses let a test drive the watchdog via a {@link Clock} it controls.
 */
export class FakeEngineTransport implements EngineTransport {
  /** Commands accepted by the fake, exposed so protocol-ordering tests can make assertions. */
  readonly sent: string[] = [];
  private readonly lineListeners: LineListener[] = [];
  private readonly exitListeners: ExitListener[] = [];
  private readonly options: FakeEngineOptions;
  private lastPositionFen: string | null = null;
  private searching = false;
  private exited = false;

  constructor(options: FakeEngineOptions = {}) {
    this.options = options;
  }

  send(line: string): void {
    if (this.exited) return;
    this.sent.push(line);
    const trimmed = line.trim();
    const verb = trimmed.split(/\s+/, 1)[0];

    switch (verb) {
      case 'uci':
        this.handleUci();
        break;
      case 'isready':
        if (!this.options.hangOnReady) this.emit('readyok');
        break;
      case 'position':
        this.lastPositionFen = this.extractFen(trimmed);
        break;
      case 'go':
        this.handleGo(trimmed);
        break;
      case 'stop':
        if (this.searching) {
          this.searching = false;
          this.emit(`bestmove ${this.options.bestmove ?? '(none)'}`);
        }
        break;
      case 'quit':
        this.emitExit(0, null);
        break;
      default:
        break; // ucinewgame, setoption, debug, etc. — no observable response
    }
  }

  onLine(listener: LineListener): void {
    this.lineListeners.push(listener);
  }

  onExit(listener: ExitListener): void {
    this.exitListeners.push(listener);
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.emitExit(null, signal);
  }

  /** Test hook: simulate an unexpected crash (non-kill exit). */
  simulateCrash(code = 1): void {
    this.emitExit(code, null);
  }

  private handleUci(): void {
    this.emit(`id name ${this.options.name ?? 'FakeEngine 1.0'}`);
    this.emit(`id author ${this.options.author ?? 'chess-platform'}`);
    const optionLines = this.options.optionLines ?? DEFAULT_OPTIONS;
    for (const opt of optionLines) this.emit(opt);
    if (this.options.variants && this.options.variants.length > 0) {
      const vars = ['chess', ...this.options.variants].map((v) => `var ${v}`).join(' ');
      this.emit(`option name UCI_Variant type combo default chess ${vars}`);
    }
    this.emit('uciok');
  }

  private handleGo(goCommand: string): void {
    const response = this.options.go
      ? this.options.go(goCommand, this.lastPositionFen)
      : ({ bestmove: this.options.bestmove ?? 'e2e4' } satisfies FakeGoResponse);

    if (response === 'hang') {
      this.searching = true;
      return;
    }

    this.searching = true;
    for (const info of response.info ?? []) this.emit(info);
    this.searching = false;
    const ponder = response.ponder ? ` ponder ${response.ponder}` : '';
    this.emit(`bestmove ${response.bestmove}${ponder}`);
  }

  private extractFen(positionCommand: string): string | null {
    const match = /^position\s+fen\s+(.+?)(?:\s+moves\s+.*)?$/.exec(positionCommand);
    if (match) return match[1].trim();
    return positionCommand.includes('startpos') ? 'startpos' : null;
  }

  private emit(line: string): void {
    queueMicrotask(() => {
      if (this.exited) return;
      for (const listener of [...this.lineListeners]) listener(line);
    });
  }

  private emitExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    queueMicrotask(() => {
      for (const listener of [...this.exitListeners]) listener(code, signal);
    });
  }
}
