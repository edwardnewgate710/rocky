/**
 * @packageDocumentation
 * The schema: what may be asked for, what each field costs, and how each field is resolved.
 *
 * The single rule that shapes every resolver here is that **authorization belongs to the
 * repository**. Each read port already takes an actor id and already decides what that actor may
 * see — private studies, unpublished courses, non-member teams and blocked players all have their
 * rule written once, in the adapter, with tests against Postgres. A resolver that re-checked any of
 * those would be a second copy of the rule, and the copy that drifts is the one that leaks. So a
 * resolver's whole job is to pass `ctx.actorId` and return what it is given.
 *
 * @see docs/adr/0073-graphql-read-layer.md
 */

import { parseSearchQuery } from '@chess-platform/search';
import type { ResolverContext } from './context';
import { FieldResolutionError } from './context';

/** A resolved field value: scalars pass through, objects carry their source for child resolvers. */
export type Resolved = unknown;

export interface ArgDef {
  readonly type: 'ID' | 'String' | 'Int' | 'Boolean';
  readonly required?: boolean;
}

export interface FieldDef {
  /** The named type this field yields; `null` marks a leaf scalar. */
  readonly type: string | null;
  /** True when the field yields a list of `type`. */
  readonly list?: boolean;
  /**
   * The static cost charged for selecting this field, before list multiplication. Fields that
   * reach a repository cost more than fields that read a property already in memory, because the
   * limit exists to bound work, not response size.
   */
  readonly cost: number;
  readonly args?: Readonly<Record<string, ArgDef>>;
  /**
   * The page size a list field will request. The complexity check multiplies the cost of this
   * field's subtree by it, so a limit the caller raises is a cost the caller pays for up front.
   */
  readonly pageSize?: (args: ReadonlyMap<string, unknown>) => number;
  readonly resolve: (
    source: Resolved,
    args: ReadonlyMap<string, unknown>,
    ctx: ResolverContext,
  ) => Promise<Resolved> | Resolved;
}

export interface TypeDef {
  readonly fields: Readonly<Record<string, FieldDef>>;
}

export type Schema = Readonly<Record<string, TypeDef>>;

/** The default page size when a list field is selected without one. */
export const DEFAULT_PAGE_SIZE = 20;
/** The largest page any list field will request, whatever the caller asked for. */
export const MAX_PAGE_SIZE = 100;

/**
 * Clamp a caller-supplied page size. `NaN` and `Infinity` are both handled here rather than at the
 * repository, because the in-memory adapters absorb both and Postgres rejects `Infinity` as a
 * malformed bigint — a divergence that has produced a 500 in this repo before (ADR-0068).
 */
export function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_PAGE_SIZE;
  const floored = Math.floor(raw);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_PAGE_SIZE);
}

/** Clamp a caller-supplied offset with the same `NaN`/`Infinity` contract as {@link clampLimit}. */
export function clampOffset(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  const floored = Math.floor(raw);
  return floored < 0 ? 0 : floored;
}

function pageArgs(args: ReadonlyMap<string, unknown>): { limit: number; offset: number } {
  return { limit: clampLimit(args.get('limit')), offset: clampOffset(args.get('offset')) };
}

function pageSizeOf(args: ReadonlyMap<string, unknown>): number {
  return clampLimit(args.get('limit'));
}

/** Read a string property off a resolver source without asserting the source's shape. */
function prop(source: Resolved, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

function requireString(source: Resolved, key: string): string {
  const value = prop(source, key);
  if (typeof value !== 'string') {
    throw new FieldResolutionError(`expected '${key}' on the resolved source`);
  }
  return value;
}

/** A field that reads a value already present on the source. Costs nothing but its own node. */
function scalar(key: string): FieldDef {
  return { type: null, cost: 1, resolve: (source) => prop(source, key) };
}

/** A `Date` rendered as an ISO-8601 string; `null` and `undefined` pass through unchanged. */
function dateScalar(key: string): FieldDef {
  return {
    type: null,
    cost: 1,
    resolve: (source) => {
      const value = prop(source, key);
      return value instanceof Date ? value.toISOString() : (value ?? null);
    },
  };
}

/** The cost charged to a field that issues a repository read. */
const REPOSITORY_COST = 10;

const PAGE_ARGS: Readonly<Record<string, ArgDef>> = {
  limit: { type: 'Int' },
  offset: { type: 'Int' },
};

export const schema: Schema = {
  Query: {
    fields: {
      me: {
        type: 'Player',
        cost: REPOSITORY_COST,
        resolve: async (_source, _args, ctx) => ctx.loaders.player.load(ctx.requireActor()),
      },
      player: {
        type: 'Player',
        cost: REPOSITORY_COST,
        args: { id: { type: 'ID', required: true } },
        // No block check, deliberately. A block in this system is an *interaction* rule — ADR-0066
        // §3: "neither party may follow or send friend requests to the other" — not a visibility
        // one, and `GET /v1/users/:handle` serves the same profile without consulting blocks.
        // Filtering here would be GraphQL inventing a rule the domain does not have, which is the
        // second copy this layer exists to avoid (ADR-0073 §2). An id naming nobody, or one that is
        // not a UUID at all, resolves to null via the loader.
        resolve: async (_source, args, ctx) => ctx.loaders.player.load(String(args.get('id'))),
      },
      team: {
        type: 'Team',
        cost: REPOSITORY_COST,
        args: { id: { type: 'ID', required: true } },
        resolve: async (_source, args, ctx) =>
          ctx.community().getTeam(String(args.get('id')), ctx.actorId ?? undefined),
      },
      study: {
        type: 'Study',
        cost: REPOSITORY_COST,
        args: { id: { type: 'ID', required: true } },
        resolve: async (_source, args, ctx) =>
          ctx.studies().getStudy(String(args.get('id')), ctx.actorId ?? undefined),
      },
      course: {
        type: 'Course',
        cost: REPOSITORY_COST,
        args: { slug: { type: 'String', required: true } },
        resolve: async (_source, args, ctx) =>
          ctx.learning().getCourseBySlug(String(args.get('slug')), ctx.actorId ?? undefined),
      },
      search: {
        type: 'SearchResult',
        list: true,
        cost: REPOSITORY_COST,
        args: {
          query: { type: 'String', required: true },
          limit: { type: 'Int' },
          offset: { type: 'Int' },
        },
        pageSize: pageSizeOf,
        resolve: async (_source, args, ctx) => {
          // `parseSearchQuery` is the same parser the REST endpoint uses, so `-field:value` and
          // quoted phrases mean here exactly what they mean there. Re-implementing the split would
          // give GraphQL its own dialect of a syntax users already know.
          const page = await ctx
            .search()
            .query(parseSearchQuery(String(args.get('query'))), pageArgs(args));
          return page.results;
        },
      },
    },
  },

  Player: {
    fields: {
      id: scalar('id'),
      handle: scalar('handle'),
      country: scalar('country'),
      createdAt: dateScalar('createdAt'),
      followers: {
        type: 'FollowEdge',
        list: true,
        cost: REPOSITORY_COST,
        args: PAGE_ARGS,
        pageSize: pageSizeOf,
        resolve: async (source, args, ctx) => {
          const page = await ctx.social().listFollowers(requireString(source, 'id'), pageArgs(args));
          return page.items;
        },
      },
      following: {
        type: 'FollowEdge',
        list: true,
        cost: REPOSITORY_COST,
        args: PAGE_ARGS,
        pageSize: pageSizeOf,
        resolve: async (source, args, ctx) => {
          const page = await ctx.social().listFollowing(requireString(source, 'id'), pageArgs(args));
          return page.items;
        },
      },
      achievements: {
        type: 'PlayerAchievement',
        list: true,
        cost: REPOSITORY_COST,
        args: PAGE_ARGS,
        pageSize: pageSizeOf,
        resolve: async (source, args, ctx) => {
          const page = await ctx
            .achievements()
            .listPlayerAchievements(requireString(source, 'id'), pageArgs(args));
          return page.items;
        },
      },
      studies: {
        type: 'Study',
        list: true,
        cost: REPOSITORY_COST,
        args: PAGE_ARGS,
        pageSize: pageSizeOf,
        resolve: async (source, args, ctx) => {
          // `ownerId` selects whose studies; `actorId` decides which of them are visible. Passing
          // the owner as the actor would show every private study to anyone who asked for it.
          const page = await ctx.studies().listStudies(ctx.actorId ?? undefined, {
            ...pageArgs(args),
            ownerId: requireString(source, 'id'),
          });
          return page.items;
        },
      },
    },
  },

  FollowEdge: {
    fields: {
      followerId: scalar('followerId'),
      followeeId: scalar('followeeId'),
      followedAt: dateScalar('followedAt'),
      follower: {
        type: 'Player',
        cost: 1,
        resolve: async (source, _args, ctx) =>
          ctx.loaders.player.load(requireString(source, 'followerId')),
      },
      followee: {
        type: 'Player',
        cost: 1,
        resolve: async (source, _args, ctx) =>
          ctx.loaders.player.load(requireString(source, 'followeeId')),
      },
    },
  },

  Team: {
    fields: {
      id: scalar('id'),
      slug: scalar('slug'),
      name: scalar('name'),
      description: scalar('description'),
      visibility: scalar('visibility'),
      ownerId: scalar('ownerId'),
      createdAt: dateScalar('createdAt'),
      owner: {
        type: 'Player',
        cost: 1,
        resolve: async (source, _args, ctx) => ctx.loaders.player.load(requireString(source, 'ownerId')),
      },
      members: {
        type: 'TeamMember',
        list: true,
        cost: REPOSITORY_COST,
        args: PAGE_ARGS,
        pageSize: pageSizeOf,
        resolve: async (source, args, ctx) => {
          const page = await ctx
            .community()
            .listMembers(requireString(source, 'id'), ctx.actorId ?? undefined, pageArgs(args));
          return page.items;
        },
      },
    },
  },

  TeamMember: {
    fields: {
      teamId: scalar('teamId'),
      playerId: scalar('playerId'),
      role: scalar('role'),
      joinedAt: dateScalar('joinedAt'),
      player: {
        type: 'Player',
        cost: 1,
        resolve: async (source, _args, ctx) => ctx.loaders.player.load(requireString(source, 'playerId')),
      },
    },
  },

  PlayerAchievement: {
    fields: {
      key: scalar('key'),
      name: scalar('name'),
      description: scalar('description'),
      category: scalar('category'),
      tier: scalar('tier'),
      points: scalar('points'),
      hidden: scalar('hidden'),
      progress: scalar('progress'),
      target: scalar('target'),
      unlockedAt: dateScalar('unlockedAt'),
    },
  },

  Study: {
    fields: {
      id: scalar('id'),
      ownerId: scalar('ownerId'),
      name: scalar('name'),
      description: scalar('description'),
      visibility: scalar('visibility'),
      variant: scalar('variant'),
      createdAt: dateScalar('createdAt'),
      updatedAt: dateScalar('updatedAt'),
      owner: {
        type: 'Player',
        cost: 1,
        resolve: async (source, _args, ctx) => ctx.loaders.player.load(requireString(source, 'ownerId')),
      },
      chapters: {
        type: 'Chapter',
        list: true,
        cost: REPOSITORY_COST,
        resolve: async (source, _args, ctx) =>
          ctx.studies().listChapters(requireString(source, 'id'), ctx.actorId ?? undefined),
      },
    },
  },

  Chapter: {
    fields: {
      id: scalar('id'),
      studyId: scalar('studyId'),
      name: scalar('name'),
      orderIndex: scalar('orderIndex'),
      startingFen: scalar('startingFen'),
    },
  },

  Course: {
    fields: {
      id: scalar('id'),
      authorId: scalar('authorId'),
      slug: scalar('slug'),
      title: scalar('title'),
      description: scalar('description'),
      difficulty: scalar('difficulty'),
      published: scalar('published'),
      createdAt: dateScalar('createdAt'),
      updatedAt: dateScalar('updatedAt'),
      author: {
        type: 'Player',
        cost: 1,
        resolve: async (source, _args, ctx) => ctx.loaders.player.load(requireString(source, 'authorId')),
      },
      lessons: {
        type: 'Lesson',
        list: true,
        cost: REPOSITORY_COST,
        resolve: async (source, _args, ctx) =>
          ctx.learning().listLessons(requireString(source, 'id'), ctx.actorId ?? undefined),
      },
    },
  },

  Lesson: {
    fields: {
      id: scalar('id'),
      courseId: scalar('courseId'),
      title: scalar('title'),
      orderIndex: scalar('orderIndex'),
    },
  },

  // The keyword index stores documents, not domain objects: a hit is an id and a relevance score,
  // and nothing else. Exposing a `title` here would mean inventing one, so the caller resolves the
  // id through whichever typed root query it actually wants.
  SearchResult: {
    fields: {
      id: scalar('id'),
      score: scalar('score'),
    },
  },
};

/** The root type every document is executed against. */
export const QUERY_TYPE = 'Query';

/**
 * The schema described as data, for the gated `__schema` field.
 *
 * This is **not** spec-compliant GraphQL introspection: it reports each field's type as a plain
 * string and says nothing about nullability, arguments, or scalar types, because the schema model
 * above does not record them. It exists so our own tooling can enumerate what is queryable, and
 * calling it introspection would be describing a feature this code does not have. A client
 * expecting the standard `__Schema` shape will not find it here.
 */
interface IntrospectedField {
  readonly name: string;
  readonly type: string | null;
  readonly list: boolean;
}

interface IntrospectedType {
  readonly name: string;
  readonly fields: readonly IntrospectedField[];
}

function describe(source: Schema): readonly IntrospectedType[] {
  return Object.entries(source).map(([name, type]) => ({
    name,
    fields: Object.entries(type.fields).map(([fieldName, field]) => ({
      name: fieldName,
      type: field.type,
      list: field.list === true,
    })),
  }));
}

const INTROSPECTION_TYPES: Schema = {
  __Type: {
    fields: {
      name: scalar('name'),
      fields: {
        type: '__Field',
        list: true,
        cost: 1,
        resolve: (source) => prop(source, 'fields'),
      },
    },
  },
  __Field: {
    fields: {
      name: scalar('name'),
      type: scalar('type'),
      list: scalar('list'),
    },
  },
  __Schema: {
    fields: {
      queryTypeName: { type: null, cost: 1, resolve: () => QUERY_TYPE },
      types: {
        type: '__Type',
        list: true,
        cost: 1,
        resolve: (source) => prop(source, 'types'),
      },
    },
  },
};

/**
 * The schema with the `__schema` root field attached. Called only when introspection is enabled;
 * when it is not, the field simply does not exist and `limits.ts` refuses `__`-prefixed names
 * outright so the refusal names the reason rather than looking like a typo.
 */
export function withIntrospection(base: Schema = schema): Schema {
  const root = base[QUERY_TYPE];
  if (!root) {
    throw new Error(`withIntrospection: schema has no '${QUERY_TYPE}' type`);
  }
  const described = describe(base);
  return {
    ...base,
    ...INTROSPECTION_TYPES,
    Query: {
      fields: {
        ...root.fields,
        __schema: {
          type: '__Schema',
          cost: 1,
          resolve: () => ({ types: described }),
        },
      },
    },
  };
}
