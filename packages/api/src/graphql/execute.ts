/**
 * @packageDocumentation
 * The executor. It walks the plan produced by `limits.ts` — never a raw document — so every field
 * it touches has already been validated against the schema and costed against the limits.
 *
 * Sibling fields and list items are resolved with `Promise.all` rather than in sequence. That is not
 * an optimization detail: the loaders in `loaders.ts` coalesce the `load()` calls issued within one
 * microtask tick, so sequential execution would flush a batch of one per node and quietly restore
 * the N+1 the loaders exist to prevent.
 *
 * A resolver failure follows the GraphQL convention: the field becomes `null`, an entry is added to
 * `errors` with the response path, and everything else in the query still answers. This is what
 * lets one unconfigured subsystem fail its own fields without taking out the request.
 */

import type { PlanNode } from './limits';
import type { ResolverContext } from './context';
import { isExpectedFieldError, toFieldError } from './context';

export type ResponsePath = readonly (string | number)[];

export interface ExecutionError {
  readonly message: string;
  readonly path: ResponsePath;
}

export interface ExecutionResult {
  readonly data: Record<string, unknown>;
  readonly errors: readonly ExecutionError[];
}

/** Sink for the failures that are not the caller's fault, so they reach the logs but not the wire. */
export type InternalErrorSink = (err: unknown, path: ResponsePath) => void;

/** Execute a validated plan against the root source. */
export async function executePlan(
  plan: readonly PlanNode[],
  ctx: ResolverContext,
  onInternalError?: InternalErrorSink,
): Promise<ExecutionResult> {
  const errors: ExecutionError[] = [];
  const data = await executeSelectionSet(plan, null, ctx, [], errors, onInternalError);
  return { data, errors };
}

async function executeSelectionSet(
  nodes: readonly PlanNode[],
  source: unknown,
  ctx: ResolverContext,
  path: ResponsePath,
  errors: ExecutionError[],
  onInternalError: InternalErrorSink | undefined,
): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    nodes.map(async (node) => {
      const fieldPath = [...path, node.responseKey];
      try {
        const value = await node.field.resolve(source, node.args, ctx);
        const completed = await completeValue(node, value, ctx, fieldPath, errors, onInternalError);
        return [node.responseKey, completed] as const;
      } catch (err) {
        recordError(err, fieldPath, errors, onInternalError);
        return [node.responseKey, null] as const;
      }
    }),
  );

  const result: Record<string, unknown> = {};
  for (const [key, value] of entries) result[key] = value;
  return result;
}

async function completeValue(
  node: PlanNode,
  value: unknown,
  ctx: ResolverContext,
  path: ResponsePath,
  errors: ExecutionError[],
  onInternalError: InternalErrorSink | undefined,
): Promise<unknown> {
  // A leaf. `undefined` is normalized to `null` so the response is valid JSON in every case —
  // `JSON.stringify` drops an `undefined` property, which would silently omit a requested field.
  if (node.field.type === null) {
    return value === undefined ? null : value;
  }

  if (value === null || value === undefined) return null;

  if (node.field.list) {
    if (!Array.isArray(value)) {
      recordError(
        new Error(`field '${node.fieldName}' resolved to a non-list value`),
        path,
        errors,
        onInternalError,
      );
      return null;
    }
    return Promise.all(
      value.map(async (item, index) => {
        const itemPath = [...path, index];
        if (item === null || item === undefined) return null;
        try {
          return await executeSelectionSet(node.selections, item, ctx, itemPath, errors, onInternalError);
        } catch (err) {
          recordError(err, itemPath, errors, onInternalError);
          return null;
        }
      }),
    );
  }

  return executeSelectionSet(node.selections, value, ctx, path, errors, onInternalError);
}

function recordError(
  err: unknown,
  path: ResponsePath,
  errors: ExecutionError[],
  onInternalError: InternalErrorSink | undefined,
): void {
  // Only unexpected failures reach the sink. A private study refused to an outsider is the system
  // working, and logging it as an error would bury the failures that are not.
  if (!isExpectedFieldError(err)) onInternalError?.(err, path);
  errors.push({ message: toFieldError(err), path });
}
