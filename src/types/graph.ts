/**
 * Deep-Graph Type System
 * 
 * Typed nodes (resolved from compiler state), typed edges
 * (resolved relationships, not string matches), and placeholder
 * nodes for external/cross-boundary references.
 *
 * The compiler-observation thesis: read the resolved state,
 * don't reparse the source.
 */

// ── Node Types ──────────────────────────────────────────

export type NodeType =
  | 'module'            // a source file
  | 'function'          // function declaration or exported arrow
  | 'class'             // class declaration
  | 'method'            // method or constructor declared on a class
  | 'interface'         // interface declaration
  | 'type_alias'        // type declaration
  | 'variable'          // exported const/let
  | 'enum'              // enum declaration
  | 'record'            // Java record declaration
  | 'annotation'        // Java annotation declaration
  | 'external_package'  // placeholder for npm dependency
  // ── OpenAPI contract surface ──
  | 'api_service'       // one OpenAPI document (info.title)
  | 'api_operation'     // one method+path pair (POST /login)
  | 'api_schema'        // a named schema (components.schemas.X)
  | 'api_property';     // a single field on a schema (LoginSuccess.auth)

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  /** Fully qualified name (e.g., src/utils/helpers.ts::formatDate) */
  qualifiedName?: string;
  attributes: Record<string, any>;
  source: {
    file: string;
    line?: number;
    column?: number;
  };
}

// ── Edge Types ──────────────────────────────────────────

export type EdgeType =
  | 'import'           // file imports from file
  | 'call'             // function calls function
  | 'extends'          // class extends class
  | 'implements'       // class implements interface
  | 'overrides'        // Java method overrides or implements another method
  | 'depends_on'       // class depends on another via constructor parameter type
  | 'type_reference'   // symbol uses type
  | 'composition'      // module contains symbol (parent-child)
  | 'export'           // module re-exports from another module
  // ── OpenAPI contract surface ──
  //
  // Direction is always declaration -> declared thing, so the existing
  // reverse traversal walks a field back out to everything that would
  // break: property -> schema -> operation -> implementation/consumer.
  | 'api_serves'       // service declares operation
  | 'api_request'      // operation accepts schema as request body
  | 'api_response'     // operation returns schema
  | 'api_parameter'    // operation accepts schema via path/query/header
  | 'api_contains'     // schema declares property (or property nests property)
  | 'api_ref'          // schema/property references another schema ($ref, allOf, …)
  // ── bridges between TypeScript and the contract ──
  | 'api_implements'   // TS symbol implements an operation (server side)
  | 'api_consumes';    // TS symbol calls an operation (client side)

/**
 * How a TypeScript <-> OpenAPI bridge edge was established.
 *
 * Ordered most to least trustworthy. Anything below `shared_type` is a
 * heuristic and is reported as such — a `User` schema and a `User`
 * interface are not the same thing just because they share a name.
 */
export type BridgeConfidence =
  | 'explicit'      // @openapi annotation or a manifest entry
  | 'generated'     // metadata emitted by an OpenAPI client generator
  | 'framework'     // route decorator / router registration matched
  | 'shared_type'   // the TS type is generated from, or shared with, the schema
  | 'inferred';     // name match only — lowest confidence

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  via?: string;         // the import specifier, method name, etc.
  /** Set only on `api_implements` / `api_consumes` bridge edges. */
  confidence?: BridgeConfidence;
  /** Evidence for a language-server-resolved relationship. */
  evidence?: {
    provider: 'jdtls';
    kind: 'reference' | 'implementation' | 'incoming_call';
    file: string;
    line: number;
  };
}

// ── Metadata ────────────────────────────────────────────

export interface GraphMetadata {
  projectRoot: string;
  /** Primary source language used to construct this graph. */
  language?: 'typescript' | 'java';
  tsVersion: string;
  nodeCount: number;
  edgeCount: number;
  moduleCount: number;
  symbolCount: number;
  externalPackages: number;
  generatedAt: string;
  /** TypeScript workspace discovery and module-resolution evidence. */
  workspace?: {
    mode: 'single-project' | 'workspace';
    packageManager?: 'bun' | 'pnpm' | 'yarn' | 'npm';
    taskRunner?: 'turbo' | 'nx';
    workspacePatterns: string[];
    discoveredProjects: Array<{
      configPath: string;
      directory: string;
      packageName?: string;
      sourceFileCount: number;
    }>;
    resolvedWorkspaceImports: number;
    unresolvedWorkspaceImports: string[];
  };
  /** Present when a language server enriched a structural graph. */
  semantic?: {
    provider: 'jdtls';
    status: 'available' | 'unavailable' | 'partial';
    references: number;
    implementations: number;
    calls: number;
    diagnostics: number;
    /** First diagnostics returned by JDT LS; capped to keep graph files bounded. */
    diagnosticSamples?: Array<{
      file: string;
      line: number;
      severity?: 'error' | 'warning' | 'information' | 'hint';
      message: string;
    }>;
    message?: string;
  };
  /** Present only when an OpenAPI document was analyzed. */
  api?: {
    /** Source documents, by path, with the title each declared. */
    sources: Array<{ file: string; title: string; version: string }>;
    operationCount: number;
    schemaCount: number;
    propertyCount: number;
    /** Bridge edges to TypeScript, counted by how they were established. */
    bridges: Partial<Record<BridgeConfidence, number>>;
  };
}

// ── Top-Level Graph ─────────────────────────────────────

export interface DependencyGraph {
  metadata: GraphMetadata;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
