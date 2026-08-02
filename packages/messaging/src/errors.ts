export type MessagingErrorCode =
  | 'self_conversation'
  | 'blocked'
  | 'not_found'
  | 'not_authorized'
  | 'invalid_body'
  | 'invalid_transition';

/**
 * Domain error thrown when a messaging rule or invariant is violated.
 * The code field is the contract used by upstream layers (e.g. REST API) to map
 * domain failures to protocol statuses.
 */
export class MessagingRuleError extends Error {
  readonly code: MessagingErrorCode;

  constructor(code: MessagingErrorCode, message: string) {
    super(message);
    this.name = 'MessagingRuleError';
    this.code = code;
  }
}
