import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import Table from 'cli-table3';
import type { DependencyGraph, GraphNode } from '../types/graph';
import { loadOpenApi } from '../openapi/loader';
import { extractApiGraph } from '../openapi/extractor';
import { diffApiGraphs, type ApiChange } from '../openapi/diff';

/**
 * API CONTRACT DIFF
 *
 * Answers the question a reviewer actually has about a spec change:
 * not "what lines moved", but "what did we promise that we no longer
 * promise, and who was relying on it".
 *
 * The second half needs the merged graph — a breaking change with no
 * known consumers is a different conversation from one with three.
 */

interface ApiDiffOptions {
  base: string;
  dir: string;
  format?: 'table' | 'json';
  /**
   * Builds a merged graph for a given set of spec files.
   *
   * Two graphs are needed, not one. A removed field does not exist in the
   * current spec, so looking for its consumers in the current graph finds
   * nothing — precisely the change where "who breaks?" matters most. The
   * base graph still contains it, and the bridges to code still resolve
   * because the handlers themselves have not moved.
   */
  buildGraph?: ((specPaths: string[]) => DependencyGraph | null) | null;
  /** Exit non-zero when a breaking change is found (for CI). */
  failOnBreaking?: boolean;
}

/**
 * Read a file as of a git revision, into a temp file the loader can open.
 * Returns null when the spec did not exist at that revision — a new spec
 * is an addition, not a diff.
 */
function readAtRevision(
  specPath: string,
  revision: string,
  repoRoot: string
): string | null {
  const relative = path.relative(repoRoot, path.resolve(specPath));

  let content: string;
  try {
    content = execSync(`git show ${revision}:${JSON.stringify(relative)}`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-graph-api-'));
  // Keep the extension so the loader picks the right parser.
  const temp = path.join(tempDir, `base${path.extname(specPath) || '.json'}`);
  fs.writeFileSync(temp, content);
  return temp;
}

/** Everything in the merged graph that depends on a changed API node. */
function findConsumers(
  graph: DependencyGraph,
  changedNames: Set<string>
): Map<string, Array<{ name: string; file: string; confidence?: string }>> {
  const consumers = new Map<
    string,
    Array<{ name: string; file: string; confidence?: string }>
  >();

  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const apiNodesByName = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (
      node.type === 'api_property' ||
      node.type === 'api_schema' ||
      node.type === 'api_operation'
    ) {
      apiNodesByName.set(node.name, node);
    }
  }

  for (const changedName of changedNames) {
    const start = apiNodesByName.get(changedName);
    if (!start) continue;

    // Reverse walk to the code: property -> schema -> operation -> handler.
    const found: Array<{ name: string; file: string; confidence?: string }> = [];
    const seen = new Set<string>([start.id]);
    const queue = [start.id];

    while (queue.length > 0) {
      const current = queue.shift()!;

      for (const edge of graph.edges) {
        if (edge.to !== current || seen.has(edge.from)) continue;
        seen.add(edge.from);

        const node = byId.get(edge.from);
        if (!node) continue;

        // Reaching TypeScript is the answer; reaching more API nodes is
        // just another hop toward it.
        if (edge.type === 'api_implements' || edge.type === 'api_consumes') {
          found.push({
            name: node.name,
            file: node.source.file,
            confidence: edge.confidence,
          });
          continue;
        }

        if (node.type.startsWith('api_')) queue.push(edge.from);
      }
    }

    if (found.length > 0) consumers.set(changedName, found);
  }

  return consumers;
}

export function runApiDiff(specPaths: string[], options: ApiDiffOptions): void {
  const format = options.format ?? 'table';

  let repoRoot: string;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: options.dir,
      encoding: 'utf-8',
    }).trim();
  } catch {
    console.error(chalk.red('\n❌ Not a git repository — api-diff needs a base revision to compare against.'));
    process.exit(1);
  }

  const allChanges: ApiChange[] = [];
  const newSpecs: string[] = [];
  const baseSpecPaths: string[] = [];
  const tempDirs: string[] = [];

  let breaking: ApiChange[] = [];
  let safe: ApiChange[] = [];
  const consumers = new Map<
    string,
    Array<{ name: string; file: string; confidence?: string }>
  >();

  try {
    for (const specPath of specPaths) {
      const basePath = readAtRevision(specPath, options.base, repoRoot);

      if (!basePath) {
        newSpecs.push(specPath);
        continue;
      }

      baseSpecPaths.push(basePath);
      tempDirs.push(path.dirname(basePath));

      const before = extractApiGraph(loadOpenApi(basePath));
      const after = extractApiGraph(loadOpenApi(specPath));
      allChanges.push(...diffApiGraphs(before, after).changes);
    }

    breaking = allChanges.filter(c => c.breaking);
    safe = allChanges.filter(c => !c.breaking);

    // Removals and modifications are looked up in different graphs: a
    // removed subject only exists in the base, a new one only in the
    // current spec.
    if (options.buildGraph) {
      const removedNames = new Set(
        breaking.filter(c => c.kind.endsWith('_removed')).map(c => c.name)
      );
      const presentNames = new Set(
        breaking.filter(c => !c.kind.endsWith('_removed')).map(c => c.name)
      );

      if (presentNames.size > 0) {
        const current = options.buildGraph(specPaths);
        if (current) {
          for (const [k, v] of findConsumers(current, presentNames)) {
            consumers.set(k, v);
          }
        }
      }

      if (removedNames.size > 0 && baseSpecPaths.length > 0) {
        const baseGraph = options.buildGraph(baseSpecPaths);
        if (baseGraph) {
          for (const [k, v] of findConsumers(baseGraph, removedNames)) {
            consumers.set(k, v);
          }
        }
      }
    }
  } finally {
    // Best effort: a leftover temp file is harmless, a crash here is not.
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  }

  if (format === 'json') {
    console.log(
      JSON.stringify(
        {
          base: options.base,
          specs: specPaths,
          new_specs: newSpecs,
          breaking_count: breaking.length,
          safe_count: safe.length,
          changes: allChanges.map(c => ({
            ...c,
            consumers: consumers.get(c.name) ?? [],
          })),
        },
        null,
        2
      )
    );
    if (options.failOnBreaking && breaking.length > 0) process.exit(1);
    return;
  }

  console.log(chalk.yellow.bold('\n🔀 API CONTRACT DIFF'));
  console.log(chalk.gray('═'.repeat(80)));
  console.log(chalk.gray('Base:     ') + chalk.white(options.base));
  console.log(chalk.gray('Specs:    ') + chalk.white(specPaths.join(', ')));
  console.log(chalk.gray('═'.repeat(80)));

  for (const spec of newSpecs) {
    console.log(chalk.cyan(`\n📄 ${spec} is new at this revision — nothing to compare.`));
  }

  if (allChanges.length === 0) {
    if (newSpecs.length < specPaths.length) {
      console.log(chalk.green('\n✅ No contract changes detected.\n'));
    }
    return;
  }

  if (breaking.length > 0) {
    console.log(chalk.red.bold('\n💥 BREAKING CHANGES'));

    const table = new Table({
      head: [chalk.cyan('Change'), chalk.cyan('Subject'), chalk.cyan('Detail')],
      wordWrap: true,
      colWidths: [24, 30, 40],
      style: { head: [], border: ['gray'] },
    });

    breaking.forEach(c => {
      table.push([chalk.red(c.kind), chalk.white(c.name), c.detail]);
    });

    console.log(table.toString());

    if (consumers.size > 0) {
      console.log(chalk.red.bold('\n🎯 AFFECTED CONSUMERS'));
      console.log(chalk.gray('Code reached from each breaking change through the contract graph.\n'));

      for (const [name, list] of consumers) {
        console.log(chalk.white(`  ${name}`));
        for (const consumer of list) {
          // Surface the evidence tier: an inferred link is a lead to
          // check, not a confirmed dependency.
          const tag = consumer.confidence === 'inferred'
            ? chalk.yellow(' [inferred]')
            : chalk.gray(` [${consumer.confidence}]`);
          console.log(chalk.gray('    • ') + chalk.cyan(consumer.file) + tag);
        }
      }
    } else if (options.buildGraph) {
      console.log(chalk.gray('\n   No code consumers found for these changes.'));
      console.log(chalk.gray('   If that is unexpected, the bridge may be missing — add an'));
      console.log(chalk.gray('   @openapi annotation to the handler, or check the route matching.'));
    }
  }

  if (safe.length > 0) {
    console.log(chalk.green.bold('\n✅ NON-BREAKING CHANGES'));
    const table = new Table({
      head: [chalk.cyan('Change'), chalk.cyan('Subject'), chalk.cyan('Detail')],
      wordWrap: true,
      colWidths: [24, 30, 40],
      style: { head: [], border: ['gray'] },
    });
    safe.forEach(c => {
      table.push([chalk.green(c.kind), chalk.white(c.name), c.detail]);
    });
    console.log(table.toString());
  }

  console.log(chalk.yellow('\n📊 SUMMARY'));
  console.log(chalk.gray('Breaking:     ') + (breaking.length > 0 ? chalk.red.bold(breaking.length) : chalk.green('0')));
  console.log(chalk.gray('Non-breaking: ') + chalk.cyan(safe.length));
  console.log(chalk.gray('─'.repeat(80)) + '\n');

  if (options.failOnBreaking && breaking.length > 0) {
    process.exit(1);
  }
}
