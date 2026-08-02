/**
 * @packageDocumentation
 * Validation and cost analysis, which in this endpoint are the same pass.
 *
 * A GraphQL endpoint without limits is a denial-of-service primitive that the caller gets to
 * program: one small document can describe an arbitrarily large amount of work. Three independent
 * bounds close that, and each closes a hole the others do not:
 *
 * - **Depth** stops recursive nesting (`followers { follower { followers { … } } }`), which
 *   multiplies work without making the document noticeably longer.
 * - **Complexity** stops *breadth* — a shallow query selecting many list fields, each with a large
 *   `limit`. List fields multiply their subtree by the page size they will actually request, so
 *   raising `limit` raises the bill rather than hiding under a depth bound.
 * - **Aliases** stop the same field being requested hundreds of times in one selection set. Depth
 *   and complexity both see a single field; aliasing makes it a hundred, and without this bound the
 *   cheapest field in the schema becomes the most expensive query.
 *
 * All of it runs on the parsed document and **finishes before any resolver is called** — the
 * function returns an execution plan, so there is no path that resolves a field without having been
 * costed first. A limit enforced during execution is not a limit; the work is already done by the
 * time it fires. `graphql.test.ts` asserts the repositories are untouched when a limit trips.
 */

import type { FieldNode, OperationNode, ValueNode } from './parser';
import { GraphQLRequestError } from './parser';
import type { ArgDef, FieldDef, Schema } from './schema';
import { QUERY_TYPE } from './schema';

export interface LimitConfig {
  readonly maxDepth: number;
  readonly maxComplexity: number;
  readonly maxAliases: number;
}

/**
 * The shipped bounds. Depth 8 clears the deepest useful query in this schema
 * (`player → followers → follower → studies → chapters` is 5) with room to spare; complexity 1000
 * allows roughly ten full-page list reads; 50 aliases is far more than a hand-written query uses
 * and far fewer than an amplification attack needs.
 */
export const DEFAULT_LIMITS: LimitConfig = {
  maxDepth: 8,
  maxComplexity: 1000,
  maxAliases: 50,
};

/** A validated, costed field ready to execute. */
export interface PlanNode {
  readonly responseKey: string;
  readonly fieldName: string;
  readonly field: FieldDef;
  readonly args: ReadonlyMap<string, unknown>;
  readonly selections: readonly PlanNode[];
}

/** Which limit a rejection hit, so the caller is told what to change. */
export type LimitName = 'depth' | 'complexity' | 'aliases';

export class LimitExceededError extends GraphQLRequestError {
  constructor(
    readonly limit: LimitName,
    message: string,
  ) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

export interface PlanResult {
  readonly selections: readonly PlanNode[];
  readonly complexity: number;
}

/**
 * Validate an operation against the schema and cost it. Throws {@link GraphQLRequestError} for an
 * invalid document and {@link LimitExceededError} when a bound is exceeded.
 *
 * `variables` is the raw JSON object from the request; a `$name` reference is looked up in it and
 * then type-checked at the argument, which is the only place the expected type is known.
 */
export function planOperation(
  operation: OperationNode,
  schema: Schema,
  variables: Readonly<Record<string, unknown>>,
  limits: LimitConfig = DEFAULT_LIMITS,
  introspection = false,
): PlanResult {
  const state = { aliases: 0, introspection };
  const selections = planSelectionSet(
    operation.selections,
    QUERY_TYPE,
    schema,
    operation,
    variables,
    limits,
    1,
    state,
  );
  const complexity = costSelectionSet(selections);
  if (complexity > limits.maxComplexity) {
    throw new LimitExceededError(
      'complexity',
      `query complexity ${complexity} exceeds the maximum of ${limits.maxComplexity}`,
    );
  }
  return { selections, complexity };
}

function planSelectionSet(
  nodes: readonly FieldNode[],
  typeName: string,
  schema: Schema,
  operation: OperationNode,
  variables: Readonly<Record<string, unknown>>,
  limits: LimitConfig,
  depth: number,
  state: { aliases: number; introspection: boolean },
): PlanNode[] {
  if (depth > limits.maxDepth) {
    throw new LimitExceededError(
      'depth',
      `query is nested deeper than the maximum of ${limits.maxDepth}`,
    );
  }

  const type = schema[typeName];
  if (!type) {
    throw new GraphQLRequestError(`unknown type '${typeName}'`);
  }

  const seenKeys = new Set<string>();
  const plan: PlanNode[] = [];

  for (const node of nodes) {
    // Refused by name, before the schema is consulted. Introspection tells an attacker the exact
    // shape of everything reachable, which is the difference between guessing at field names and
    // reading them; it stays off unless a deployment asks for it.
    if (node.name.startsWith('__') && !state.introspection) {
      throw new GraphQLRequestError('introspection is disabled on this endpoint', node.offset);
    }

    if (node.aliased) {
      state.aliases += 1;
      if (state.aliases > limits.maxAliases) {
        throw new LimitExceededError(
          'aliases',
          `query uses more than the maximum of ${limits.maxAliases} aliases`,
        );
      }
    }

    // Two selections writing the same response key would silently overwrite one another. GraphQL
    // merges them when they are identical; refusing outright is simpler and never surprising.
    if (seenKeys.has(node.responseKey)) {
      throw new GraphQLRequestError(
        `duplicate response key '${node.responseKey}'`,
        node.offset,
      );
    }
    seenKeys.add(node.responseKey);

    const field = type.fields[node.name];
    if (!field) {
      // The message names the field the caller wrote but not the fields that exist, so a rejected
      // query cannot be used to enumerate the schema while introspection is disabled.
      throw new GraphQLRequestError(
        `cannot query field '${node.name}' on type '${typeName}'`,
        node.offset,
      );
    }

    const args = coerceArguments(node, field, operation, variables);

    let selections: PlanNode[] = [];
    if (field.type === null) {
      if (node.selections.length > 0) {
        throw new GraphQLRequestError(
          `field '${node.name}' is a scalar and cannot have a selection set`,
          node.offset,
        );
      }
    } else {
      if (node.selections.length === 0) {
        throw new GraphQLRequestError(
          `field '${node.name}' of type '${field.type}' must have a selection set`,
          node.offset,
        );
      }
      selections = planSelectionSet(
        node.selections,
        field.type,
        schema,
        operation,
        variables,
        limits,
        depth + 1,
        state,
      );
    }

    plan.push({ responseKey: node.responseKey, fieldName: node.name, field, args, selections });
  }

  return plan;
}

/**
 * `cost(field) + multiplier × cost(children)`, where the multiplier is the page size a list field
 * will actually request. A non-list field multiplies by one.
 */
function costSelectionSet(nodes: readonly PlanNode[]): number {
  let total = 0;
  for (const node of nodes) {
    const children = costSelectionSet(node.selections);
    const multiplier = node.field.list ? node.field.pageSize?.(node.args) ?? 1 : 1;
    total += node.field.cost + multiplier * children;
  }
  return total;
}

function coerceArguments(
  node: FieldNode,
  field: FieldDef,
  operation: OperationNode,
  variables: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, unknown> {
  const defs = field.args ?? {};
  const out = new Map<string, unknown>();

  for (const [name, value] of node.args) {
    const def = defs[name];
    if (!def) {
      throw new GraphQLRequestError(
        `unknown argument '${name}' on field '${node.name}'`,
        node.offset,
      );
    }
    const resolved = resolveValue(value, operation, variables, node.offset);
    if (resolved === undefined || resolved === null) {
      if (def.required) {
        throw new GraphQLRequestError(`argument '${name}' must not be null`, node.offset);
      }
      continue;
    }
    out.set(name, checkArgType(name, def, resolved, node.offset));
  }

  for (const [name, def] of Object.entries(defs)) {
    if (def.required && !out.has(name)) {
      throw new GraphQLRequestError(
        `field '${node.name}' requires argument '${name}'`,
        node.offset,
      );
    }
  }

  return out;
}

function checkArgType(name: string, def: ArgDef, value: unknown, offset: number): unknown {
  switch (def.type) {
    case 'ID':
    case 'String':
      if (typeof value !== 'string') {
        throw new GraphQLRequestError(`argument '${name}' must be a string`, offset);
      }
      return value;
    case 'Int':
      // `Number.isSafeInteger` rejects `Infinity` and `NaN` along with fractions. Postgres refuses
      // `Infinity` as a bigint while the in-memory adapters absorb it, so a non-finite number that
      // gets this far is a 500 waiting for whichever adapter is configured (ADR-0068).
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new GraphQLRequestError(`argument '${name}' must be an integer`, offset);
      }
      return value;
    case 'Boolean':
      if (typeof value !== 'boolean') {
        throw new GraphQLRequestError(`argument '${name}' must be a boolean`, offset);
      }
      return value;
  }
}

function resolveValue(
  value: ValueNode,
  operation: OperationNode,
  variables: Readonly<Record<string, unknown>>,
  offset: number,
): unknown {
  switch (value.kind) {
    case 'variable': {
      if (!operation.variableNames.includes(value.name)) {
        throw new GraphQLRequestError(`variable '$${value.name}' is not declared`, offset);
      }
      return Object.prototype.hasOwnProperty.call(variables, value.name)
        ? variables[value.name]
        : undefined;
    }
    case 'int':
    case 'float':
      return value.value;
    case 'string':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, operation, variables, offset));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) {
        out[key] = resolveValue(item, operation, variables, offset);
      }
      return out;
    }
  }
}
