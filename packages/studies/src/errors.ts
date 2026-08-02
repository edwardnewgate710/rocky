export type StudyErrorCode =
  | 'not_found'
  | 'not_authorized'
  | 'invalid_input'
  | 'invalid_transition'
  | 'invalid_move'
  | 'too_large';

/**
 * Domain error for study and PGN rule violations. The `code` is the contract upstream layers map
 * to protocol statuses; the message is for a human reading a log, not for branching on.
 */
export class StudyRuleError extends Error {
  readonly code: StudyErrorCode;

  constructor(code: StudyErrorCode, message: string) {
    super(message);
    this.name = 'StudyRuleError';
    this.code = code;
  }
}

/**
 * A PGN that could not be parsed, carrying **where** it stopped making sense.
 *
 * The offset is not decoration. PGN arrives as an upload, often thousands of lines of someone
 * else's export, and "invalid PGN" gives the person holding that file nothing to act on. A byte
 * offset and the offending token turn a rejected import into a fixable one.
 */
export class PgnParseError extends StudyRuleError {
  /** Byte offset into the input where parsing failed. */
  readonly offset: number;
  /** The token that could not be understood, when there was one. */
  readonly token?: string;

  constructor(message: string, offset: number, token?: string) {
    super('invalid_input', `${message} (at offset ${offset}${token === undefined ? '' : `, near '${token}'`})`);
    this.name = 'PgnParseError';
    this.offset = offset;
    if (token !== undefined) {
      this.token = token;
    }
  }
}
