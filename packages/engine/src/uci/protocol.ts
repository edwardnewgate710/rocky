/**
 * Pure UCI (Universal Chess Interface) codec: parse engine output lines and build
 * command lines. No I/O, no state — every function is total and side-effect free, so
 * it is trivially unit-testable and shared by the real and fake transports.
 */
import type { AnalysisLimits, UciOptionSpec, UciOptionType } from '../types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface ParsedInfoLine {
  readonly depth?: number;
  readonly selDepth?: number;
  readonly multipv?: number;
  readonly scoreCp?: number;
  readonly scoreMate?: number;
  readonly nodes?: number;
  readonly nps?: number;
  readonly timeMs?: number;
  readonly pv?: readonly string[];
}

export interface ParsedBestMove {
  readonly best: string;
  readonly ponder?: string;
}

export interface ParsedIdLine {
  readonly field: 'name' | 'author';
  readonly value: string;
}

function toInt(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const n = Number(token);
  return Number.isInteger(n) ? n : undefined;
}

/** Parse an `info ...` line. Returns `null` for non-info lines (e.g. `info string ...`). */
export function parseInfoLine(line: string): ParsedInfoLine | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info') return null;

  const out: Mutable<ParsedInfoLine> = {};
  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth': out.depth = toInt(tokens[++i]); break;
      case 'seldepth': out.selDepth = toInt(tokens[++i]); break;
      case 'multipv': out.multipv = toInt(tokens[++i]); break;
      case 'nodes': out.nodes = toInt(tokens[++i]); break;
      case 'nps': out.nps = toInt(tokens[++i]); break;
      case 'time': out.timeMs = toInt(tokens[++i]); break;
      case 'score': {
        const kind = tokens[++i];
        const value = toInt(tokens[++i]);
        if (value !== undefined && kind === 'cp') out.scoreCp = value;
        else if (value !== undefined && kind === 'mate') out.scoreMate = value;
        break;
      }
      case 'pv':
        out.pv = tokens.slice(i + 1);
        return out;
      case 'string':
        return null; // human-readable diagnostic line; no structured content
      default:
        break; // ignore currmove, hashfull, tbhits, cpuload, etc.
    }
  }
  return out;
}

/** Parse a `bestmove <move> [ponder <move>]` line, or `null` if not a bestmove line. */
export function parseBestMove(line: string): ParsedBestMove | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'bestmove' || !tokens[1]) return null;
  const result: Mutable<ParsedBestMove> = { best: tokens[1] };
  if (tokens[2] === 'ponder' && tokens[3]) result.ponder = tokens[3];
  return result;
}

/** Parse an `id name ...` / `id author ...` line. */
export function parseIdLine(line: string): ParsedIdLine | null {
  const match = /^id\s+(name|author)\s+(.+)$/.exec(line.trim());
  if (!match) return null;
  return { field: match[1] as 'name' | 'author', value: match[2].trim() };
}

/** Parse an `option name <N> type <T> ...` line into a structured {@link UciOptionSpec}. */
export function parseOptionLine(line: string): UciOptionSpec | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('option ')) return null;

  const head = /\bname\s+(.+?)\s+type\s+(check|spin|combo|button|string)\b/.exec(trimmed);
  if (!head) return null;

  const spec: Mutable<UciOptionSpec> = { name: head[1].trim(), type: head[2] as UciOptionType };

  const def = /\bdefault\s+(.*?)(?=\s+(?:min|max|var)\s|$)/.exec(trimmed);
  if (def) spec.default = def[1].trim();

  const min = /\bmin\s+(-?\d+)\b/.exec(trimmed);
  if (min) spec.min = Number(min[1]);

  const max = /\bmax\s+(-?\d+)\b/.exec(trimmed);
  if (max) spec.max = Number(max[1]);

  const vars = [...trimmed.matchAll(/\bvar\s+(.+?)(?=\s+var\s|$)/g)].map((m) => m[1].trim());
  if (vars.length > 0) spec.vars = vars;

  return spec;
}

/** Build a `position fen <FEN> [moves ...]` command. */
export function buildPositionCommand(fen: string, moves?: readonly string[]): string {
  const base = `position fen ${fen}`;
  return moves && moves.length > 0 ? `${base} moves ${moves.join(' ')}` : base;
}

/**
 * Build a bounded `go` command. A bare `go` means *infinite* search in UCI, so if no
 * limit is supplied we floor to `depth 1` — the bridge must never launch an unbounded
 * search by accident. `searchmoves` restricts the root move list when provided.
 */
export function buildGoCommand(limits: AnalysisLimits, searchmoves?: readonly string[]): string {
  const parts: string[] = ['go'];
  if (limits.depth !== undefined) parts.push('depth', String(limits.depth));
  if (limits.nodes !== undefined) parts.push('nodes', String(limits.nodes));
  if (limits.timeMs !== undefined) parts.push('movetime', String(limits.timeMs));
  if (parts.length === 1) parts.push('depth', '1');
  if (searchmoves && searchmoves.length > 0) parts.push('searchmoves', ...searchmoves);
  return parts.join(' ');
}

/** Build a `setoption name <N> value <V>` command (buttons omit the value). */
export function buildSetOption(name: string, value?: string | number | boolean): string {
  return value === undefined
    ? `setoption name ${name}`
    : `setoption name ${name} value ${String(value)}`;
}
