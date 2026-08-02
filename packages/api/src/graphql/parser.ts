/**
 * @packageDocumentation
 * A parser for the subset of GraphQL this API answers: read queries, with aliases, arguments and
 * variables. It is hand-written for the same reason the router and the PGN reader are — a parser is
 * the one place where a dependency's behaviour becomes our attack surface, and the subset we accept
 * is small enough to own.
 *
 * What is deliberately *not* accepted, and why:
 *
 * - **Mutations and subscriptions.** This layer is read-only (ADR-0073). Writes go through REST,
 *   where each one already has an authorization review.
 * - **Fragments, named or inline.** A fragment may spread another fragment, so a document can
 *   describe a cyclic or exponentially-expanding selection *before* anything measurable as depth
 *   exists. Bounding that needs cycle detection and expansion accounting; refusing it needs one
 *   line. With no client asking for fragments, the second is the honest trade.
 * - **Block strings.** No argument in this schema takes prose.
 *
 * Each refusal is a clear parse error naming the construct, never a silent misparse.
 */

/** The largest query text accepted, before tokenizing. */
export const MAX_QUERY_BYTES = 16 * 1024;

/**
 * How deeply argument *values* may nest. Selection-set depth is a separate, schema-aware limit
 * (see `limits.ts`); this one exists only so a pathological `[[[[…]]]]` cannot exhaust the stack
 * while parsing, which would be a crash before any limit had a chance to run.
 */
export const MAX_VALUE_DEPTH = 8;

/** A failure to parse or validate a document. Carries a source offset when one is known. */
export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly offset?: number,
  ) {
    super(message);
    this.name = 'GraphQLRequestError';
  }
}

export type ValueNode =
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyMap<string, ValueNode> }
  | { readonly kind: 'variable'; readonly name: string };

export interface FieldNode {
  readonly name: string;
  /** The response key: the alias when one was given, otherwise the field name. */
  readonly responseKey: string;
  /** True when an alias was written, which is what the alias limit counts. */
  readonly aliased: boolean;
  readonly args: ReadonlyMap<string, ValueNode>;
  readonly selections: readonly FieldNode[];
  readonly offset: number;
}

export interface OperationNode {
  readonly name: string | null;
  readonly variableNames: readonly string[];
  readonly selections: readonly FieldNode[];
}

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly offset: number;
}

const PUNCTUATORS = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|']);
const NAME_START = /[_A-Za-z]/;
const NAME_CHAR = /[_0-9A-Za-z]/;
const DIGIT = /[0-9]/;

/**
 * The characters GraphQL discards between tokens. Commas are insignificant, and U+FEFF is written
 * as an escape because a raw byte-order mark in source is invisible in every diff that would need
 * to show it.
 */
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const IGNORED = new Set([' ', '\t', '\n', '\r', ',', BYTE_ORDER_MARK]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;

    if (IGNORED.has(ch)) {
      i += 1;
      continue;
    }

    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '.') {
      if (source.startsWith('...', i)) {
        throw new GraphQLRequestError('fragments are not supported by this endpoint', i);
      }
      throw new GraphQLRequestError("unexpected '.'", i);
    }

    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        throw new GraphQLRequestError('block strings are not supported by this endpoint', i);
      }
      const start = i;
      i += 1;
      let text = '';
      let closed = false;
      while (i < source.length) {
        const c = source[i]!;
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (c === '\n' || c === '\r') {
          throw new GraphQLRequestError('unterminated string', start);
        }
        if (c === '\\') {
          i += 1;
          text += readEscape(source, i, start);
          i += source[i] === 'u' ? 5 : 1;
          continue;
        }
        text += c;
        i += 1;
      }
      if (!closed) throw new GraphQLRequestError('unterminated string', start);
      tokens.push({ kind: 'string', value: text, offset: start });
      continue;
    }

    if (PUNCTUATORS.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, offset: i });
      i += 1;
      continue;
    }

    if (NAME_START.test(ch)) {
      const start = i;
      while (i < source.length && NAME_CHAR.test(source[i]!)) i += 1;
      tokens.push({ kind: 'name', value: source.slice(start, i), offset: start });
      continue;
    }

    if (DIGIT.test(ch) || ch === '-') {
      const start = i;
      if (ch === '-') i += 1;
      while (i < source.length && DIGIT.test(source[i]!)) i += 1;
      let isFloat = false;
      if (source[i] === '.') {
        isFloat = true;
        i += 1;
        while (i < source.length && DIGIT.test(source[i]!)) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        isFloat = true;
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        while (i < source.length && DIGIT.test(source[i]!)) i += 1;
      }
      const text = source.slice(start, i);
      const value = Number(text);
      // `Number('-')` and `Number('1e')` are NaN; a number token that is not a number is a syntax
      // error here rather than a NaN travelling into an argument.
      if (!Number.isFinite(value)) {
        throw new GraphQLRequestError(`invalid number '${text}'`, start);
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: text, offset: start });
      continue;
    }

    throw new GraphQLRequestError(`unexpected character '${ch}'`, i);
  }

  tokens.push({ kind: 'eof', value: '', offset: source.length });
  return tokens;
}

function readEscape(source: string, at: number, stringStart: number): string {
  const c = source[at];
  if (c === undefined) throw new GraphQLRequestError('unterminated string', stringStart);
  switch (c) {
    case '"':
      return '"';
    case '\\':
      return '\\';
    case '/':
      return '/';
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    case 'u': {
      const hex = source.slice(at + 1, at + 5);
      if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
        throw new GraphQLRequestError('invalid unicode escape', at);
      }
      return String.fromCharCode(Number.parseInt(hex, 16));
    }
    default:
      throw new GraphQLRequestError(`invalid escape '\\${c}'`, at);
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'eof') this.index += 1;
    return token;
  }

  private expectPunct(value: string): Token {
    const token = this.peek();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLRequestError(`expected '${value}'`, token.offset);
    }
    return this.next();
  }

  private expectName(): string {
    const token = this.peek();
    if (token.kind !== 'name') {
      throw new GraphQLRequestError('expected a name', token.offset);
    }
    return this.next().value;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): OperationNode {
    const first = this.peek();

    // The `{ … }` shorthand is an anonymous query.
    if (this.isPunct('{')) {
      const operation: OperationNode = {
        name: null,
        variableNames: [],
        selections: this.parseSelectionSet(),
      };
      this.expectEof();
      return operation;
    }

    if (first.kind !== 'name') {
      throw new GraphQLRequestError('expected a query operation', first.offset);
    }
    if (first.value === 'mutation' || first.value === 'subscription') {
      throw new GraphQLRequestError(
        `${first.value} operations are not supported by this endpoint`,
        first.offset,
      );
    }
    if (first.value === 'fragment') {
      throw new GraphQLRequestError('fragments are not supported by this endpoint', first.offset);
    }
    if (first.value !== 'query') {
      throw new GraphQLRequestError(`unexpected '${first.value}'`, first.offset);
    }
    this.next();

    const name = this.peek().kind === 'name' ? this.expectName() : null;
    const variableNames = this.isPunct('(') ? this.parseVariableDefinitions() : [];
    const selections = this.parseSelectionSet();
    this.expectEof();
    return { name, variableNames, selections };
  }

  /**
   * Variable *types* are parsed and discarded. Coercion here would be a second, weaker copy of the
   * argument validation the schema already performs on the resolved value, and two validators that
   * can disagree are worse than one — so the declaration is checked for shape only, and the value
   * is checked where it is used.
   */
  private parseVariableDefinitions(): string[] {
    this.expectPunct('(');
    const names: string[] = [];
    while (!this.isPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      if (names.includes(name)) {
        throw new GraphQLRequestError(`duplicate variable '$${name}'`, this.peek().offset);
      }
      names.push(name);
      this.expectPunct(':');
      this.skipTypeReference();
      if (this.isPunct('=')) {
        this.next();
        this.parseValue(0);
      }
      if (this.peek().kind === 'eof') throw new GraphQLRequestError("expected ')'", this.peek().offset);
    }
    this.expectPunct(')');
    return names;
  }

  private skipTypeReference(): void {
    if (this.isPunct('[')) {
      this.next();
      this.skipTypeReference();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'eof') {
        throw new GraphQLRequestError("expected '}'", this.peek().offset);
      }
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    if (fields.length === 0) {
      throw new GraphQLRequestError('selection set must select at least one field');
    }
    return fields;
  }

  private parseField(): FieldNode {
    const offset = this.peek().offset;
    const first = this.expectName();
    // `alias: field` — the first name read is the response key, the second is the field.
    const responseKey = first;
    let name = first;
    let aliased = false;
    if (this.isPunct(':')) {
      this.next();
      name = this.expectName();
      aliased = true;
    }
    if (this.isPunct('@')) {
      throw new GraphQLRequestError('directives are not supported by this endpoint', this.peek().offset);
    }
    const args = this.isPunct('(') ? this.parseArguments() : new Map<string, ValueNode>();
    const selections = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { name, responseKey, aliased, args, selections, offset };
  }

  private parseArguments(): Map<string, ValueNode> {
    this.expectPunct('(');
    const args = new Map<string, ValueNode>();
    while (!this.isPunct(')')) {
      if (this.peek().kind === 'eof') {
        throw new GraphQLRequestError("expected ')'", this.peek().offset);
      }
      const offset = this.peek().offset;
      const name = this.expectName();
      if (args.has(name)) {
        throw new GraphQLRequestError(`duplicate argument '${name}'`, offset);
      }
      this.expectPunct(':');
      args.set(name, this.parseValue(0));
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(depth: number): ValueNode {
    if (depth > MAX_VALUE_DEPTH) {
      throw new GraphQLRequestError(
        `argument value nests deeper than ${MAX_VALUE_DEPTH}`,
        this.peek().offset,
      );
    }
    const token = this.peek();

    if (token.kind === 'punct' && token.value === '$') {
      this.next();
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: Number(token.value) };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: Number(token.value) };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) {
        if (this.peek().kind === 'eof') throw new GraphQLRequestError("expected ']'", this.peek().offset);
        items.push(this.parseValue(depth + 1));
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      this.next();
      const fields = new Map<string, ValueNode>();
      while (!this.isPunct('}')) {
        if (this.peek().kind === 'eof') throw new GraphQLRequestError("expected '}'", this.peek().offset);
        const name = this.expectName();
        this.expectPunct(':');
        fields.set(name, this.parseValue(depth + 1));
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }

    throw new GraphQLRequestError('expected a value', token.offset);
  }

  private expectEof(): void {
    const token = this.peek();
    if (token.kind !== 'eof') {
      // Two operations in one document would otherwise be silently truncated to the first.
      throw new GraphQLRequestError('expected a single query operation per document', token.offset);
    }
  }
}

/** Parse a query document into its single operation. Throws {@link GraphQLRequestError}. */
export function parseQuery(source: string): OperationNode {
  if (Buffer.byteLength(source, 'utf-8') > MAX_QUERY_BYTES) {
    throw new GraphQLRequestError(`query exceeds ${MAX_QUERY_BYTES} bytes`);
  }
  return new Parser(tokenize(source)).parseDocument();
}
