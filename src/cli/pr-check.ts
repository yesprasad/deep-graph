import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadProject, type CompilerState } from '../compiler/loader';
import { extractGraph } from '../extractor';
import { buildApiGraph, mergeApiGraph, standaloneApiGraph } from '../openapi';
import { diffApiGraphs, type ApiChange } from '../openapi/diff';
import type { DependencyGraph } from '../types/graph';
import { getChangedFiles, resolveTarget, reverseTraverse } from './blast-pr';

interface PrCheckOptions {
  base: string;
  dir: string;
  openapi?: string[];
  depth?: number;
  format?: 'table' | 'json';
  failOnBreaking?: boolean;
}

interface Consumer {
  name: string;
  type: string;
  file: string;
  depth: number;
  reason: string;
}

export interface PrCheckResult {
  base: string;
  changedFiles: string[];
  changedTypeScriptFiles: string[];
  openapiFiles: string[];
  newOpenApiFiles: string[];
  apiChanges: Array<ApiChange & { consumers: Consumer[] }>;
  breakingCount: number;
  safeCount: number;
  impacted: Consumer[];
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

function collectSpecs(value: string | undefined, previous: string[]): string[] {
  if (!value) return previous;
  return previous.concat(value.split(',').map(s => s.trim()).filter(Boolean));
}

function discoverOpenApiFiles(root: string): string[] {
  const names = new Set(['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml', 'swagger.yml']);
  const looksLikeOpenApi = (name: string): boolean => {
    if (/_deparsed\.(?:json|ya?ml)$/i.test(name)) return false;
    return names.has(name.toLowerCase()) || /(?:openapi|swagger)[^/]*\.(?:json|ya?ml)$/i.test(name);
  };
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (looksLikeOpenApi(entry.name)) found.push(absolute);
    }
  };
  walk(root);
  return found.sort();
}

function readAtRevision(specPath: string, revision: string, repoRoot: string): string | null {
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-graph-pr-'));
  const file = path.join(directory, `base${path.extname(specPath) || '.json'}`);
  fs.writeFileSync(file, content);
  return file;
}

function buildGraphForSpecs(
  directory: string,
  specs: string[],
  state: CompilerState | null
): DependencyGraph | null {
  const codeGraph = state ? extractGraph(state) : null;
  if (specs.length === 0) return codeGraph;
  const api = buildApiGraph(specs, state, directory);
  return codeGraph ? mergeApiGraph(codeGraph, api) : {
    metadata: {
      projectRoot: directory,
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

function apiNodeByName(graph: DependencyGraph | null, name: string) {
  return graph?.nodes.find(n =>
    (n.type === 'api_operation' || n.type === 'api_schema' || n.type === 'api_property') &&
    n.name === name
  );
}

export function analyzePr(options: PrCheckOptions): PrCheckResult {
  const directory = path.resolve(options.dir);
  const depth = options.depth ?? 5;
  const changedFiles = getChangedFiles(options.base, directory, true);
  const changedTypeScriptFiles = changedFiles.filter(file => /\.(ts|tsx)$/.test(file));

  const explicitSpecs = (options.openapi ?? []).map(spec => path.resolve(directory, spec));
  const discovered = discoverOpenApiFiles(directory);
  const openapiFiles = Array.from(new Set([...explicitSpecs, ...discovered])).filter(fs.existsSync);
  const newOpenApiFiles: string[] = [];

  let state: CompilerState | null = null;
  try {
    state = loadProject(directory);
  } catch {
    if (openapiFiles.length === 0) throw new Error(`No TypeScript project or OpenAPI document found in ${directory}`);
  }

  const currentGraph = buildGraphForSpecs(directory, openapiFiles, state);
  const baseSpecPaths: string[] = [];
  const tempDirs: string[] = [];
  const apiChanges: Array<ApiChange & { consumers: Consumer[] }> = [];

  let repoRoot = directory;
  try { repoRoot = execSync('git rev-parse --show-toplevel', { cwd: directory, encoding: 'utf-8' }).trim(); } catch {}

  try {
    for (const spec of openapiFiles) {
      const baseSpec = readAtRevision(spec, options.base, repoRoot);
      if (!baseSpec) {
        newOpenApiFiles.push(spec);
        continue;
      }
      baseSpecPaths.push(baseSpec);
      tempDirs.push(path.dirname(baseSpec));
      const before = standaloneApiGraph(buildApiGraph([baseSpec], null, directory));
      const after = standaloneApiGraph(buildApiGraph([spec], null, directory));
      const diff = diffApiGraphs(before, after);
      for (const change of diff.changes) {
        apiChanges.push({ ...change, consumers: [] });
      }
    }

    // Build the base graph once for removed API nodes. This graph includes
    // the current TypeScript program, allowing a removed contract field to
    // still resolve into the unchanged handlers and their callers.
    const baseGraph = baseSpecPaths.length > 0
      ? buildGraphForSpecs(directory, baseSpecPaths, state)
      : null;

    for (const change of apiChanges) {
      if (change.consumers.length > 0) continue;
      const graph = change.kind.endsWith('_removed') ? baseGraph : currentGraph;
      const target = apiNodeByName(graph, change.name);
      if (!graph || !target) continue;
      change.consumers = reverseTraverse(graph, target.id, depth, `openapi:${change.name}`)
        .filter(item => !item.type.startsWith('api_'))
        .map(item => ({ name: item.name, type: item.type, file: item.file, depth: item.depth, reason: item.reason }));
    }

    const impacted = new Map<string, Consumer>();
    for (const file of changedTypeScriptFiles) {
      const target = currentGraph && resolveTarget(currentGraph, file, repoRoot);
      if (!target || !currentGraph) continue;
      for (const item of reverseTraverse(currentGraph, target.id, depth, file)) {
        const key = `${item.name}::${item.file}`;
        if (!impacted.has(key)) impacted.set(key, {
          name: item.name, type: item.type, file: item.file,
          depth: item.depth, reason: item.reason,
        });
      }
    }
    for (const change of apiChanges) {
      for (const consumer of change.consumers) {
        const key = `${consumer.name}::${consumer.file}`;
        if (!impacted.has(key)) impacted.set(key, consumer);
      }
    }

    const uniqueImpacted = Array.from(impacted.values()).filter(item =>
      !changedFiles.includes(item.file) && !changedFiles.includes(item.name)
    ).sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
    const breakingCount = apiChanges.filter(change => change.breaking).length;
    const riskLevel: PrCheckResult['riskLevel'] =
      breakingCount > 0 || uniqueImpacted.length >= 30 ? 'CRITICAL'
      : uniqueImpacted.length >= 15 ? 'HIGH'
      : uniqueImpacted.length >= 5 ? 'MEDIUM'
      : 'LOW';

    return {
      base: options.base,
      changedFiles,
      changedTypeScriptFiles,
      openapiFiles,
      newOpenApiFiles,
      apiChanges,
      breakingCount,
      safeCount: apiChanges.length - breakingCount,
      impacted: uniqueImpacted,
      riskLevel,
    };
  } finally {
    for (const directoryToRemove of tempDirs) {
      try { fs.rmSync(directoryToRemove, { recursive: true, force: true }); } catch {}
    }
  }
}

export function runPrCheck(options: PrCheckOptions): void {
  const result = analyzePr(options);
  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(chalk.yellow.bold('\n🔎 PR CHECK'));
    console.log(chalk.gray('═'.repeat(80)));
    console.log(chalk.gray('Base:             ') + chalk.white(result.base));
    console.log(chalk.gray('Changed files:    ') + chalk.cyan(result.changedFiles.length));
    console.log(chalk.gray('OpenAPI files:    ') + chalk.cyan(result.openapiFiles.length));
    console.log(chalk.gray('API changes:      ') + chalk.cyan(result.apiChanges.length));
    console.log(chalk.gray('Breaking changes: ') + (result.breakingCount ? chalk.red(result.breakingCount) : chalk.green('0')));
    console.log(chalk.gray('Risk:             ') + chalk.white(result.riskLevel));

    if (result.apiChanges.length > 0) {
      const table = new Table({ head: ['Change', 'Subject', 'Breaking', 'Consumers'], style: { head: [], border: ['gray'] } });
      result.apiChanges.forEach(change => table.push([change.kind, change.name, change.breaking ? 'yes' : 'no', change.consumers.length]));
      console.log('\n' + table.toString());
    }
    if (result.impacted.length > 0) {
      console.log(chalk.yellow('\nAffected code:'));
      result.impacted.slice(0, 50).forEach(item => console.log(`  • ${item.file} — ${item.reason}`));
      if (result.impacted.length > 50) console.log(`  … and ${result.impacted.length - 50} more`);
    }
  }

  if (options.failOnBreaking && result.breakingCount > 0) process.exit(1);
}
