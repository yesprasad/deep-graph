import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { loadProject } from '../compiler/loader';
import { extractGraph } from '../extractor';
// Shared with the CLI on purpose: two copies of blast traversal drift,
// and the MCP server silently losing API-node support is exactly the
// class of duplicated-contract bug deep-graph exists to surface.
import { resolveTarget, reverseTraverse } from '../cli/blast';
import { buildApiGraph, mergeApiGraph } from '../openapi';
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
  let graph = extractGraph(state);

  // Fold in an API document sitting at the project root, if there is one.
  // An AI reviewer asking about a schema field should get the contract
  // surface without the caller having had to name the spec first.
  const specs = discoverSpecs(targetDir);
  if (specs.length > 0) {
    try {
      graph = mergeApiGraph(graph, buildApiGraph(specs, state, targetDir));
    } catch {
      // A malformed spec must not take down the TypeScript graph — the
      // caller asked about code, and that answer is still available.
    }
  }

  cachedGraph = graph;
  cachedProjectRoot = targetDir;
  return cachedGraph;
}

/** Conventional spec filenames at a project root. */
const SPEC_NAMES = [
  'openapi.json', 'openapi.yaml', 'openapi.yml',
  'swagger.json', 'swagger.yaml', 'swagger.yml',
];

function discoverSpecs(dir: string): string[] {
  return SPEC_NAMES
    .map(name => path.join(dir, name))
    .filter(file => fs.existsSync(file));
}

const server = new McpServer({
  name: 'deep-graph',
  version: '0.2.0',
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

server.tool(
  'api_contract',
  'Inspect the OpenAPI contract surface: operations, schemas, and every schema field as its own addressable node. ' +
  'Use this to answer "what does this endpoint return", "which endpoints carry this schema", or "what fields does this schema declare". ' +
  'Field names are addressable as "Schema.field" and can be passed straight to blast_radius to find the code that breaks if the field changes.',
  {
    subject: z.string().optional().describe(
      'Operation ("POST /login"), schema ("LoginSuccess"), or field ("LoginSuccess.auth"). Omit to list the whole surface.'
    ),
    project_dir: z.string().optional().describe('Project directory (defaults to cwd)'),
  },
  async ({ subject, project_dir }) => {
    try {
      const graph = getGraph(project_dir);
      const apiNodes = graph.nodes.filter(n => n.type.startsWith('api_'));

      if (apiNodes.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No OpenAPI contract in this graph.',
              hint: 'Run: deep-graph analyze --openapi <spec.json>, or place openapi.json / swagger.json at the project root.',
            }, null, 2),
          }],
        };
      }

      if (!subject) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              services: apiNodes.filter(n => n.type === 'api_service').map(n => n.name),
              operations: apiNodes
                .filter(n => n.type === 'api_operation')
                .map(n => ({ name: n.name, operationId: n.attributes.operationId })),
              schemas: apiNodes.filter(n => n.type === 'api_schema').map(n => n.name),
              field_count: apiNodes.filter(n => n.type === 'api_property').length,
            }, null, 2),
          }],
        };
      }

      const node = resolveTarget(graph, subject);
      if (!node || !node.type.startsWith('api_')) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: `"${subject}" is not part of the API contract.`,
              available: apiNodes.slice(0, 30).map(n => n.name),
            }, null, 2),
          }],
        };
      }

      // What this node declares, one hop out. For a schema that is its
      // fields; for an operation, the schemas it accepts and returns.
      const declares = graph.edges
        .filter(e => e.from === node.id)
        .map(e => {
          const target = graph.nodes.find(n => n.id === e.to);
          return target
            ? {
                name: target.name,
                type: target.type,
                relationship: e.type,
                via: e.via,
                data_type: target.attributes.dataType,
                required: target.attributes.required,
              }
            : null;
        })
        .filter(Boolean);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            subject: node.name,
            type: node.type,
            file: node.source.file,
            attributes: node.attributes,
            declares,
            next_step: `Call blast_radius with target "${node.name}" to see the code affected by changing it.`,
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
