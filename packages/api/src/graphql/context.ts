/**
 * @packageDocumentation
 * The per-request resolver context: who is asking, which subsystems are available, and the request-
 * scoped loaders.
 *
 * Two decisions live here.
 *
 * **A missing subsystem is a field error, not a request error.** Each M10 repository is optional and
 * separately feature-flagged. If `STUDIES_ENABLED` is off, a query selecting both `team` and `study`
 * should still answer `team` — failing the whole request would let one unconfigured subsystem take
 * out every unrelated field in every query. So the accessors below throw {@link FieldResolutionError},
 * which the executor catches per field.
 *
 * **Domain errors are flattened to one message.** Every M10 repository distinguishes `not_found`
 * from `not_authorized` internally, and it must not distinguish them to the caller: answering "you
 * are not allowed to see this" for a row that exists and "not found" for one that does not turns
 * the endpoint into an existence oracle over ids. Increments 3 and 4 removed exactly that leak from
 * the REST routes (ADR-0069); {@link toFieldError} is where GraphQL declines to reintroduce it.
 */

import type { SocialGraphRepository } from '@chess-platform/social';
import type { CommunityRepository } from '@chess-platform/community';
import type { StudiesRepository } from '@chess-platform/studies';
import type { LearningRepository } from '@chess-platform/learning';
import type { AchievementsRepository } from '@chess-platform/achievements';
import type { SearchRepository } from '@chess-platform/search';
import type { Loaders } from './loaders';

/**
 * A failure that nulls one field and is reported against that field's path, leaving the rest of the
 * response intact.
 */
export class FieldResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldResolutionError';
  }
}

/** The optional repositories a resolver may reach for. */
export interface GraphQLRepositories {
  readonly social?: SocialGraphRepository;
  readonly community?: CommunityRepository;
  readonly studies?: StudiesRepository;
  readonly learning?: LearningRepository;
  readonly achievements?: AchievementsRepository;
  readonly search?: SearchRepository;
}

export interface ResolverContext {
  /** The authenticated caller, or null for an anonymous request. */
  readonly actorId: string | null;
  readonly loaders: Loaders;
  /** The caller's id, or a field error when the field requires authentication. */
  readonly requireActor: () => string;
  readonly social: () => SocialGraphRepository;
  readonly community: () => CommunityRepository;
  readonly studies: () => StudiesRepository;
  readonly learning: () => LearningRepository;
  readonly achievements: () => AchievementsRepository;
  readonly search: () => SearchRepository;
}

/*
 * The repository bundle is reachable only through the accessors above — it is not a field on the
 * context. A resolver holding the bundle can write `if (repos.social)` and silently skip a check
 * when the subsystem is absent, which turns a switched-off feature into a quietly weakened rule.
 * The accessors have no such branch: they return the repository or fail the field.
 */

function required<T>(value: T | undefined, subsystem: string): T {
  if (value === undefined) {
    throw new FieldResolutionError(`the ${subsystem} subsystem is not configured`);
  }
  return value;
}

/** Build the context for one request. The loaders must be freshly created for this request. */
export function createResolverContext(
  actorId: string | null,
  repos: GraphQLRepositories,
  loaders: Loaders,
): ResolverContext {
  return {
    actorId,
    loaders,
    requireActor: () => {
      if (actorId === null) {
        throw new FieldResolutionError('this field requires an authenticated caller');
      }
      return actorId;
    },
    social: () => required(repos.social, 'social'),
    community: () => required(repos.community, 'community'),
    studies: () => required(repos.studies, 'studies'),
    learning: () => required(repos.learning, 'learning'),
    achievements: () => required(repos.achievements, 'achievements'),
    search: () => required(repos.search, 'search'),
  };
}

/**
 * The message a resolver failure is reported with.
 *
 * `not_found` and `not_authorized` deliberately produce the *same* text. See the note at the top of
 * this file: distinguishing them would tell an unauthorized caller that the id they guessed names a
 * real row. Anything that is not a recognized domain error is reported generically, because an
 * unexpected error's message is an internal detail.
 */
export function toFieldError(err: unknown): string {
  if (err instanceof FieldResolutionError) return err.message;

  const code = domainErrorCode(err);
  if (code === 'not_found' || code === 'not_authorized') return 'not found';
  if (code !== undefined) return code;

  return 'internal error';
}

/**
 * True when the error is one the caller caused and may be told about verbatim — as opposed to an
 * internal failure. Used by the executor to decide what to log.
 */
export function isExpectedFieldError(err: unknown): boolean {
  return err instanceof FieldResolutionError || domainErrorCode(err) !== undefined;
}

const DOMAIN_ERROR_NAMES = new Set([
  'SocialRuleError',
  'MessagingRuleError',
  'CommunityRuleError',
  'StudyRuleError',
  'LearningRuleError',
  'PgnParseError',
]);

/**
 * The `code` of a domain rule error, or undefined for anything else.
 *
 * Matched on the error's `name` rather than with `instanceof`: each domain package is a separate
 * npm workspace, and a duplicated install would give two distinct class identities for what is the
 * same error. `name` is set in every one of these constructors and does not have that failure mode.
 */
function domainErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { name, code } = err as { name?: unknown; code?: unknown };
  if (typeof name !== 'string' || !DOMAIN_ERROR_NAMES.has(name)) return undefined;
  return typeof code === 'string' ? code : undefined;
}
