import { execSync } from 'child_process';
import path from 'path';
import chalk from 'chalk';
import Table from 'cli-table3';
import type { DependencyGraph, GraphNode } from '../types/graph';

export interface PrImpactRecord {
  name: string;
  type: string;
  file: string;
  reason: string;
  depth: number;
  source: string; // which changed file triggered this
}

export interface PrBlastResult {
  changedFiles: string[];
  totalImpacted: number;
  uniqueImpacted: PrImpactRecord[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export function getChangedFiles(
  base: string,
  projectRoot: string,
  includeContractFiles = false
): string[] {
  // Determine the project's path relative to the git repo root
  // so we can strip it from diff output (git always returns repo-relative paths)
  let repoRelativePrefix = '';
  try {
    const repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    const absProjectRoot = path.resolve(projectRoot);
    if (absProjectRoot !== repoRoot) {
      repoRelativePrefix = absProjectRoot.slice(repoRoot.length + 1) + '/';
    }
  } catch {
    // If we can't determine the prefix, proceed without stripping
  }

  function stripAndFilter(raw: string): string[] {
    if (!raw) return [];
    return raw
      .split('\n')
      .filter(f => includeContractFiles
        ? /\.(ts|tsx|json|ya?ml)$/.test(f)
        : /\.(ts|tsx)$/.test(f))
      .filter(f => !f.includes('node_modules'))
      .filter(f => !f.endsWith('.d.ts'))
      .map(f => repoRelativePrefix && f.startsWith(repoRelativePrefix)
        ? f.slice(repoRelativePrefix.length)
        : f
      );
  }

  try {
    const raw = execSync(`git diff --name-only --diff-filter=ACMR ${base}...HEAD`, {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();

    return stripAndFilter(raw);
  } catch {
    try {
      const raw = execSync(`git diff --name-only --diff-filter=ACMR ${base} HEAD`, {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();

      return stripAndFilter(raw);
    } catch {
      return [];
    }
  }
}

export function resolveTarget(
  graph: DependencyGraph,
  filePath: string,
  repoRoot?: string
): GraphNode | null {
  // Try matching as a module node
  let node = graph.nodes.find(
    n => n.type === 'module' &&
      (n.name === filePath ||
        n.name === `src/${filePath}` ||
        n.source.file === filePath ||
        n.name.endsWith(`/${filePath}`))
  );
  if (node) return node;

  // Try matching as an external_package (workspace dependency in monorepo)
  // e.g. filePath "packages/validation/api.ts" → "@repo/validation/api"
  if (repoRoot) {
    const absFile = path.resolve(repoRoot, filePath);
    const parts = filePath.split('/');
    // Walk up the path to find a package.json
    for (let i = parts.length - 1; i >= 1; i--) {
      const pkgDir = path.resolve(repoRoot, parts.slice(0, i).join('/'));
      const pkgJsonPath = path.join(pkgDir, 'package.json');
      try {
        const pkgJson = JSON.parse(
          require('fs').readFileSync(pkgJsonPath, 'utf-8')
        );
        if (pkgJson.name) {
          // Compute the subpath: file path relative to package dir, without extension
          const relToPackage = path.relative(pkgDir, absFile)
            .replace(/\.(ts|tsx)$/, '')
            .replace(/\/index$/, '');
          const specifier = relToPackage === 'index' || relToPackage === ''
            ? pkgJson.name
            : `${pkgJson.name}/${relToPackage}`;
          // Match against external_package nodes
          node = graph.nodes.find(
            n => n.type === 'external_package' && n.name === specifier
          );
          if (node) return node;
          // Also try without src/ prefix in subpath
          if (relToPackage.startsWith('src/')) {
            const withoutSrc = `${pkgJson.name}/${relToPackage.slice(4)}`;
            node = graph.nodes.find(
              n => n.type === 'external_package' && n.name === withoutSrc
            );
            if (node) return node;
          }
          break;
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function reverseTraverse(
  graph: DependencyGraph,
  targetId: string,
  maxDepth: number,
  sourceFile: string
): PrImpactRecord[] {
  const impacted: PrImpactRecord[] = [];
  const visited = new Set<string>();
  const queue: Array<{ nodeId: string; depth: number }> = [];

  visited.add(targetId);

  // Include composition descendants
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

    let reason: string;
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
    } else {
      reason = 'transitive dependency';
    }

    impacted.push({
      name: node.name,
      type: node.type,
      file: node.source.file,
      reason,
      depth,
      source: sourceFile,
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

export function runBlastPr(
  graph: DependencyGraph,
  options: {
    base?: string;
    dir?: string;
    format?: 'table' | 'json' | 'csv';
    depth?: number;
  } = {}
): void {
  const format = options.format || 'table';
  const maxDepth = options.depth || 5;
  const base = options.base || 'main';
  const projectRoot = options.dir || process.cwd();

  // Get changed files from git
  const changedFiles = getChangedFiles(base, projectRoot);

  if (changedFiles.length === 0) {
    if (format === 'json') {
      console.log(JSON.stringify({ base, changed_files: [], total_impacted: 0, risk_level: 'LOW', impacted: [] }, null, 2));
      return;
    }
    console.log(chalk.green(`\n✅ No TypeScript files changed relative to ${base}.\n`));
    return;
  }

  // Determine repo root for workspace package resolution
  let repoRoot: string | undefined;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
  } catch {}

  // Run blast on each changed file, collect all impacts
  const allImpacts: PrImpactRecord[] = [];
  const resolvedFiles: string[] = [];
  const unresolvedFiles: string[] = [];

  for (const file of changedFiles) {
    const target = resolveTarget(graph, file, repoRoot);
    if (target) {
      resolvedFiles.push(file);
      const impacts = reverseTraverse(graph, target.id, maxDepth, file);
      allImpacts.push(...impacts);
    } else {
      unresolvedFiles.push(file);
    }
  }

  // Deduplicate by node name + file (keep the shallowest depth)
  const seen = new Map<string, PrImpactRecord>();
  for (const impact of allImpacts) {
    const key = `${impact.name}::${impact.file}`;
    const existing = seen.get(key);
    if (!existing || impact.depth < existing.depth) {
      seen.set(key, impact);
    }
  }

  // Remove self-references (changed files appearing in their own blast)
  const changedFileSet = new Set(changedFiles);
  const unique = Array.from(seen.values()).filter(
    r => !changedFileSet.has(r.file) && !changedFileSet.has(r.name)
  );

  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' =
    unique.length < 5 ? 'LOW'
    : unique.length < 15 ? 'MEDIUM'
    : unique.length < 30 ? 'HIGH'
    : 'CRITICAL';

  // JSON output
  if (format === 'json') {
    console.log(JSON.stringify({
      base,
      changed_files: changedFiles,
      resolved_files: resolvedFiles,
      unresolved_files: unresolvedFiles,
      total_impacted: unique.length,
      risk_level: riskLevel,
      impacted: unique.sort((a, b) => a.depth - b.depth),
    }, null, 2));
    return;
  }

  // CSV output
  if (format === 'csv') {
    console.log('Name,Type,File,Reason,Depth,Source');
    unique
      .sort((a, b) => a.depth - b.depth)
      .forEach(r => {
        console.log(`"${r.name}","${r.type}","${r.file}","${r.reason}",${r.depth},"${r.source}"`);
      });
    return;
  }

  // Table output
  console.log(chalk.yellow.bold('\n🔥 PR BLAST RADIUS'));
  console.log(chalk.gray('═'.repeat(80)));
  console.log(chalk.gray('Base:     ') + chalk.white(base));
  console.log(chalk.gray('Changed:  ') + chalk.cyan(`${changedFiles.length} TypeScript file${changedFiles.length === 1 ? '' : 's'}`));
  console.log(chalk.gray('Depth:    ') + chalk.cyan(maxDepth));
  console.log(chalk.gray('═'.repeat(80)));

  // Show changed files
  console.log(chalk.yellow('\n📝 Changed Files:'));
  for (const file of changedFiles) {
    const resolved = resolvedFiles.includes(file);
    console.log(
      resolved
        ? chalk.green('  ✓ ') + chalk.white(file)
        : chalk.red('  ✗ ') + chalk.gray(file) + chalk.red(' (not in graph)')
    );
  }

  if (unique.length === 0) {
    console.log(chalk.green('\n✅ Zero downstream dependencies. These changes are isolated.\n'));
    return;
  }

  // Impact table
  const table = new Table({
    head: [
      chalk.cyan('Impacted'),
      chalk.cyan('Type'),
      chalk.cyan('File'),
      chalk.cyan('Via'),
      chalk.cyan('Depth'),
    ],
    wordWrap: true,
    style: { head: [], border: ['gray'] },
  });

  unique
    .sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name))
    .forEach(r => {
      const typeIcon =
        r.type === 'module' ? '📦'
        : r.type === 'function' ? '⚡'
        : r.type === 'method' ? '🔧'
        : r.type === 'class' ? '🏗️'
        : r.type === 'interface' ? '📐'
        : '';

      table.push([
        chalk.white(r.name),
        `${typeIcon} ${chalk.gray(r.type)}`,
        chalk.gray(r.file),
        chalk.gray(r.reason),
        r.depth === 1
          ? chalk.red(r.depth.toString())
          : chalk.yellow(r.depth.toString()),
      ]);
    });

  console.log('\n' + table.toString());

  // Summary
  console.log(chalk.yellow('\n📊 PR IMPACT SUMMARY'));
  const riskColor =
    riskLevel === 'LOW' ? chalk.green
    : riskLevel === 'MEDIUM' ? chalk.yellow
    : riskLevel === 'HIGH' ? chalk.red
    : chalk.magenta;

  console.log(chalk.gray('Files Changed:    ') + chalk.cyan(changedFiles.length));
  console.log(chalk.gray('Total Impacted:   ') + chalk.cyan(unique.length));
  console.log(chalk.gray('Risk Level:       ') + riskColor.bold(riskLevel));

  // Breakdown by source file
  const bySource = unique.reduce((acc, r) => {
    acc[r.source] = (acc[r.source] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log(chalk.gray('\nImpact by changed file:'));
  Object.entries(bySource)
    .sort(([, a], [, b]) => b - a)
    .forEach(([file, count]) => {
      console.log(chalk.gray(`  • ${file}: `) + chalk.cyan(`${count} affected`));
    });

  console.log(chalk.gray('─'.repeat(80)) + '\n');

  if (riskLevel === 'CRITICAL') {
    console.log(chalk.magenta.bold('⚠️  CRITICAL IMPACT — this PR affects 30+ artifacts. Split or review thoroughly.\n'));
  } else if (riskLevel === 'HIGH') {
    console.log(chalk.red('⚠️  High impact — review all dependents before merging.\n'));
  }
}
