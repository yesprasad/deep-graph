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
  | 'module'            // a .ts/.tsx source file
  | 'function'          // function declaration or exported arrow
  | 'class'             // class declaration
  | 'method'            // method or constructor declared on a class
  | 'interface'         // interface declaration
  | 'type_alias'        // type declaration
  | 'variable'          // exported const/let
  | 'enum'              // enum declaration
  | 'external_package'; // placeholder for npm dependency

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
  | 'depends_on'       // class depends on another via constructor parameter type
  | 'type_reference'   // symbol uses type
  | 'composition'      // module contains symbol (parent-child)
  | 'export';          // module re-exports from another module

export interface GraphEdge {
  from: string;
  to: string;
  type: EdgeType;
  via?: string;         // the import specifier, method name, etc.
}

// ── Metadata ────────────────────────────────────────────

export interface GraphMetadata {
  projectRoot: string;
  tsVersion: string;
  nodeCount: number;
  edgeCount: number;
  moduleCount: number;
  symbolCount: number;
  externalPackages: number;
  generatedAt: string;
}

// ── Top-Level Graph ─────────────────────────────────────

export interface DependencyGraph {
  metadata: GraphMetadata;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
