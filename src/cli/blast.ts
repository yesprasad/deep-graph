import ts from 'typescript';
import path from 'path';
import chalk from 'chalk';
import Table from 'cli-table3';
import type { DependencyGraph, GraphNode, GraphEdge } from '../types/graph';

/**
 * BLAST RADIUS ENGINE
 * 
 * Algorithm:
 * 1. Resolve target (file or symbol)
 * 2. Reverse-traverse all edges pointing to/through that target
 * 3. Collect impacted artifacts with reasons
 * 4. Score risk level
 * 
 * The key difference from grep-based tools: edges are resolved
 * by the compiler, so we catch indirect dependencies that
 * string matching would miss.
 */

export interface ImpactRecord {
  name: string;
  type: string;
  file: string;
  reason: string;
  depth: number;
}

interface BlastResult {
  target: GraphNode;
  impacted: ImpactRecord[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

/**
 * Find the target node by name — could be a file path, symbol name,
 * or qualified name (file::symbol).
 */
/**
 * Resolve a target expressed in OpenAPI terms.
 *
 * Accepts the canonical prefixed forms as well as the bare names, and is
 * deliberately forgiving about which prefix was used — `api_schema:X.y`
 * names a property, and asking for it should not be an error.
 */
export function resolveApiTarget(
  graph: DependencyGraph,
  target: string
): GraphNode | null {
  const trimmed = target.trim();
  const prefixed = trimmed.match(/^(api_service|api_operation|api_schema|api_property):(.+)$/);
  const bare = prefixed ? prefixed[2].trim() : trimmed;

  // `api_operation:POST:/login` -> `POST /login`
  const asOperation = bare.replace(/^([A-Za-z]+):(\/.*)$/, '$1 $2');
  const operation = graph.nodes.find(
    n => n.type === 'api_operation' &&
      n.name.toLowerCase() === asOperation.toLowerCase()
  );
  if (operation) return operation;

  // A dotted name is a property; anything else is a schema or service.
  const wanted: Array<GraphNode['type']> = bare.includes('.')
    ? ['api_property', 'api_schema', 'api_service']
    : ['api_schema', 'api_service', 'api_property'];

  for (const type of wanted) {
    const match = graph.nodes.find(n => n.type === type && n.name === bare);
    if (match) return match;
  }

  // Case-insensitive last resort, still scoped to API nodes.
  const lowered = bare.toLowerCase();
  return (
    graph.nodes.find(
      n =>
        (n.type === 'api_property' ||
          n.type === 'api_schema' ||
          n.type === 'api_operation' ||
          n.type === 'api_service') &&
        n.name.toLowerCase() === lowered
    ) ?? null
  );
}

export function resolveTarget(
  graph: DependencyGraph,
  target: string
): GraphNode | null {
  target = target.replace(/\\/g, '/');
  // API targets are checked first when the target is explicitly prefixed,
  // so `api_schema:User` can never be shadowed by a TypeScript `User`.
  if (/^api_(service|operation|schema|property):/.test(target.trim())) {
    const api = resolveApiTarget(graph, target);
    if (api) return api;
  }

  // Try exact match on name
  let node = graph.nodes.find(n => n.name === target);
  if (node) return node;

  // Try matching as a file path (with or without src/ prefix)
  node = graph.nodes.find(
    n => n.type === 'module' &&
      (n.name === target ||
        n.name === `src/${target}` ||
        n.name.endsWith(`/${target}`) ||
        n.name.endsWith(`${target}.ts`) ||
        n.name.endsWith(`${target}.tsx`))
  );
  if (node) return node;

  // Try matching by qualified name
  node = graph.nodes.find(n => n.qualifiedName === target);
  if (node) return node;

  // Try matching symbol name (partial)
  node = graph.nodes.find(
    n => n.type !== 'module' &&
      n.type !== 'external_package' &&
      n.name === target
  );
  if (node) return node;

  // Unprefixed API forms — "POST /login", "LoginSuccess.auth" — resolve
  // last so TypeScript symbols keep priority on a bare name.
  return resolveApiTarget(graph, target);
}

/**
 * Multi-hop BFS reverse traversal.
 * Walks backward through edges to find everything that depends
 * on the target, directly or transitively.
 */
export function reverseTraverse(
  graph: DependencyGraph,
  targetId: string,
  maxDepth: number
): ImpactRecord[] {
  const impacted: ImpactRecord[] = [];
  const visited = new Set<string>();
  // The connecting edge travels with the queue entry. Looking it up later
  // only works for direct dependents, which left every deeper node
  // labelled "transitive dependency" — discarding exactly the detail that
  // makes a long chain readable.
  const queue: Array<{ nodeId: string; depth: number; via?: GraphEdge }> = [];

  // Seed: find all nodes that directly depend on the target
  // For modules: who imports this file?
  // For symbols: who calls/extends/implements/references this?
  visited.add(targetId);

  // Also include composition descendants of the target, transitively
  // (a module's classes, and each class's own methods, are all affected
  // by a change to the module — composition nests at least two levels
  // deep: module -> class -> method).
  const childIds = new Set<string>();
  const frontier = [targetId];
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const edge of graph.edges) {
      if (edge.from === current && edge.type === 'composition' && !childIds.has(edge.to)) {
        childIds.add(edge.to);
        visited.add(edge.to); // Don't report descendants as impacted
        frontier.push(edge.to);
      }
    }
  }

  // Find all edges pointing TO the target or its children
  const targetIds = new Set([targetId, ...childIds]);

  for (const edge of graph.edges) {
    if (targetIds.has(edge.to) && !visited.has(edge.from)) {
      queue.push({ nodeId: edge.from, depth: 1, via: edge });
      visited.add(edge.from);
    }
  }

  // BFS with depth limit
  while (queue.length > 0) {
    const { nodeId, depth, via } = queue.shift()!;

    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) continue;

    const connectingEdge = via;

    // Determine the reason for impact
    let reason: string;
    if (connectingEdge) {
      switch (connectingEdge.type) {
        case 'import':
          reason = `imports via ${connectingEdge.via || 'direct'}`;
          break;
        case 'call':
          reason = `calls ${connectingEdge.via || 'function'}`;
          break;
        case 'depends_on':
          reason = `depends on ${connectingEdge.via || 'parameter'}`;
          break;
        case 'extends':
          reason = `extends ${connectingEdge.via || 'class'}`;
          break;
        case 'implements':
          reason = `implements ${connectingEdge.via || 'interface'}`;
          break;
        case 'type_reference':
          reason = `references type ${connectingEdge.via || ''}`;
          break;
        case 'composition':
          reason = 'contains symbol';
          break;
        case 'api_serves':
          reason = 'serves endpoint';
          break;
        case 'api_request':
          reason = 'accepts as request body';
          break;
        case 'api_response':
          reason = `returns${connectingEdge.via ? ` (${connectingEdge.via})` : ''}`;
          break;
        case 'api_parameter':
          reason = `parameter ${connectingEdge.via || ''}`.trim();
          break;
        case 'api_contains':
          reason = `declares field ${connectingEdge.via || ''}`.trim();
          break;
        case 'api_ref':
          reason = `references via ${connectingEdge.via || '$ref'}`;
          break;
        // Bridge edges carry how the link was established, because an
        // inferred name match is not the same claim as an annotation.
        case 'api_implements':
          reason = `implements endpoint [${connectingEdge.confidence ?? 'unknown'}]`;
          break;
        case 'api_consumes':
          reason = `calls endpoint [${connectingEdge.confidence ?? 'unknown'}]`;
          break;
        default:
          reason = connectingEdge.type;
      }
    } else {
      reason = 'transitive dependency';
    }

    impacted.push({
      name: node.name,
      type: node.type,
      file: node.source.file,
      reason,
      depth,
    });

    // Continue traversal if within depth limit
    if (depth < maxDepth) {
      // Find parent module if this is a symbol
      const parentEdge = graph.edges.find(
        e => e.to === nodeId && e.type === 'composition'
      );
      if (parentEdge && !visited.has(parentEdge.from)) {
        // Don't add the parent module as impacted if the symbol is already listed
        // Instead, traverse who imports the parent module
        visited.add(parentEdge.from);

        for (const edge of graph.edges) {
          if (edge.to === parentEdge.from && !visited.has(edge.from)) {
            queue.push({ nodeId: edge.from, depth: depth + 1, via: edge });
            visited.add(edge.from);
          }
        }
      }

      // Also find anything that depends on this node
      for (const edge of graph.edges) {
        if (edge.to === nodeId && !visited.has(edge.from)) {
          queue.push({ nodeId: edge.from, depth: depth + 1, via: edge });
          visited.add(edge.from);
        }
      }
    }
  }

  return impacted;
}

export function runBlast(
  graph: DependencyGraph,
  target: string,
  options: {
    format?: 'table' | 'json' | 'csv';
    depth?: number;
  } = {}
): void {
  const format = options.format || 'table';
  const maxDepth = options.depth || 5;

  // Step 1: Resolve target
  const targetNode = resolveTarget(graph, target);

  if (!targetNode) {
    console.log(chalk.red(`\n❌ Target "${target}" not found in graph.`));

    // Suggest available targets
    console.log(chalk.yellow('\n💡 Available modules:'));
    graph.nodes
      .filter(n => n.type === 'module')
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(n => console.log(chalk.gray(' • ') + chalk.white(n.name)));

    const symbols = graph.nodes.filter(
      n => n.type !== 'module' && n.type !== 'external_package'
    );
    if (symbols.length > 0) {
      console.log(chalk.yellow('\n💡 Available symbols:'));
      symbols
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(n =>
          console.log(
            chalk.gray(' • ') +
            chalk.white(n.name) +
            chalk.gray(` (${n.type} in ${n.source.file})`)
          )
        );
    }

    process.exit(1);
  }

  // Step 2: Reverse traverse
  const impacted = reverseTraverse(graph, targetNode.id, maxDepth);

  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
    impacted.length < 3 ? 'LOW' : impacted.length < 8 ? 'MEDIUM' : 'HIGH';

  // Machine-readable formats: output and return (no decorative header)
  if (format === 'json') {
    console.log(JSON.stringify({ target: targetNode.name, target_type: targetNode.type, target_file: targetNode.source.file, risk_level: riskLevel, total_impacted: impacted.length, impacted }, null, 2));
    return;
  }

  if (format === 'csv') {
    console.log('Name,Type,File,Reason,Depth');
    impacted.forEach(r => {
      console.log(`"${r.name}","${r.type}","${r.file}","${r.reason}",${r.depth}`);
    });
    return;
  }

  // Human-readable: header + table
  console.log(chalk.yellow.bold('\n🔥 BLAST RADIUS ANALYSIS'));
  console.log(chalk.gray('═'.repeat(80)));
  console.log(
    chalk.gray('Target:   ') +
    chalk.white(targetNode.name) +
    chalk.gray(` [${targetNode.type}]`)
  );
  if (targetNode.source.file) {
    console.log(chalk.gray('File:     ') + chalk.gray(targetNode.source.file));
  }
  console.log(chalk.gray('Depth:    ') + chalk.cyan(maxDepth));
  console.log(chalk.gray('═'.repeat(80)));

  if (impacted.length === 0) {
    console.log(chalk.green('\n✅ Zero dependencies detected. Nothing depends on this target.\n'));
    return;
  }

  switch (format) {

    case 'table':
    default: {
      const table = new Table({
        head: [
          chalk.cyan('Impacted'),
          chalk.cyan('Type'),
          chalk.cyan('File'),
          chalk.cyan('Reason'),
          chalk.cyan('Depth'),
        ],
        wordWrap: true,
        style: { head: [], border: ['gray'] },
      });

      impacted
        .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))
        .forEach(r => {
          const typeIcon =
            r.type === 'module' ? '📦'
            : r.type === 'function' ? '⚡'
            : r.type === 'method' ? '🔧'
            : r.type === 'class' ? '🏗️'
            : r.type === 'interface' ? '📐'
            : r.type === 'external_package' ? '📦'
            : r.type === 'api_operation' ? '🌐'
            : r.type === 'api_schema' ? '📋'
            : r.type === 'api_property' ? '🔑'
            : r.type === 'api_service' ? '🛰️'
            : '';

          table.push([
            chalk.white(r.name),
            `${typeIcon} ${chalk.gray(r.type)}`,
            chalk.gray(r.file),
            r.reason,
            r.depth === 1
              ? chalk.red(r.depth.toString())
              : chalk.yellow(r.depth.toString()),
          ]);
        });

      console.log('\n' + table.toString());

      // Risk summary
      console.log(chalk.yellow('\n📊 IMPACT SUMMARY'));
      const riskColor =
        riskLevel === 'LOW' ? chalk.green
        : riskLevel === 'MEDIUM' ? chalk.yellow
        : chalk.red;

      console.log(chalk.gray('Total Impacted: ') + chalk.cyan(impacted.length));
      console.log(chalk.gray('Risk Level:     ') + riskColor.bold(riskLevel));

      // Breakdown by type
      const byType = impacted.reduce((acc, r) => {
        acc[r.type] = (acc[r.type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      console.log(chalk.gray('Breakdown:'));
      Object.entries(byType)
        .sort(([, a], [, b]) => b - a)
        .forEach(([type, count]) => {
          console.log(chalk.gray(`  • ${type}: `) + chalk.cyan(count));
        });

      console.log(chalk.gray('─'.repeat(80)) + '\n');

      if (riskLevel === 'HIGH') {
        console.log(chalk.yellow('⚠️  High impact — review all dependents before modifying.\n'));
      }
      break;
    }
  }
}
