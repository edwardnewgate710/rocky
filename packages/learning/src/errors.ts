export type LearningErrorCode =
  | 'not_found'
  | 'not_authorized'
  | 'invalid_input'
  | 'invalid_transition'
  | 'duplicate_slug'
  | 'invalid_move';

/**
 * Domain error for learning system rule violations.
 *
 * Each error carries a specific code from `LearningErrorCode` so upstream layers (such as the REST API)
 * can map domain rejections cleanly to HTTP status codes without inspectable string parsing.
 */
export class LearningRuleError extends Error {
  readonly code: LearningErrorCode;

  constructor(code: LearningErrorCode, message: string) {
    super(message);
    this.name = 'LearningRuleError';
    this.code = code;
  }
}
