import { CommunityRuleError } from './errors';

export type TeamId = string;
export type PlayerId = string;
export type JoinRequestId = string;
export type ThreadId = string;
export type PostId = string;

export type TeamVisibility = 'public' | 'private';
export type TeamRole = 'owner' | 'admin' | 'member';
export type JoinRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

/** Bounded constants for community validation. */
export const MIN_SLUG_LENGTH = 1;
export const MAX_SLUG_LENGTH = 50;
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MAX_TEAM_NAME_LENGTH = 100;
export const MAX_TEAM_DESCRIPTION_LENGTH = 1000;
export const MAX_THREAD_TITLE_LENGTH = 200;
export const MAX_POST_BODY_LENGTH = 10000;

export interface Team {
  readonly id: TeamId;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: TeamVisibility;
  readonly createdBy: PlayerId;
  readonly createdAt: Date;
}

export interface Membership {
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly role: TeamRole;
  readonly joinedAt: Date;
}

export interface JoinRequest {
  readonly id: JoinRequestId;
  readonly teamId: TeamId;
  readonly playerId: PlayerId;
  readonly status: JoinRequestStatus;
  readonly createdAt: Date;
  readonly respondedAt?: Date;
}

export interface ForumThread {
  readonly id: ThreadId;
  readonly teamId: TeamId;
  readonly authorId: PlayerId;
  readonly title: string;
  readonly createdAt: Date;
  readonly lastPostAt: Date;
  readonly locked: boolean;
  readonly pinned: boolean;
  readonly deletedAt?: Date;
}

export interface ForumPost {
  readonly id: PostId;
  readonly threadId: ThreadId;
  readonly authorId: PlayerId;
  readonly body: string;
  readonly createdAt: Date;
  readonly editedAt?: Date;
  readonly deletedAt?: Date;
}

/**
 * Returns numeric rank for team roles to enforce strict ordering:
 * owner (3) > admin (2) > member (1).
 */
export function roleRank(role: TeamRole): number {
  switch (role) {
    case 'owner':
      return 3;
    case 'admin':
      return 2;
    case 'member':
      return 1;
  }
}

/**
 * Validates slug input according to Rule 3:
 * Slugs must be unique, normalized (lowercase, trimmed), non-empty, and constrained
 * to a documented character set. Inputs that are not normalized or fail constraints are rejected.
 */
export function assertValidSlug(slug: string): string {
  if (typeof slug !== 'string') {
    throw new CommunityRuleError('invalid_slug', 'Slug must be a string');
  }
  if (slug !== slug.trim() || slug !== slug.toLowerCase()) {
    throw new CommunityRuleError('invalid_slug', 'Slug must be normalized (lowercase and trimmed)');
  }
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH) {
    throw new CommunityRuleError(
      'invalid_slug',
      `Slug length must be between ${MIN_SLUG_LENGTH} and ${MAX_SLUG_LENGTH} characters`
    );
  }
  if (!SLUG_REGEX.test(slug)) {
    throw new CommunityRuleError(
      'invalid_slug',
      'Slug must contain only lowercase letters, numbers, and hyphens (without leading/trailing hyphens)'
    );
  }
  return slug;
}

/** Validates and trims team name. */
export function assertValidTeamName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEAM_NAME_LENGTH) {
    throw new CommunityRuleError(
      'invalid_input',
      `Team name must be non-empty and at most ${MAX_TEAM_NAME_LENGTH} characters`
    );
  }
  return trimmed;
}

/** Validates and trims team description. */
export function assertValidTeamDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length > MAX_TEAM_DESCRIPTION_LENGTH) {
    throw new CommunityRuleError(
      'invalid_input',
      `Team description must be at most ${MAX_TEAM_DESCRIPTION_LENGTH} characters`
    );
  }
  return trimmed;
}

/** Validates and trims forum thread title. */
export function assertValidThreadTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_THREAD_TITLE_LENGTH) {
    throw new CommunityRuleError(
      'invalid_input',
      `Thread title must be non-empty and at most ${MAX_THREAD_TITLE_LENGTH} characters`
    );
  }
  return trimmed;
}

/** Validates and trims forum post body. */
export function assertValidPostBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_POST_BODY_LENGTH) {
    throw new CommunityRuleError(
      'invalid_input',
      `Post body must be non-empty and at most ${MAX_POST_BODY_LENGTH} characters`
    );
  }
  return trimmed;
}
