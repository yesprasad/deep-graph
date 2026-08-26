import fs from 'fs';
import path from 'path';
import type {
  OpenApiDocument,
  OpenApiParameter,
  OpenApiRequestBody,
  OpenApiResponse,
  OpenApiSchema,
} from './types';

/**
 * OPENAPI LOADER
 *
 * Parses an OpenAPI 3.x or Swagger 2.0 document and normalizes the two
 * dialects onto one shape, so the extractor never branches on version.
 *
 * `$ref` pointers are resolved but deliberately NOT inlined. A ref is a
 * real relationship in the contract, and flattening it would both
 * duplicate every shared schema and sever the traversal path that makes
 * field-level blast radius work.
 */

export interface LoadedApi {
  /** Absolute path the document was read from. */
  file: string;
  title: string;
  version: string;
  /** '2.0' | '3.0.x' | '3.1.x' */
  specVersion: string;
  document: OpenApiDocument;
  /** Named schemas, keyed by schema name (dialect-normalized). */
  schemas: Record<string, OpenApiSchema>;
  /** Prefix every path is served under (Swagger 2.0 `basePath`). */
  basePath: string;
  /** Resolve a local `$ref` pointer to the object it names. */
  resolveRef: (ref: string) => ResolvedRef | null;
}

export interface ResolvedRef {
  /** The schema name, when the pointer targets a named schema. */
  name: string | null;
  /** Which section of the document the pointer landed in. */
  section: 'schemas' | 'parameters' | 'requestBodies' | 'responses' | 'other';
  value: unknown;
}

function parseDocument(file: string): OpenApiDocument {
  const raw = fs.readFileSync(file, 'utf-8');
  const ext = path.extname(file).toLowerCase();

  if (ext === '.json') {
    try {
      return JSON.parse(raw) as OpenApiDocument;
    } catch (error) {
      throw new Error(
        `${file} is not valid JSON: ${(error as Error).message}`
      );
    }
  }

  if (ext === '.yaml' || ext === '.yml') {
    let yaml: { parse(src: string): unknown };
    try {
      // Optional dependency: only YAML specs need it.
      yaml = require('yaml');
    } catch {
      throw new Error(
        `Reading ${path.basename(file)} requires the "yaml" package.\n` +
        `   Install it with:  npm install yaml\n` +
        `   Or convert the spec to JSON and pass that instead.`
      );
    }
    try {
      return yaml.parse(raw) as OpenApiDocument;
    } catch (error) {
      throw new Error(
        `${file} is not valid YAML: ${(error as Error).message}`
      );
    }
  }

  // Unknown extension — try JSON, then YAML, before giving up.
  try {
    return JSON.parse(raw) as OpenApiDocument;
  } catch {
    try {
      const yaml = require('yaml') as { parse(src: string): unknown };
      return yaml.parse(raw) as OpenApiDocument;
    } catch {
      throw new Error(
        `Could not parse ${file} as JSON or YAML. ` +
        `Expected an OpenAPI 3.x or Swagger 2.0 document.`
      );
    }
  }
}

/**
 * Walk a JSON Pointer (the fragment part of a `$ref`) into the document.
 * Returns undefined when any segment is missing.
 */
function walkPointer(doc: unknown, pointer: string): unknown {
  const segments = pointer
    .split('/')
    .filter(Boolean)
    // JSON Pointer escapes: ~1 is '/', ~0 is '~'. Order matters.
    .map(s => decodeURIComponent(s).replace(/~1/g, '/').replace(/~0/g, '~'));

  let current: unknown = doc;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * Classify a local pointer so the extractor knows whether it landed on a
 * named schema (which becomes a node) or something else.
 */
function classifyPointer(pointer: string): {
  name: string | null;
  section: ResolvedRef['section'];
} {
  const parts = pointer.split('/').filter(Boolean);

  // OAS3: components/schemas/Name    Swagger 2.0: definitions/Name
  if (parts[0] === 'components' && parts.length >= 3) {
    const section = parts[1];
    const name = parts.slice(2).join('/');
    if (section === 'schemas') return { name, section: 'schemas' };
    if (section === 'parameters') return { name, section: 'parameters' };
    if (section === 'requestBodies') return { name, section: 'requestBodies' };
    if (section === 'responses') return { name, section: 'responses' };
    return { name, section: 'other' };
  }

  if (parts[0] === 'definitions' && parts.length >= 2) {
    return { name: parts.slice(1).join('/'), section: 'schemas' };
  }
  if (parts[0] === 'parameters' && parts.length >= 2) {
    return { name: parts.slice(1).join('/'), section: 'parameters' };
  }
  if (parts[0] === 'responses' && parts.length >= 2) {
    return { name: parts.slice(1).join('/'), section: 'responses' };
  }

  return { name: null, section: 'other' };
}

/**
 * Load and normalize one OpenAPI/Swagger document.
 *
 * External `$ref`s (pointing at another file) are left unresolved: they
 * are recorded as unresolved references rather than silently dropped, so
 * a partial spec degrades visibly instead of producing a graph that
 * looks complete.
 */
export function loadOpenApi(specPath: string): LoadedApi {
  const file = path.resolve(specPath);

  if (!fs.existsSync(file)) {
    throw new Error(`OpenAPI document not found: ${file}`);
  }

  const document = parseDocument(file);

  if (document === null || typeof document !== 'object') {
    throw new Error(`${file} did not parse to an object.`);
  }

  const specVersion = document.openapi || document.swagger || '';
  if (!specVersion) {
    throw new Error(
      `${file} declares neither "openapi" nor "swagger" — ` +
      `it does not look like an API document.`
    );
  }

  // Dialect normalization: Swagger 2.0 keeps schemas under `definitions`,
  // OpenAPI 3.x under `components.schemas`.
  const schemas: Record<string, OpenApiSchema> = {
    ...(document.definitions ?? {}),
    ...(document.components?.schemas ?? {}),
  };

  const resolveRef = (ref: string): ResolvedRef | null => {
    if (!ref.startsWith('#')) return null; // external ref — not resolved
    const pointer = ref.slice(1);
    const value = walkPointer(document, pointer);
    if (value === undefined) return null;
    const { name, section } = classifyPointer(pointer);
    return { name, section, value };
  };

  return {
    file,
    title: document.info?.title?.trim() || path.basename(file),
    version: document.info?.version?.trim() || '0.0.0',
    specVersion,
    document,
    schemas,
    basePath: document.basePath ?? '',
    resolveRef,
  };
}

// ── Dialect-normalizing accessors ───────────────────────

/**
 * The request-body schema for an operation, across both dialects.
 * Swagger 2.0 expresses it as a parameter with `in: body`.
 */
export function requestBodySchema(
  api: LoadedApi,
  requestBody: OpenApiRequestBody | undefined,
  parameters: OpenApiParameter[]
): OpenApiSchema | null {
  if (requestBody) {
    let body = requestBody;
    if (body.$ref) {
      const resolved = api.resolveRef(body.$ref);
      if (resolved) body = resolved.value as OpenApiRequestBody;
    }
    const content = body.content ?? {};
    // Prefer JSON; fall back to whatever media type is declared first.
    const jsonKey = Object.keys(content).find(k => k.includes('json'));
    const media = content[jsonKey ?? Object.keys(content)[0] ?? ''];
    if (media?.schema) return media.schema;
  }

  const bodyParam = parameters.find(p => p.in === 'body');
  return bodyParam?.schema ?? null;
}

/**
 * The schema returned for one response, across both dialects.
 */
export function responseSchema(
  api: LoadedApi,
  response: OpenApiResponse | undefined
): OpenApiSchema | null {
  if (!response) return null;

  let target = response;
  if (target.$ref) {
    const resolved = api.resolveRef(target.$ref);
    if (!resolved) return null;
    target = resolved.value as OpenApiResponse;
  }

  // Swagger 2.0
  if (target.schema) return target.schema;

  // OpenAPI 3.x
  const content = target.content ?? {};
  const jsonKey = Object.keys(content).find(k => k.includes('json'));
  const media = content[jsonKey ?? Object.keys(content)[0] ?? ''];
  return media?.schema ?? null;
}

/**
 * The schema for a non-body parameter, across both dialects.
 * Swagger 2.0 puts primitive types directly on the parameter object.
 */
export function parameterSchema(
  parameter: OpenApiParameter
): OpenApiSchema | null {
  if (parameter.schema) return parameter.schema;
  if (parameter.type) return { type: parameter.type };
  return null;
}
