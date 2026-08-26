import type { CompilerState } from '../compiler/loader';
import type { DependencyGraph, GraphMetadata } from '../types/graph';
import { extractModules } from './modules';
import { extractSymbols } from './symbols';
import { extractCalls } from './calls';
import { extractConstructorDeps } from './constructors';

/**
 * Orchestrates the full graph extraction from compiler state.
 *
 * Pipeline:
 * 1. Nodes first (modules, then symbols)
 * 2. Edges second (imports, then symbol relationships, then calls)
 * 3. Metadata last
 */
export function extractGraph(state: CompilerState): DependencyGraph {
  // Phase 1: Module-level graph
  const moduleResult = extractModules(state);

  // Phase 2: Symbol-level graph
  const symbolResult = extractSymbols(state);

  // Phase 3: Call graph — depends on symbol nodes to know which
  // call targets are trackable.
  const callResult = extractCalls(state, symbolResult.symbolNodes);

  // Phase 4: Constructor dependency resolution — resolves every
  // class's constructor parameter types to their declaring
  // class/interface. No framework knowledge required: the checker
  // resolves type annotations the same way regardless of whether
  // a DI container wires them at runtime.
  const ctorResult = extractConstructorDeps(state, symbolResult.symbolNodes);

  // Enrich class nodes with decorator names (optional metadata, not
  // used for edge extraction — purely for display/filtering)
  for (const node of symbolResult.symbolNodes) {
    const decorators = ctorResult.decoratorAttributes.get(node.id);
    if (decorators && decorators.length > 0) {
      node.attributes.decorators = decorators;
    }
  }

  // Combine all nodes
  const nodes = [
    ...moduleResult.moduleNodes,
    ...moduleResult.externalNodes,
    ...symbolResult.symbolNodes,
  ];

  // Combine all edges
  const edges = [
    ...moduleResult.importEdges,
    ...moduleResult.compositionEdges,
    ...symbolResult.symbolEdges,
    ...symbolResult.compositionEdges,
    ...callResult.callEdges,
    ...ctorResult.dependsOnEdges,
  ];

  // Metadata
  const metadata: GraphMetadata = {
    projectRoot: state.projectRoot,
    language: 'typescript',
    tsVersion: state.tsVersion,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    moduleCount: moduleResult.moduleNodes.length,
    symbolCount: symbolResult.symbolNodes.length,
    externalPackages: moduleResult.externalNodes.length,
    generatedAt: new Date().toISOString(),
  };

  return { metadata, nodes, edges };
}
