/**
 * Production {@link EngineTransport} backed by a native engine subprocess.
 *
 * Security posture (see ENGINE_BRIDGE.md §9): the binary is spawned with a fixed argv
 * and **no shell** (no command injection surface), an empty environment by default
 * (the caller opts into any vars), `windowsHide`, and piped stdio. stdout is line-
 * buffered; recent stderr is retained in a bounded ring for crash diagnostics only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { EngineTransport, ExitListener, LineListener } from './transport.js';

export interface ChildProcessTransportOptions {
  readonly binaryPath: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Max bytes of recent stderr retained for diagnostics (default 8 KiB). */
  readonly stderrRingBytes?: number;
}

export class ChildProcessTransport implements EngineTransport {
  private readonly child: ChildProcess;
  private readonly lineListeners: LineListener[] = [];
  private readonly exitListeners: ExitListener[] = [];
  private readonly stderrRingBytes: number;
  private stdoutBuffer = '';
  private stderrTail = '';
  private exited = false;

  constructor(options: ChildProcessTransportOptions) {
    this.stderrRingBytes = options.stderrRingBytes ?? 8192;
    this.child = spawn(options.binaryPath, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ?? {},
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.on('data', (chunk: string) => this.appendStderr(chunk));
    this.child.on('exit', (code, signal) => this.handleExit(code, signal));
    this.child.on('error', (err: Error) => {
      this.appendStderr(`\n[spawn error] ${err.message}`);
      this.handleExit(null, null);
    });
  }

  send(line: string): void {
    if (this.exited) return;
    this.child.stdin?.write(`${line}\n`);
  }

  onLine(listener: LineListener): void {
    this.lineListeners.push(listener);
  }

  onExit(listener: ExitListener): void {
    this.exitListeners.push(listener);
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    if (this.exited) return;
    this.child.kill(signal);
  }

  /** Recent stderr for inclusion in crash diagnostics. */
  stderrDiagnostics(): string {
    return this.stderrTail;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.length > 0) {
        for (const listener of [...this.lineListeners]) listener(line);
      }
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  private appendStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-this.stderrRingBytes);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }
}
