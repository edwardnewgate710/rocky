/**
 * @packageDocumentation
 * The read-only GraphQL layer (M10 increment 8). See `docs/adr/0073-graphql-read-layer.md`.
 */

export { createGraphQLHandler, type GraphQLHandlerDeps, type GraphQLOptions } from './endpoint';
export {
  createResolverContext,
  FieldResolutionError,
  toFieldError,
  type GraphQLRepositories,
  type ResolverContext,
} from './context';
export { BatchLoader, createLoaders, MAX_BATCH_SIZE, type Loaders } from './loaders';
export {
  DEFAULT_LIMITS,
  LimitExceededError,
  planOperation,
  type LimitConfig,
  type LimitName,
  type PlanNode,
} from './limits';
export { GraphQLRequestError, MAX_QUERY_BYTES, MAX_VALUE_DEPTH, parseQuery } from './parser';
export { executePlan, type ExecutionError, type ExecutionResult } from './execute';
export {
  clampLimit,
  clampOffset,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  QUERY_TYPE,
  schema,
  withIntrospection,
  type Schema,
} from './schema';
