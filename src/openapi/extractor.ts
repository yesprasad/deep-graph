import path from 'path';
import type { GraphNode, GraphEdge } from '../types/graph';
import type { OpenApiOperation, OpenApiParameter, OpenApiSchema } from './types';
import { HTTP_METHODS } from './types';
import {
  type LoadedApi,
  parameterSchema,
  requestBodySchema,
  responseSchema,
} from './loader';

/**
 * OPENAPI EXTRACTOR
 *
 * Turns one API document into nodes and edges shaped like the rest of
 * the graph, so blast radius, diffing and the MCP tools all work on the
 * contract surface without special-casing it.
 *
 * The design decision that matters: every schema field becomes its own
 * `api_property` node. A schema-level node alone can only report
 * "LoginSuccess changed"; a property node reports "LoginSuccess.auth was
 * removed, and here is exactly who reads it".
 *
 * Edges point from the declaring thing to the declared thing
 * (operation -> schema -> property), so the existing reverse traversal
 * walks a field back out to every implementation and consumer.
 */

export interface ApiExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  operationCount: number;
  schemaCount: number;
  propertyCount: number;
  /** `$ref` targets that could not be resolved inside this document. */
  unresolvedRefs: string[];
}

/** Guard against self-referential inline schemas. */
const MAX_INLINE_DEPTH = 12;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'api'
  );
}

export function serviceId(slug: string): string {
  return `api_service:${slug}`;
}
export function operationId(slug: string, method: string, route: string): string {
  return `api_operation:${slug}:${method.toUpperCase()}:${route}`;
}
export function schemaId(slug: string, name: string): string {
  return `api_schema:${slug}:${name}`;
}
export function propertyId(slug: string, schema: string, propPath: string): string {
  return `api_property:${slug}:${schema}.${propPath}`;
}

/** The declared type of a schema, rendered for display. */
function describeType(schema: OpenApiSchema): string {
  if (schema.$ref) return refName(schema.$ref) ?? 'ref';
  if (schema.allOf) return 'allOf';
  if (schema.oneOf) return 'oneOf';
  if (schema.anyOf) return 'anyOf';
  if (schema.enum) return 'enum';

  const base = Array.isArray(schema.type)
    ? schema.type.join('|')
    : schema.type ?? 'unknown';

  if (base === 'array' && schema.items) {
    return `${describeType(schema.items)}[]`;
  }
  return schema.format ? `${base}<${schema.format}>` : base;
}

/** The trailing name of a local `$ref`, or null for external refs. */
function refName(ref: string): string | null {
  if (!ref.startsWith('#')) return null;
  const parts = ref.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

export function extractApiGraph(
  api: LoadedApi,
  /** Root to report spec paths against, matching how modules are reported. */
  rootDir: string = process.cwd()
): ApiExtractionResult {
  const slug = slugify(api.title);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const unresolvedRefs: string[] = [];

  // Relative where the spec lives under the analyzed root, absolute when
  // it sits outside it — an unreadable `../../..` chain helps nobody.
  const relative = path.relative(rootDir, api.file);
  const file =
    relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative
      : api.file;

  let propertyCount = 0;

  // ── Service node ──────────────────────────────────────
  nodes.push({
    id: serviceId(slug),
    type: 'api_service',
    name: api.title,
    qualifiedName: slug,
    attributes: {
      specVersion: api.specVersion,
      apiVersion: api.version,
      basePath: api.basePath || undefined,
    },
    source: { file },
  });

  /**
   * Record a `$ref` as an edge to the named schema. Returns false when
   * the reference could not be resolved, so the caller can note it.
   */
  const linkRef = (fromId: string, ref: string, via: string): boolean => {
    const name = refName(ref);
    const resolved = api.resolveRef(ref);

    if (!name || !resolved || resolved.section !== 'schemas') {
      unresolvedRefs.push(ref);
      return false;
    }
    edges.push({
      from: fromId,
      to: schemaId(slug, name),
      type: 'api_ref',
      via,
    });
    return true;
  };

  /**
   * Emit one property node plus the edges it owns, then recurse into
   * inline sub-objects. `$ref`s become edges rather than inlined copies:
   * a shared schema stays one node, and the traversal path from a nested
   * field back to its consumers stays intact.
   */
  const emitProperty = (
    schemaName: string,
    parentId: string,
    propPath: string,
    propName: string,
    schema: OpenApiSchema,
    required: boolean,
    depth: number
  ): void => {
    const id = propertyId(slug, schemaName, propPath);

    // An array wrapping a single item type is described on the property
    // itself rather than as an extra node — `tags: string[]` is one field.
    const isArray = schema.type === 'array';
    const valueSchema = isArray && schema.items ? schema.items : schema;

    nodes.push({
      id,
      type: 'api_property',
      name: `${schemaName}.${propPath}`,
      qualifiedName: `${slug}:${schemaName}.${propPath}`,
      attributes: {
        property: propName,
        path: propPath,
        schema: schemaName,
        dataType: describeType(schema),
        required,
        array: isArray || undefined,
        nullable: schema.nullable || undefined,
        deprecated: schema.deprecated || undefined,
        enum: schema.enum ? schema.enum.map(String) : undefined,
        description: schema.description || undefined,
      },
      source: { file },
    });
    propertyCount++;

    edges.push({
      from: parentId,
      to: id,
      type: 'api_contains',
      via: propName,
    });

    if (valueSchema.$ref) {
      linkRef(id, valueSchema.$ref, isArray ? 'items' : 'property');
      return;
    }

    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
      for (const variant of valueSchema[key] ?? []) {
        if (variant.$ref) linkRef(id, variant.$ref, key);
      }
    }

    if (depth >= MAX_INLINE_DEPTH) return;

    // Inline object: its fields are fields of this schema, addressed by
    // dotted path (LoginSuccess.auth.token).
    for (const [childName, childSchema] of Object.entries(
      valueSchema.properties ?? {}
    )) {
      emitProperty(
        schemaName,
        id,
        `${propPath}.${childName}`,
        childName,
        childSchema,
        (valueSchema.required ?? []).includes(childName),
        depth + 1
      );
    }
  };

  // ── Schema nodes ──────────────────────────────────────
  const schemaNames = Object.keys(api.schemas);

  for (const name of schemaNames) {
    const schema = api.schemas[name];
    const id = schemaId(slug, name);

    nodes.push({
      id,
      type: 'api_schema',
      name,
      qualifiedName: `${slug}:${name}`,
      attributes: {
        service: api.title,
        dataType: describeType(schema),
        deprecated: schema.deprecated || undefined,
        description: schema.description || undefined,
        enum: schema.enum ? schema.enum.map(String) : undefined,
      },
      source: { file },
    });

    // Composition keywords are references between schemas in their own
    // right — `AdminUser: allOf [User, {...}]` means a change to User
    // reaches AdminUser.
    for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
      for (const variant of schema[key] ?? []) {
        if (variant.$ref) linkRef(id, variant.$ref, key);
      }
    }

    if (schema.$ref) linkRef(id, schema.$ref, 'alias');

    // A top-level array schema carries its item type by reference.
    if (schema.type === 'array' && schema.items?.$ref) {
      linkRef(id, schema.items.$ref, 'items');
    }

    // Own properties, plus properties contributed by allOf branches —
    // an allOf member's inline fields belong to this schema.
    const propertySources: OpenApiSchema[] = [
      schema,
      ...(schema.allOf ?? []).filter(v => !v.$ref),
    ];

    for (const source of propertySources) {
      const required = source.required ?? [];
      for (const [propName, propSchema] of Object.entries(
        source.properties ?? {}
      )) {
        emitProperty(
          name,
          id,
          propName,
          propName,
          propSchema,
          required.includes(propName),
          1
        );
      }
    }
  }

  // ── Operation nodes ───────────────────────────────────
  let operationCount = 0;

  for (const [route, pathItem] of Object.entries(api.document.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    // Parameters declared on the path apply to every operation under it.
    const sharedParams = (pathItem.parameters ?? []) as OpenApiParameter[];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!operation || typeof operation !== 'object') continue;

      const fullRoute = `${api.basePath}${route}`;
      const id = operationId(slug, method, fullRoute);
      const label = `${method.toUpperCase()} ${fullRoute}`;

      nodes.push({
        id,
        type: 'api_operation',
        name: label,
        qualifiedName: `${slug}:${label}`,
        attributes: {
          method: method.toUpperCase(),
          route: fullRoute,
          operationId: operation.operationId || undefined,
          service: api.title,
          summary: operation.summary || undefined,
          tags: operation.tags?.length ? operation.tags : undefined,
          deprecated: operation.deprecated || undefined,
        },
        source: { file },
      });
      operationCount++;

      edges.push({
        from: serviceId(slug),
        to: id,
        type: 'api_serves',
        via: label,
      });

      // Resolve `$ref`d parameters before merging, so a shared parameter
      // component is inspected rather than skipped.
      const rawParams = [...sharedParams, ...(operation.parameters ?? [])];
      const params: OpenApiParameter[] = rawParams.map(p => {
        if (!p?.$ref) return p;
        const resolved = api.resolveRef(p.$ref);
        if (!resolved) {
          unresolvedRefs.push(p.$ref);
          return p;
        }
        return resolved.value as OpenApiParameter;
      });

      // Request body (OAS3 `requestBody`, or Swagger 2.0 `in: body`).
      const bodySchema = requestBodySchema(api, operation.requestBody, params);
      if (bodySchema) {
        const target = bodySchema.type === 'array' && bodySchema.items
          ? bodySchema.items
          : bodySchema;

        if (target.$ref) {
          const name = refName(target.$ref);
          if (name && api.resolveRef(target.$ref)?.section === 'schemas') {
            edges.push({
              from: id,
              to: schemaId(slug, name),
              type: 'api_request',
              via: 'requestBody',
            });
          } else {
            unresolvedRefs.push(target.$ref);
          }
        }
      }

      // Non-body parameters.
      for (const param of params) {
        if (!param || param.in === 'body') continue;
        const pSchema = parameterSchema(param);
        if (!pSchema) continue;

        const target = pSchema.type === 'array' && pSchema.items
          ? pSchema.items
          : pSchema;

        if (target.$ref) {
          const name = refName(target.$ref);
          if (name && api.resolveRef(target.$ref)?.section === 'schemas') {
            edges.push({
              from: id,
              to: schemaId(slug, name),
              type: 'api_parameter',
              via: `${param.in}.${param.name}`,
            });
          } else {
            unresolvedRefs.push(target.$ref);
          }
        }
      }

      // Responses. Every declared status code that names a schema is a
      // separate promise this operation makes.
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        const rSchema = responseSchema(api, response);
        if (!rSchema) continue;

        const target = rSchema.type === 'array' && rSchema.items
          ? rSchema.items
          : rSchema;

        if (target.$ref) {
          const name = refName(target.$ref);
          if (name && api.resolveRef(target.$ref)?.section === 'schemas') {
            edges.push({
              from: id,
              to: schemaId(slug, name),
              type: 'api_response',
              via: status,
            });
          } else {
            unresolvedRefs.push(target.$ref);
          }
        }
      }
    }
  }

  return {
    nodes,
    edges,
    operationCount,
    schemaCount: schemaNames.length,
    propertyCount,
    unresolvedRefs: Array.from(new Set(unresolvedRefs)),
  };
}
