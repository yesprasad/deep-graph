import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { loadProject } from '../compiler/loader';
import { extractGraph } from '../extractor';
import type { DependencyGraph, GraphNode } from '../types/graph';

let cachedGraph: DependencyGraph | null = null;
let cachedProjectRoot: string | null = null;

function getGraph(projectDir?: string): DependencyGraph {
  const targetDir = path.resolve(projectDir || process.cwd());

  if (cachedGraph && cachedProjectRoot === targetDir) {
    return cachedGraph;
  }

  const graphPath = path.join(targetDir, 'deep-graph.json');
  if (fs.existsSync(graphPath)) {
    cachedGraph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    cachedProjectRoot = targetDir;
    return cachedGraph!;
  }

  const state = loadProject(targetDir);
  cachedGraph = extractGraph(state);
  cachedProjectRoot = targetDir;
  return cachedGraph;
}

function reverseTraverse(
  graph: DependencyGraph,
  targetId: string,
  maxDepth: number
): Array<{ name: string; type: string; file: string; reason: string; depth: number }> {
  const impacted: Array<{ name: string; type: string; file: string; reason: string; depth: number }> = [];
  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; depth: number }> = [];

  visited.add(targetId);

  const childIds = new Set<string>();
  const frontier = [targetId];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const edge of graph.edges) {
      if (edge.from === current && edge.type === 'composition' && !childIds.has(edge.to)) {
        childIds.add(edge.to);
        visited.add(edge.to);
        frontier.push(edge.to);
      }
    }
  }

  const targetIds = new Set([targetId, ...childIds]);

  for (const edge of graph.edges) {
    if (targetIds.has(edge.to) && !visited.has(edge.from)) {
      queue.push({ nodeId: edge.from, depth: 1 });
      visited.add(edge.from);
    }
  }

  while (queue.length > 0) {
    const { nodeId, depth } = queue.shift()!;
    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) continue;

    const connectingEdge = graph.edges.find(
      e => e.from === nodeId && targetIds.has(e.to)
    );

    let reason = 'transitive dependency';
    if (connectingEdge) {
      switch (connectingEdge.type) {
        case 'import': reason = `imports via ${connectingEdge.via || 'direct'}`; break;
        case 'call': reason = `calls ${connectingEdge.via || 'function'}`; break;
        case 'depends_on': reason = `depends on ${connectingEdge.via || 'parameter'}`; break;
        case 'extends': reason = `extends ${connectingEdge.via || 'class'}`; break;
        case 'implements': reason = `implements ${connectingEdge.via || 'interface'}`; break;
        case 'type_reference': reason = `references type ${connectingEdge.via || ''}`; break;
        case 'composition': reason = 'contains symbol'; break;
        default: reason = connectingEdge.type;
      }
    }

    impacted.push({
      name: node.name,
      type: node.type,
      file: node.source.file,
      reason,
      depth,
    });

    if (depth < maxDepth) {
      const parentEdge = graph.edges.find(
        e => e.to === nodeId && e.type === 'composition'
      );
      if (parentEdge && !visited.has(parentEdge.from)) {
        visited.add(parentEdge.from);
        for (const edge of graph.edges) {
          if (edge.to === parentEdge.from && !visited.has(edge.from)) {
            queue.push({ nodeId: edge.from, depth: depth + 1 });
            visited.add(edge.from);
          }
        }
      }

      for (const edge of graph.edges) {
        if (edge.to === nodeId && !visited.has(edge.from)) {
          queue.push({ nodeId: edge.from, depth: depth + 1 });
          visited.add(edge.from);
        }
      }
    }
  }

  return impacted;
}

function resolveTarget(graph: DependencyGraph, target: string): GraphNode | null {
  let node = graph.nodes.find(n => n.name === target);
  if (node) return node;

  node = graph.nodes.find(
    n => n.type === 'module' &&
      (n.name === target ||
        n.name === `src/${target}` ||
        n.name.endsWith(`/${target}`) ||
        n.name.endsWith(`${target}.ts`) ||
        n.name.endsWith(`${target}.tsx`))
  );
  if (node) return node;

  node = graph.nodes.find(n => n.qualifiedName === target);
  if (node) return node;

  node = graph.nodes.find(
    n => n.type !== 'module' && n.type !== 'external_package' && n.name === target
  );
  return node || null;
}

const server = new McpServer({
  name: 'deep-graph',
  version: '0.1.0',
}, {
  capabilities: {
    tools: {},
  },
});

server.tool(
  'blast_radius',
  'Compiler-resolved blast radius: returns every file and symbol that depends on the target, traced through the TypeScript type checker. No heuristics.',
  {
    target: z.string().describe('File path (e.g. "src/auth.service.ts") or symbol name (e.g. "AuthService")'),
    depth: z.number().optional().default(5).describe('Max traversal depth (default 5)'),
    project_dir: z.string().optional().describe('Project directory (defaults to cwd)'),
  },
  async ({ target, depth, project_dir }) => {
    try {
      const graph = getGraph(project_dir);
      const targetNode = resolveTarget(graph, target);

      if (!targetNode) {
        const available = graph.nodes
          .filter(n => n.type !== 'external_package')
          .slice(0, 20)
          .map(n => n.name);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `Target "${target}" not found in graph`,
              available_targets: available,
            }, null, 2),
          }],
        };
      }

      const impacted = reverseTraverse(graph, targetNode.id, depth);
      const riskLevel = impacted.length < 3 ? 'LOW' : impacted.length < 8 ? 'MEDIUM' : 'HIGH';

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            target: targetNode.name,
            target_type: targetNode.type,
            target_file: targetNode.source.file,
            risk_level: riskLevel,
            total_impacted: impacted.length,
            impacted: impacted.sort((a, b) => a.depth - b.depth),
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'dependencies',
  'Returns the direct inbound and outbound dependency edges for a given node — what it depends on and what depends on it.',
  {
    target: z.string().describe('File path or symbol name'),
    project_dir: z.string().optional().describe('Project directory (defaults to cwd)'),
  },
  async ({ target, project_dir }) => {
    try {
      const graph = getGraph(project_dir);
      const targetNode = resolveTarget(graph, target);

      if (!targetNode) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: `Target "${target}" not found` }, null, 2),
          }],
        };
      }

      const outbound = graph.edges
        .filter(e => e.from === targetNode.id && e.type !== 'composition')
        .map(e => {
          const toNode = graph.nodes.find(n => n.id === e.to);
          return { type: e.type, target: toNode?.name || e.to, via: e.via };
        });

      const inbound = graph.edges
        .filter(e => e.to === targetNode.id && e.type !== 'composition')
        .map(e => {
          const fromNode = graph.nodes.find(n => n.id === e.from);
          return { type: e.type, source: fromNode?.name || e.from, via: e.via };
        });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            node: targetNode.name,
            node_type: targetNode.type,
            file: targetNode.source.file,
            depends_on: outbound,
            depended_on_by: inbound,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'unused_exports',
  'Lists exported symbols with zero inbound edges — dead code that nothing imports, calls, extends, or depends on.',
  {
    project_dir: z.string().optional().describe('Project directory (defaults to cwd)'),
  },
  async ({ project_dir }) => {
    try {
      const graph = getGraph(project_dir);

      const exportedSymbols = graph.nodes.filter(
        n => n.type !== 'module' && n.type !== 'external_package' && n.attributes.exported
      );

      const hasInbound = new Set<string>();
      for (const edge of graph.edges) {
        if (edge.type !== 'composition') {
          hasInbound.add(edge.to);
        }
      }

      const unused = exportedSymbols
        .filter(n => !hasInbound.has(n.id))
        .map(n => ({
          name: n.name,
          type: n.type,
          file: n.source.file,
          line: n.source.line,
        }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total_exports: exportedSymbols.length,
            unused_count: unused.length,
            unused,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'graph_summary',
  'Returns high-level project structure: module count, symbol count, edge types, most-connected nodes (god nodes).',
  {
    project_dir: z.string().optional().describe('Project directory (defaults to cwd)'),
    top_n: z.number().optional().default(10).describe('Number of top-connected nodes to return'),
  },
  async ({ project_dir, top_n }) => {
    try {
      const graph = getGraph(project_dir);

      const inDegree = new Map<string, number>();
      for (const edge of graph.edges) {
        if (edge.type !== 'composition') {
          inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
        }
      }

      const topNodes = [...inDegree.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, top_n)
        .map(([id, count]) => {
          const node = graph.nodes.find(n => n.id === id);
          return { name: node?.name || id, type: node?.type, in_degree: count };
        });

      const edgeTypes: Record<string, number> = {};
      for (const edge of graph.edges) {
        edgeTypes[edge.type] = (edgeTypes[edge.type] || 0) + 1;
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            project_root: graph.metadata.projectRoot,
            ts_version: graph.metadata.tsVersion,
            modules: graph.metadata.moduleCount,
            symbols: graph.metadata.symbolCount,
            external_packages: graph.metadata.externalPackages,
            total_nodes: graph.metadata.nodeCount,
            total_edges: graph.metadata.edgeCount,
            edge_types: edgeTypes,
            most_depended_on: topNodes,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`deep-graph MCP server error: ${err.message}\n`);
  process.exit(1);
});
