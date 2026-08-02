export type CommunityErrorCode =
  | 'not_found'
  | 'not_authorized'
  | 'invalid_slug'
  | 'slug_taken'
  | 'invalid_input'
  | 'already_member'
  | 'already_requested'
  | 'cannot_leave_as_owner'
  | 'invalid_role_transition'
  | 'invalid_transition';

export class CommunityRuleError extends Error {
  constructor(
    public readonly code: CommunityErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CommunityRuleError';
  }
}
