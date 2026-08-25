/**
 * Minimal structural types for OpenAPI 3.x and Swagger 2.0 documents.
 *
 * Deliberately loose: real-world specs carry vendor extensions and
 * partial compliance, and rejecting a document because a field is
 * shaped unexpectedly is worse than extracting what is there.
 */

export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  additionalProperties?: boolean | OpenApiSchema;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  enum?: unknown[];
  nullable?: boolean;
  deprecated?: boolean;
  default?: unknown;
  [key: string]: unknown;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
}

export interface OpenApiParameter {
  $ref?: string;
  name?: string;
  in?: 'path' | 'query' | 'header' | 'cookie' | 'body' | 'formData';
  required?: boolean;
  deprecated?: boolean;
  description?: string;
  /** OpenAPI 3.x */
  schema?: OpenApiSchema;
  /** Swagger 2.0 puts primitive types directly on the parameter. */
  type?: string;
}

export interface OpenApiRequestBody {
  $ref?: string;
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  $ref?: string;
  description?: string;
  /** OpenAPI 3.x */
  content?: Record<string, OpenApiMediaType>;
  /** Swagger 2.0 */
  schema?: OpenApiSchema;
}

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
}

export interface OpenApiPathItem {
  $ref?: string;
  /** Shared by every operation on the path. */
  parameters?: OpenApiParameter[];
  [method: string]: unknown;
}

export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string; description?: string };
  basePath?: string;
  paths?: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, OpenApiSchema>;
    parameters?: Record<string, OpenApiParameter>;
    requestBodies?: Record<string, OpenApiRequestBody>;
    responses?: Record<string, OpenApiResponse>;
  };
  /** Swagger 2.0 */
  definitions?: Record<string, OpenApiSchema>;
  [key: string]: unknown;
}

/** HTTP methods that carry an operation object on a path item. */
export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];
