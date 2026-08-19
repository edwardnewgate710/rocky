/**
 * Tests for the read-only GraphQL endpoint (ADR-0073).
 *
 * Every test here is written so that removing the rule it covers makes it fail. The limit tests in
 * particular assert that *no repository was called*, because a limit that fires after resolving is
 * not a limit — the work it was supposed to prevent has already happened. Counting is done by
 * replacing a method on the repository instance the server already holds, so nothing in the
 * production code exists to make these assertions possible.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { StudyRuleError } from '@chess-platform/studies';
import { LearningRuleError } from '@chess-platform/learning';
import { CommunityRuleError } from '@chess-platform/community';
import { startHarness, type Harness } from './helpers.js';
import { toFieldError } from '../src/graphql/index.js';

interface GraphQLResponse {
  readonly data?: Record<string, unknown>;
  readonly errors?: readonly { message: string; path: (string | number)[] }[];
}

/**
 * `toFieldError` is tested directly because the end-to-end assertion cannot reach it: the studies
 * adapter already answers `not_found` for an unauthorized read, so an integration test passes
 * whether or not GraphQL flattens the two codes. Only a direct test fails when this rule is
 * removed — and the rule matters for any repository that ever reports `not_authorized` outward.
 */
describe('GraphQL error flattening', () => {
  it('reports not_authorized and not_found identically', () => {
    for (const make of [
      (code: 'not_found' | 'not_authorized') => new StudyRuleError(code, 'study 42 belongs to Ada'),
      (code: 'not_found' | 'not_authorized') => new LearningRuleError(code, 'course 7 is a draft'),
      (code: 'not_found' | 'not_authorized') => new CommunityRuleError(code, 'team 9 is private'),
    ]) {
      assert.equal(toFieldError(make('not_authorized')), toFieldError(make('not_found')));
      assert.equal(toFieldError(make('not_authorized')), 'not found');
    }
  });

  it('never echoes the message of an unrecognized error', () => {
    // An internal failure's message is an internal detail — a stack-adjacent string on the wire is
    // how connection strings and file paths escape.
    assert.equal(toFieldError(new Error('ECONNREFUSED 10.0.0.4:5432')), 'internal error');
  });

  it('reports other domain codes by code, not by message', () => {
    assert.equal(toFieldError(new StudyRuleError('invalid_input', 'name must be 1..80 chars')), 'invalid_input');
  });
});

describe('GraphQL read layer', () => {
  let harness: Harness;
  let owner: { userId: string; token: string };
  let outsider: { userId: string; token: string };

  const query = async (
    text: string,
    opts: { token?: string; variables?: Record<string, unknown> } = {},
  ): Promise<{ status: number; body: GraphQLResponse & { error?: { message: string; details?: Record<string, unknown> } } }> => {
    const res = await harness.json('POST', '/v1/graphql', {
      ...(opts.token ? { token: opts.token } : {}),
      body: { query: text, ...(opts.variables ? { variables: opts.variables } : {}) },
    });
    return { status: res.status, body: res.body };
  };

  /** The error reported against a response path, or undefined when the field succeeded. */
  const errorAt = (body: GraphQLResponse, path: string): string | undefined =>
    body.errors?.find((e) => e.path.join('.') === path)?.message;

  before(async () => {
    harness = await startHarness();
    owner = await harness.makeUser('GraphOwner');
    outsider = await harness.makeUser('GraphOutsider');
  });

  after(async () => {
    if (harness) await harness.close();
  });

  describe('basic execution', () => {
    it('resolves a root field for an anonymous caller', async () => {
      const res = await query(`{ player(id: "${owner.userId}") { id handle } }`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data?.['player'], {
        id: owner.userId,
        handle: 'GraphOwner',
      });
    });

    it('resolves `me` from the access token, not from an argument', async () => {
      const res = await query('{ me { id handle } }', { token: owner.token });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data?.['me'], { id: owner.userId, handle: 'GraphOwner' });
    });

    it('reports `me` as a field error for an anonymous caller, leaving sibling fields answered', async () => {
      const res = await query(`{ me { id } player(id: "${owner.userId}") { handle } }`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data?.['me'], null);
      assert.deepEqual(res.body.data?.['player'], { handle: 'GraphOwner' });
      assert.match(errorAt(res.body, 'me') ?? '', /authenticated/);
    });

    it('rejects an unknown field without naming the fields that exist', async () => {
      const res = await query('{ notAField { id } }');
      assert.equal(res.status, 400);
      assert.match(res.body.error?.message ?? '', /cannot query field 'notAField'/);
      // The schema stays private while introspection is off: an error that listed the valid fields
      // would be introspection by another name.
      assert.doesNotMatch(res.body.error?.message ?? '', /player|team|study/);
    });

    it('rejects a mutation', async () => {
      const res = await query('mutation { me { id } }');
      assert.equal(res.status, 400);
      assert.match(res.body.error?.message ?? '', /mutation/);
    });

    it('rejects a fractional limit rather than passing it to a repository', async () => {
      const res = await query(`{ player(id: "${owner.userId}") { followers(limit: 1.5) { followerId } } }`);
      assert.equal(res.status, 400);
      assert.match(res.body.error?.message ?? '', /'limit' must be an integer/);
    });

    it('resolves an id that is not a UUID to null, not an internal error', async () => {
      // This pins the endpoint's contract: garbage in, empty answer, no error entry. It cannot
      // pin the Postgres half — the in-memory `Map` returns nothing for a non-UUID key whether or
      // not the adapter filters. The cast guard that stops SQLSTATE 22P02 is covered by
      // `packages/persistence/test/users-batch.integration.test.ts`, which is DB-gated.
      const res = await query('{ player(id: "not-a-uuid") { id handle } }', { token: owner.token });
      assert.equal(res.status, 200);
      assert.equal(res.body.data?.['player'], null);
      assert.deepEqual(res.body.errors ?? [], []);
    });

    it('rejects a limit that overflows to Infinity', async () => {
      // The in-memory adapters absorb `Infinity`; Postgres rejects it as a malformed bigint. A
      // literal large enough to overflow must not reach either one.
      const res = await query(`{ player(id: "${owner.userId}") { followers(limit: 1e999) { followerId } } }`);
      assert.equal(res.status, 400);
      assert.match(res.body.error?.message ?? '', /invalid number/);
    });
  });

  describe('authorization stays in the repositories', () => {
    let privateStudyId: string;
    let draftCourseId: string;

    before(async () => {
      const study = await harness.json('POST', '/v1/studies', {
        token: owner.token,
        body: { name: 'Private Prep', description: 'secret', visibility: 'private' },
      });
      assert.equal(study.status, 201);
      privateStudyId = study.body.id;

      const course = await harness.json('POST', '/v1/courses', {
        token: owner.token,
        body: {
          slug: 'graphql-draft-course',
          title: 'Draft',
          description: 'unpublished',
          difficulty: 'beginner',
          published: false,
        },
      });
      assert.equal(course.status, 201);
      draftCourseId = course.body.id;
    });

    it('hides a private study from a non-collaborator', async () => {
      const res = await query(`{ study(id: "${privateStudyId}") { id name } }`, {
        token: outsider.token,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data?.['study'], null);
      assert.equal(errorAt(res.body, 'study'), 'not found');
    });

    it('shows the same private study to its owner', async () => {
      const res = await query(`{ study(id: "${privateStudyId}") { id name } }`, {
        token: owner.token,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data?.['study'], { id: privateStudyId, name: 'Private Prep' });
    });

    it('reports a private study and a nonexistent one identically', async () => {
      const missing = '01890000-0000-7000-8000-000000000000';
      const hidden = await query(`{ study(id: "${privateStudyId}") { id } }`, {
        token: outsider.token,
      });
      const absent = await query(`{ study(id: "${missing}") { id } }`, { token: outsider.token });

      // If these two ever differ, the endpoint has become an existence oracle: an unauthorized
      // caller could confirm which ids name real studies by reading the error text.
      assert.equal(errorAt(hidden.body, 'study'), errorAt(absent.body, 'study'));
      assert.equal(hidden.status, absent.status);
      assert.equal(hidden.body.data?.['study'], absent.body.data?.['study']);
    });

    it('hides an unpublished course from a non-author', async () => {
      const res = await query('{ course(slug: "graphql-draft-course") { id title } }', {
        token: outsider.token,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data?.['course'], null);
      assert.equal(errorAt(res.body, 'course'), 'not found');
    });

    it('shows the same unpublished course to its author', async () => {
      const res = await query('{ course(slug: "graphql-draft-course") { id title } }', {
        token: owner.token,
      });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data?.['course'], { id: draftCourseId, title: 'Draft' });
    });

    it("omits an owner's private studies from another player's `studies` field", async () => {
      const res = await query(`{ player(id: "${owner.userId}") { studies { id } } }`, {
        token: outsider.token,
      });
      assert.equal(res.status, 200);
      const studies = (res.body.data?.['player'] as { studies: { id: string }[] }).studies;
      // Passing the *owner* as the actor here would list every private study to anyone who asked.
      assert.ok(
        !studies.some((s) => s.id === privateStudyId),
        'a private study leaked through the studies list',
      );
    });
  });

  describe('blocking', () => {
    let blocker: { userId: string; token: string };
    let blocked: { userId: string; token: string };

    before(async () => {
      blocker = await harness.makeUser('GraphBlocker');
      blocked = await harness.makeUser('GraphBlocked');
      const res = await harness.json('POST', `/v1/social/blocks/${blocked.userId}`, {
        token: blocker.token,
      });
      assert.equal(res.status, 200);
    });

    /**
     * A block is an interaction rule, not a visibility one: ADR-0066 §3 scopes it to "neither party
     * may follow or send friend requests to the other", and no REST read consults `isBlockedBetween`
     * — `GET /v1/users/:handle` serves the profile to anyone. GraphQL therefore must not hide it
     * either. Filtering here would invent a rule the domain does not have, and the two transports
     * would then disagree about what a block means.
     *
     * This test pins the agreement rather than the permission, so it fails in whichever direction
     * the two drift apart.
     */
    it('exposes a blocker exactly as the REST profile does', async () => {
      const viaRest = await harness.json('GET', '/v1/users/GraphBlocker', {
        token: blocked.token,
      });
      const viaGraphql = await query(
        `{ player(id: "${blocker.userId}") { id handle country createdAt } }`,
        { token: blocked.token },
      );

      assert.equal(viaRest.status, 200);
      assert.equal(viaGraphql.status, 200);
      // `publicUser` is exactly these four fields, so this compares the whole profile the two
      // transports expose — not a sample of it.
      assert.deepEqual(viaGraphql.body.data?.['player'], viaRest.body.user);
    });

    it('still enforces the block on the interaction the rule actually covers', async () => {
      // The rule lives in the social repository and is enforced on writes, which GraphQL does not
      // expose. Asserting it here keeps the reason the read is unfiltered visible next to the read.
      const res = await harness.json('POST', `/v1/social/follows/${blocker.userId}`, {
        token: blocked.token,
      });
      assert.equal(res.status, 403);
    });
  });

  describe('cost limits are enforced before anything resolves', () => {
    /**
     * Replace the repository methods a query would reach and count the calls. The server holds this
     * exact instance, so a resolver that ran would be counted here — which is the only way a test
     * can tell "rejected before execution" from "rejected after doing the work".
     */
    const countRepositoryCalls = (): { calls: () => number; restore: () => void } => {
      const social = harness.socialGraphRepository!;
      const originalFollowers = social.listFollowers.bind(social);
      const users = harness.repos.users;
      const originalFindByIds = users.findByIds.bind(users);
      let calls = 0;
      social.listFollowers = async (...args: Parameters<typeof originalFollowers>) => {
        calls += 1;
        return originalFollowers(...args);
      };
      users.findByIds = async (...args: Parameters<typeof originalFindByIds>) => {
        calls += 1;
        return originalFindByIds(...args);
      };
      return {
        calls: () => calls,
        restore: () => {
          social.listFollowers = originalFollowers;
          users.findByIds = originalFindByIds;
        },
      };
    };

    it('rejects a query past the depth limit without calling a repository', async () => {
      const counter = countRepositoryCalls();
      try {
        // followers → follower → followers → follower → … past a depth of 8.
        const deep = `{ player(id: "${owner.userId}") { followers { follower { followers { follower { followers { follower { followers { follower { id } } } } } } } } } }`;
        const res = await query(deep, { token: owner.token });
        assert.equal(res.status, 400);
        assert.equal(res.body.error?.details?.['limit'], 'depth');
        assert.equal(counter.calls(), 0, 'a repository was called before the depth limit fired');
      } finally {
        counter.restore();
      }
    });

    it('rejects a query past the complexity limit without calling a repository', async () => {
      const counter = countRepositoryCalls();
      try {
        // Shallow, but each list asks for a full page, and the pages multiply their subtrees.
        const wide = `{ player(id: "${owner.userId}") { followers(limit: 100) { follower { followers(limit: 100) { followerId } } } } }`;
        const res = await query(wide, { token: owner.token });
        assert.equal(res.status, 400);
        assert.equal(res.body.error?.details?.['limit'], 'complexity');
        assert.equal(counter.calls(), 0, 'a repository was called before the complexity limit fired');
      } finally {
        counter.restore();
      }
    });

    it('rejects a query past the alias limit without calling a repository', async () => {
      const counter = countRepositoryCalls();
      try {
        const aliases = Array.from(
          { length: 60 },
          (_, i) => `a${i}: player(id: "${owner.userId}") { id }`,
        ).join(' ');
        const res = await query(`{ ${aliases} }`, { token: owner.token });
        assert.equal(res.status, 400);
        assert.equal(res.body.error?.details?.['limit'], 'aliases');
        assert.equal(counter.calls(), 0, 'a repository was called before the alias limit fired');
      } finally {
        counter.restore();
      }
    });

    it('accepts a query just inside the limits', async () => {
      const res = await query(
        `{ player(id: "${owner.userId}") { followers(limit: 5) { follower { handle } } } }`,
        { token: owner.token },
      );
      assert.equal(res.status, 200);
      assert.ok(Array.isArray((res.body.data?.['player'] as { followers: unknown[] }).followers));
    });
  });

  describe('batching', () => {
    it('resolves a list of followers with a bounded number of user reads', async () => {
      const star = await harness.makeUser('GraphStar');
      const followerCount = 25;
      for (let i = 0; i < followerCount; i += 1) {
        const fan = await harness.makeUser(`GraphFan${i}`);
        const res = await harness.json('POST', `/v1/social/follows/${star.userId}`, {
          token: fan.token,
        });
        assert.equal(res.status, 200);
      }

      const users = harness.repos.users;
      const originalFindByIds = users.findByIds.bind(users);
      const batchSizes: number[] = [];
      users.findByIds = async (ids: readonly string[]) => {
        batchSizes.push(ids.length);
        return originalFindByIds(ids);
      };

      try {
        const res = await query(
          `{ player(id: "${star.userId}") { followers(limit: ${followerCount}) { follower { handle } } } }`,
          { token: star.token },
        );
        assert.equal(res.status, 200);
        const followers = (res.body.data?.['player'] as { followers: { follower: { handle: string } }[] })
          .followers;
        assert.equal(followers.length, followerCount);
        assert.ok(followers.every((f) => typeof f.follower.handle === 'string'));

        // Reads scale with the *depth* of the query, not the number of nodes: one batch for the
        // root player, one for all 25 followers together. Broken coalescing turns this into 26
        // calls of one key each, which is precisely the N+1 the loader exists to prevent.
        assert.equal(batchSizes.length, 2, `expected 2 batched reads, got ${batchSizes.length}`);
        assert.equal(
          Math.max(...batchSizes),
          followerCount,
          'the followers were not resolved in a single batch',
        );
      } finally {
        users.findByIds = originalFindByIds;
      }
    });

    it('reads a player once when the same id appears in several places', async () => {
      const users = harness.repos.users;
      const originalFindByIds = users.findByIds.bind(users);
      const requestedIds: string[] = [];
      users.findByIds = async (ids: readonly string[]) => {
        requestedIds.push(...ids);
        return originalFindByIds(ids);
      };

      try {
        const res = await query(
          `{ a: player(id: "${owner.userId}") { handle } b: player(id: "${owner.userId}") { id } }`,
          { token: owner.token },
        );
        assert.equal(res.status, 200);
        assert.equal(
          requestedIds.filter((id) => id === owner.userId).length,
          1,
          'the per-request cache did not deduplicate a repeated id',
        );
      } finally {
        users.findByIds = originalFindByIds;
      }
    });
  });

  describe('introspection', () => {
    it('is refused when the flag is off', async () => {
      const res = await query('{ __schema { types { name } } }', { token: owner.token });
      assert.equal(res.status, 400);
      assert.match(res.body.error?.message ?? '', /introspection is disabled/);
    });

    it('answers when the flag is on', async () => {
      const introspecting = await startHarness({}, { graphqlIntrospection: true });
      try {
        const res = await introspecting.json('POST', '/v1/graphql', {
          body: { query: '{ __schema { queryTypeName types { name } } }' },
        });
        assert.equal(res.status, 200);
        const schema = res.body.data.__schema as { queryTypeName: string; types: { name: string }[] };
        assert.equal(schema.queryTypeName, 'Query');
        assert.ok(schema.types.some((t) => t.name === 'Player'));
      } finally {
        await introspecting.close();
      }
    });

    it('exposes variant on Study without adding it to Team', async () => {
      const introspecting = await startHarness({}, { graphqlIntrospection: true });
      try {
        const res = await introspecting.json('POST', '/v1/graphql', {
          body: {
            query: '{ __schema { types { name fields { name } } } }',
          },
        });
        assert.equal(res.status, 200);
        const described = res.body.data.__schema as {
          types: { name: string; fields: { name: string }[] }[];
        };
        const study = described.types.find((type) => type.name === 'Study');
        const team = described.types.find((type) => type.name === 'Team');
        assert.ok(study);
        assert.ok(team);
        assert.ok(study.fields.some((field) => field.name === 'variant'));
        assert.equal(team.fields.some((field) => field.name === 'variant'), false);
      } finally {
        await introspecting.close();
      }
    });
  });

  describe('subsystem availability', () => {
    it('responds 503 when the endpoint is not enabled', async () => {
      const disabled = await startHarness({}, { withoutGraphql: true });
      try {
        const res = await disabled.json('POST', '/v1/graphql', {
          body: { query: '{ me { id } }' },
        });
        assert.equal(res.status, 503);
      } finally {
        await disabled.close();
      }
    });

    it('fails only the fields of a missing subsystem, answering the rest', async () => {
      const partial = await startHarness({}, { withoutStudies: true });
      try {
        const user = await partial.makeUser('PartialUser');
        const res = await partial.json('POST', '/v1/graphql', {
          token: user.token,
          body: {
            query: `{ me { id } study(id: "01890000-0000-7000-8000-000000000000") { id } }`,
          },
        });
        assert.equal(res.status, 200);
        // One switched-off subsystem must not take out an unrelated field.
        assert.deepEqual(res.body.data.me, { id: user.userId });
        assert.equal(res.body.data.study, null);
        const studyError = (res.body.errors as { message: string; path: string[] }[]).find(
          (e) => e.path.join('.') === 'study',
        );
        assert.match(studyError?.message ?? '', /studies subsystem is not configured/);
      } finally {
        await partial.close();
      }
    });
  });
});
