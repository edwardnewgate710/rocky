/**
 * @packageDocumentation
 * `POST /v1/graphql` — the request handler.
 *
 * The order of operations is the security property: **parse, validate and cost, and only then
 * execute**. A document that trips a limit is refused with a 400 naming the limit, and no resolver
 * has run, so no repository has been touched.
 *
 * Authentication is the router's, not this endpoint's. The route is registered with the same
 * `AuthPolicy` machinery as every REST route, and the actor id comes from `ctx.auth` — GraphQL does
 * not get its own notion of who is calling, because a second way to establish identity is a second
 * thing that can be wrong.
 */

import type { HandlerResult, RequestContext } from '../http/context';
import { HttpError } from '../http/errors';
import { createResolverContext, type GraphQLRepositories } from './context';
import { executePlan, type ExecutionError } from './execute';
import { createLoaders } from './loaders';
import { DEFAULT_LIMITS, LimitExceededError, planOperation, type LimitConfig } from './limits';
import { GraphQLRequestError, parseQuery } from './parser';
import { schema as baseSchema, withIntrospection } from './schema';
import type { UsersRepository } from '@chess-platform/persistence';

/** Deployment-level configuration for the endpoint. */
export interface GraphQLOptions {
  readonly limits?: LimitConfig;
  /**
   * Expose the `__schema` field. Off by default; see `limits.ts` for why, and note that the shape
   * it returns is this repository's own, not spec-standard introspection.
   */
  readonly introspection?: boolean;
}

export interface GraphQLHandlerDeps {
  readonly users: UsersRepository;
  readonly repos: GraphQLRepositories;
  readonly options: GraphQLOptions;
}

interface GraphQLRequestBody {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

/**
 * Validate the request envelope. `variables` must be a JSON object — an array is also `typeof
 * 'object'`, and letting one through would make `$x` resolve to an array index.
 */
function parseBody(body: unknown): GraphQLRequestBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw HttpError.badRequest('request body must be a JSON object');
  }
  const { query, variables } = body as { query?: unknown; variables?: unknown };
  if (typeof query !== 'string' || query.trim().length === 0) {
    throw HttpError.badRequest("'query' must be a non-empty string");
  }
  if (variables !== undefined && variables !== null) {
    if (typeof variables !== 'object' || Array.isArray(variables)) {
      throw HttpError.badRequest("'variables' must be a JSON object");
    }
  }
  return {
    query,
    variables: (variables as Record<string, unknown> | null | undefined) ?? {},
  };
}

function errorBody(errors: readonly ExecutionError[], data: Record<string, unknown> | null): unknown {
  return errors.length > 0 ? { data, errors } : { data };
}

/** Build the `POST /v1/graphql` handler. */
export function createGraphQLHandler(deps: GraphQLHandlerDeps) {
  const introspection = deps.options.introspection === true;
  // Built once: describing the schema on every request would recompute the same answer, and the
  // schema is immutable for the process lifetime.
  const schema = introspection ? withIntrospection(baseSchema) : baseSchema;
  const limits = deps.options.limits ?? DEFAULT_LIMITS;

  return async function handle(ctx: RequestContext): Promise<HandlerResult> {
    const { query, variables } = parseBody(ctx.body);

    let plan;
    try {
      const operation = parseQuery(query);
      plan = planOperation(operation, schema, variables, limits, introspection);
    } catch (err) {
      if (err instanceof LimitExceededError) {
        throw new HttpError(400, 'bad_request', err.message, { limit: err.limit });
      }
      if (err instanceof GraphQLRequestError) {
        throw new HttpError(
          400,
          'bad_request',
          err.message,
          err.offset === undefined ? undefined : { offset: err.offset },
        );
      }
      throw err;
    }

    // Loaders are created here and referenced by nothing outside this call, so the cache cannot
    // outlive the request and serve one caller from another's authorized view.
    const resolverCtx = createResolverContext(
      ctx.auth?.userId ?? null,
      deps.repos,
      createLoaders(deps.users),
    );

    const { data, errors } = await executePlan(plan.selections, resolverCtx, (err, path) => {
      ctx.logger.error('graphql field failed', {
        path: path.join('.'),
        err: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    });

    return { status: 200, body: errorBody(errors, data) };
  };
}
