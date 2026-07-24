/**
 * @packageDocumentation
 * Minimal, dependency-free OpenAPI 3.1 type surface. We model only the subset we
 * emit. Route handlers carry a {@link RouteDoc} describing their contract; the
 * spec builder ({@link ../openapi/spec}) folds these into a complete document.
 */

/** A JSON Schema object (the subset we produce). `$ref` points at components. */
export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly (string | number)[];
  readonly items?: JsonSchema;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly nullable?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly default?: string | number | boolean;
  readonly example?: unknown;
  readonly oneOf?: readonly JsonSchema[];
}

/** An OpenAPI parameter (path or query). */
export interface DocParam {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required: boolean;
  readonly description: string;
  readonly schema: JsonSchema;
}

/** One documented response. */
export interface DocResponse {
  readonly description: string;
  /** Component name (key under `components.schemas`) for the body, if any. */
  readonly schema?: string;
}

/** The OpenAPI contract a route advertises. */
export interface RouteDoc {
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  /** `bearer` marks the operation as requiring the access-token scheme. */
  readonly security: 'none' | 'bearer';
  readonly params?: readonly DocParam[];
  /** Component name for the request body schema, if the operation accepts one. */
  readonly requestSchema?: string;
  /** Whether the request body is required. Defaults to `true` when a `requestSchema` is present. */
  readonly requestBodyRequired?: boolean;
  readonly responses: Readonly<Record<number, DocResponse>>;
}

/** A reusable component schema registered on the spec (name → schema). */
export type ComponentSchemas = Readonly<Record<string, JsonSchema>>;
