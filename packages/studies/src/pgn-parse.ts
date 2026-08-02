import { PgnParseError, StudyRuleError } from './errors';
import type { PgnGame, PgnMoveNode, PgnTag } from './pgn-model';
import {
  isPgnResult,
  MAX_GAMES_PER_IMPORT,
  MAX_PGN_BYTES,
  MAX_VARIATION_DEPTH,
} from './pgn-model';

/**
 * A mutable node used only while building. The public `PgnMoveNode` is readonly, and the
 * difference matters: callers get a tree they cannot accidentally reshape, while the parser gets
 * to append as it walks.
 */
interface MutableNode {
  san: string;
  nags: number[];
  comments: string[];
  variations: MutableNode[][];
}

function freeze(nodes: readonly MutableNode[]): readonly PgnMoveNode[] {
  return nodes.map((n) => ({
    san: n.san,
    nags: [...n.nags],
    comments: [...n.comments],
    variations: n.variations.map(freeze),
  }));
}

/**
 * Parses PGN into games. Total: every input either produces games or throws a `PgnParseError`
 * that says where it stopped making sense. It never returns a partial game, because a silently
 * truncated import is worse than a rejected one — the person who uploaded it would never know.
 */
export function parsePgn(input: string): readonly PgnGame[] {
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > MAX_PGN_BYTES) {
    throw new StudyRuleError(
      'too_large',
      `PGN is ${bytes} bytes, over the ${MAX_PGN_BYTES}-byte limit`
    );
  }

  const parser = new PgnParser(input);
  const games: PgnGame[] = [];

  for (;;) {
    parser.skipTrivia();
    if (parser.atEnd()) {
      break;
    }
    if (games.length >= MAX_GAMES_PER_IMPORT) {
      throw new StudyRuleError(
        'too_large',
        `PGN contains more than ${MAX_GAMES_PER_IMPORT} games`
      );
    }
    games.push(parser.parseGame());
  }

  return games;
}

class PgnParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  atEnd(): boolean {
    return this.pos >= this.src.length;
  }

  /**
   * Skips whitespace and `;` rest-of-line comments.
   *
   * `%` escapes are only meaningful at the very start of a line — the spec is explicit about that,
   * and treating a `%` mid-token as a comment would silently eat legal movetext.
   */
  skipTrivia(): void {
    for (;;) {
      const before = this.pos;
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) {
        this.pos++;
      }
      const ch = this.src[this.pos];
      if (ch === ';' || (ch === '%' && this.atLineStart())) {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') {
          this.pos++;
        }
      }
      if (this.pos === before) {
        return;
      }
    }
  }

  private atLineStart(): boolean {
    return this.pos === 0 || this.src[this.pos - 1] === '\n';
  }

  parseGame(): PgnGame {
    const tags = this.parseTags();
    const preComments: string[] = [];
    this.collectComments(preComments);

    const moves: MutableNode[] = [];
    const result = this.parseMovetext(moves, 0);

    return {
      tags,
      preComments,
      moves: freeze(moves),
      result,
    };
  }

  private parseTags(): PgnTag[] {
    const tags: PgnTag[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.src[this.pos] !== '[') {
        return tags;
      }
      const open = this.pos;
      this.pos++; // '['
      this.skipTrivia();

      const keyStart = this.pos;
      while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos]!)) {
        this.pos++;
      }
      const key = this.src.slice(keyStart, this.pos);
      if (key.length === 0) {
        throw new PgnParseError('Tag name expected', open);
      }

      this.skipTrivia();
      if (this.src[this.pos] !== '"') {
        throw new PgnParseError(`Tag '${key}' has no quoted value`, this.pos);
      }
      const value = this.readQuotedString();

      this.skipTrivia();
      if (this.src[this.pos] !== ']') {
        throw new PgnParseError(`Tag '${key}' is not closed`, this.pos);
      }
      this.pos++; // ']'
      tags.push({ key, value });
    }
  }

  /** Reads a `"..."` value, honouring the only two escapes PGN defines: `\\"` and `\\\\`. */
  private readQuotedString(): string {
    const open = this.pos;
    this.pos++; // opening quote
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos]!;
      if (ch === '\\') {
        const next = this.src[this.pos + 1];
        if (next === '"' || next === '\\') {
          out += next;
          this.pos += 2;
          continue;
        }
        // Any other backslash is a literal backslash; PGN defines no other escape, and rejecting
        // it would fail on real-world exports that contain Windows paths in a tag.
        out += ch;
        this.pos++;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === '\n') {
        throw new PgnParseError('Tag value is not closed before end of line', open);
      }
      out += ch;
      this.pos++;
    }
    throw new PgnParseError('Tag value is not closed before end of input', open);
  }

  /** Consumes any run of `{...}` comments into `sink`. */
  private collectComments(sink: string[]): void {
    for (;;) {
      this.skipTrivia();
      if (this.src[this.pos] !== '{') {
        return;
      }
      const open = this.pos;
      this.pos++;
      const start = this.pos;
      while (this.pos < this.src.length && this.src[this.pos] !== '}') {
        this.pos++;
      }
      if (this.pos >= this.src.length) {
        throw new PgnParseError('Comment is not closed before end of input', open);
      }
      sink.push(this.src.slice(start, this.pos).trim());
      this.pos++; // '}'
    }
  }

  /**
   * Parses movetext into `out`, returning the result token.
   *
   * Depth is threaded through rather than tracked on the instance so a variation cannot leak its
   * depth to a sibling; `MAX_VARIATION_DEPTH` is what stops a file of open parens from becoming a
   * stack overflow instead of a parse error.
   */
  private parseMovetext(out: MutableNode[], depth: number): string {
    if (depth > MAX_VARIATION_DEPTH) {
      throw new PgnParseError(
        `Variations nested deeper than ${MAX_VARIATION_DEPTH}`,
        this.pos
      );
    }

    for (;;) {
      this.skipTrivia();
      if (this.atEnd()) {
        // A game may legally end without a result token in the wild; treat it as unfinished
        // rather than rejecting a file that is otherwise well-formed.
        return '*';
      }

      const ch = this.src[this.pos]!;

      if (ch === '{') {
        this.collectComments(this.lastOf(out)?.comments ?? []);
        continue;
      }

      if (ch === '(') {
        const parent = this.lastOf(out);
        if (!parent) {
          throw new PgnParseError('Variation before any move', this.pos);
        }
        this.pos++; // '('
        const branch: MutableNode[] = [];
        const inner = this.parseMovetext(branch, depth + 1);
        if (inner !== ')') {
          throw new PgnParseError('Variation is not closed', this.pos);
        }
        parent.variations.push(branch);
        continue;
      }

      if (ch === ')') {
        if (depth === 0) {
          throw new PgnParseError('Unmatched closing parenthesis', this.pos);
        }
        this.pos++;
        return ')';
      }

      if (ch === '[') {
        // The next game's tag section: this game is over without a result token.
        return '*';
      }

      if (ch === '$') {
        const start = this.pos;
        this.pos++;
        const digits = this.readWhile(/[0-9]/);
        if (digits.length === 0) {
          throw new PgnParseError('NAG has no number', start);
        }
        const parent = this.lastOf(out);
        if (!parent) {
          throw new PgnParseError('NAG before any move', start);
        }
        parent.nags.push(Number(digits));
        continue;
      }

      const token = this.readToken();
      if (token.length === 0) {
        throw new PgnParseError('Unexpected character in movetext', this.pos, ch);
      }

      if (isPgnResult(token)) {
        return token;
      }

      // Move numbers and their trailing dots are noise: the tree already knows the order, and a
      // number that disagrees with it is the file's problem, not something to encode.
      if (/^\d+\.*$/.test(token)) {
        continue;
      }

      // `--` and `Z0` are the common null-move spellings. They are legal PGN and not legal chess,
      // so they are rejected here rather than at move resolution, where the error would point at
      // the board instead of at the file.
      if (token === '--' || token === 'Z0') {
        throw new PgnParseError('Null moves are not supported', this.pos - token.length, token);
      }

      if (!isSanShaped(token)) {
        throw new PgnParseError('Not a move', this.pos - token.length, token);
      }

      out.push({ san: token, nags: [], comments: [], variations: [] });
    }
  }

  private lastOf(nodes: MutableNode[]): MutableNode | undefined {
    return nodes[nodes.length - 1];
  }

  private readWhile(re: RegExp): string {
    const start = this.pos;
    while (this.pos < this.src.length && re.test(this.src[this.pos]!)) {
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }

  private readToken(): string {
    const start = this.pos;
    while (this.pos < this.src.length && !/[\s{}()$;]/.test(this.src[this.pos]!)) {
      this.pos++;
    }
    return this.src.slice(start, this.pos);
  }
}

/**
 * A cheap shape check, not a legality check.
 *
 * Whether a move is *playable* is the board's question and is answered later against a real
 * position. This only rejects tokens that could not be SAN under any position, so that a mangled
 * file fails with "not a move" pointing at the token rather than with a confusing illegal-move
 * error pointing at the board.
 */
export function isSanShaped(token: string): boolean {
  const bare = token.replace(/[+#!?]+$/, '');
  if (/^(O-O(-O)?|0-0(-0)?)$/.test(bare)) {
    return true;
  }
  return /^[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBNqrbn])?$/.test(bare)
    || /^[A-Z]@[a-h][1-8]$/.test(bare); // crazyhouse drop
}
