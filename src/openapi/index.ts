import type { CompilerState } from '../compiler/loader';
import type {
  BridgeConfidence,
  DependencyGraph,
  GraphEdge,
  GraphNode,
} from '../types/graph';
import { loadOpenApi, type LoadedApi } from './loader';
import { extractApiGraph } from './extractor';
import { bridgeToTypeScript } from './bridge';

export { loadOpenApi } from './loader';
export { extractApiGraph } from './extractor';
export { bridgeToTypeScript } from './bridge';
export { diffApiGraphs, type ApiChange, type ApiDiff } from './diff';

export interface ApiGraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  sources: Array<{ file: string; title: string; version: string }>;
  operationCount: number;
  schemaCount: number;
  propertyCount: number;
  unresolvedRefs: string[];
  bridges: Partial<Record<BridgeConfidence, number>>;
}

/**
 * Build the contract-surface graph from one or more OpenAPI documents,
 * optionally bridged to a loaded TypeScript program.
 *
 * Without `state`, this is a standalone API graph — useful on its own for
 * "who else returns this schema" questions in a repo with no TypeScript.
 * With `state`, blast radius crosses the boundary: a removed field walks
 * out through its schema and operations into the code that serves and
 * calls them.
 */
export function buildApiGraph(
  specPaths: string[],
  state?: CompilerState | null,
  /** Root that spec paths are reported relative to. */
  rootDir?: string
): ApiGraphResult {
  // Default to the TypeScript project root so spec and module paths in
  // the same graph are quoted against the same base.
  const root = rootDir ?? state?.projectRoot ?? process.cwd();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sources: ApiGraphResult['sources'] = [];
  const unresolvedRefs: string[] = [];

  let operationCount = 0;
  let schemaCount = 0;
  let propertyCount = 0;

  const loaded: LoadedApi[] = specPaths.map(loadOpenApi);

  for (const api of loaded) {
    const result = extractApiGraph(api, root);
    nodes.push(...result.nodes);
    edges.push(...result.edges);
    unresolvedRefs.push(...result.unresolvedRefs);

    operationCount += result.operationCount;
    schemaCount += result.schemaCount;
    propertyCount += result.propertyCount;

    sources.push({ file: api.file, title: api.title, version: api.version });
  }

  let bridges: Partial<Record<BridgeConfidence, number>> = {};
  if (state) {
    const bridge = bridgeToTypeScript(state, nodes);
    edges.push(...bridge.edges);
    bridges = bridge.counts;
  }

  return {
    nodes,
    edges,
    sources,
    operationCount,
    schemaCount,
    propertyCount,
    unresolvedRefs: Array.from(new Set(unresolvedRefs)),
    bridges,
  };
}

/**
 * Fold an API graph into an existing TypeScript graph, recomputing the
 * counts that describe the combined result.
 */
export function mergeApiGraph(
  graph: DependencyGraph,
  api: ApiGraphResult
): DependencyGraph {
  const nodes = [...graph.nodes, ...api.nodes];
  const edges = [...graph.edges, ...api.edges];

  return {
    metadata: {
      ...graph.metadata,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      api: {
        sources: api.sources,
        operationCount: api.operationCount,
        schemaCount: api.schemaCount,
        propertyCount: api.propertyCount,
        bridges: api.bridges,
      },
    },
    nodes,
    edges,
  };
}

/**
 * A graph containing only the contract surface, for repositories where
 * the spec is the artifact under review.
 */
export function standaloneApiGraph(api: ApiGraphResult): DependencyGraph {
  return {
    metadata: {
      projectRoot: api.sources[0]?.file ?? '',
      tsVersion: '',
      nodeCount: api.nodes.length,
      edgeCount: api.edges.length,
      moduleCount: 0,
      symbolCount: 0,
      externalPackages: 0,
      generatedAt: new Date().toISOString(),
      api: {
        sources: api.sources,
        operationCount: api.operationCount,
        schemaCount: api.schemaCount,
        propertyCount: api.propertyCount,
        bridges: api.bridges,
      },
    },
    nodes: api.nodes,
    edges: api.edges,
  };
}
