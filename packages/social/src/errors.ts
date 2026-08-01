export type SocialErrorCode =
  | 'self_relation'
  | 'blocked'
  | 'already_exists'
  | 'not_found'
  | 'invalid_transition'
  | 'not_authorized';

/**
 * Domain error thrown when a social graph rule or invariant is violated.
 * The code field is the contract used by upstream layers (e.g. REST API) to map
 * domain failures to protocol statuses.
 */
export class SocialRuleError extends Error {
  readonly code: SocialErrorCode;

  constructor(code: SocialErrorCode, message: string) {
    super(message);
    this.name = 'SocialRuleError';
    this.code = code;
  }
}
