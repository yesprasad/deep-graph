import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import chalk from 'chalk';
import Table from 'cli-table3';
import { loadProject, type CompilerState } from '../compiler/loader';
import { extractGraph } from '../extractor';
import { extractJavaGraph, loadJavaProject } from '../java';
import { enrichJavaGraphWithJdtls } from '../java/jdtls';
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
  language?: 'auto' | 'typescript' | 'java';
  semantic?: 'off' | 'auto' | 'required';
  jdtlsPath?: string;
  javaPath?: string;
}

interface Consumer {
  name: string;
  type: string;
  file: string;
  depth: number;
  reason: string;
}

type ConsequenceScope = 'contained' | 'cross-project' | 'cross-surface';

interface ImpactSummary {
  /** Architectural reach, never a defect or severity verdict. */
  scope: ConsequenceScope;
  affectedArtifacts: number;
  directConsumers: number;
  transitiveConsumers: number;
  maxDepth: number;
  affectedProjects: string[];
  resolution: 'complete' | 'partial' | 'not_available';
}

export interface PrCheckResult {
  base: string;
  /** Language DeepGraph selected for the code graph, if any. */
  language?: 'typescript' | 'java';
  /** Compiler version when TypeScript supplied the semantic graph. */
  compilerVersion?: string;
  changedFiles: string[];
  changedTypeScriptFiles: string[];
  changedJavaFiles: string[];
  openapiFiles: string[];
  newOpenApiFiles: string[];
  apiChanges: Array<ApiChange & { consumers: Consumer[] }>;
  breakingCount: number;
  safeCount: number;
  impacted: Consumer[];
  impact: ImpactSummary;
  semantic?: DependencyGraph['metadata']['semantic'];
  resolution?: DependencyGraph['metadata']['workspace'];
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
  state: CompilerState | null,
  javaState: ReturnType<typeof loadJavaProject> | null
): DependencyGraph | null {
  const codeGraph = state ? extractGraph(state) : javaState ? extractJavaGraph(javaState) : null;
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

function summarizeImpact(
  changedFiles: string[],
  impacted: Consumer[],
  workspace: DependencyGraph['metadata']['workspace']
): ImpactSummary {
  const projectForFile = (file: string): string | undefined => {
    if (!workspace) return undefined;
    const normalized = file.replace(/\\/g, '/');
    const match = workspace.discoveredProjects
      .filter(project => project.directory === '.' || normalized === project.directory || normalized.startsWith(`${project.directory}/`))
      .sort((a, b) => b.directory.length - a.directory.length)[0];
    return match?.packageName ?? match?.directory;
  };
  const affectedProjects = Array.from(new Set([
    ...changedFiles.map(projectForFile),
    ...impacted.map(item => projectForFile(item.file)),
  ].filter((value): value is string => Boolean(value)))).sort();
  const resolution = !workspace ? 'not_available' : workspace.unresolvedWorkspaceImports.length === 0 ? 'complete' : 'partial';
  const scope: ConsequenceScope = affectedProjects.length <= 1 ? 'contained'
    : affectedProjects.length === 2 ? 'cross-project'
    : 'cross-surface';
  return {
    scope,
    affectedArtifacts: impacted.length,
    directConsumers: impacted.filter(item => item.depth === 1).length,
    transitiveConsumers: impacted.filter(item => item.depth > 1).length,
    maxDepth: Math.max(0, ...impacted.map(item => item.depth)),
    affectedProjects,
    resolution,
  };
}

export async function analyzePr(options: PrCheckOptions): Promise<PrCheckResult> {
  const directory = path.resolve(options.dir);
  const depth = options.depth ?? 5;
  const changedFiles = getChangedFiles(options.base, directory, true);
  const changedTypeScriptFiles = changedFiles.filter(file => /\.(ts|tsx)$/.test(file));
  const changedJavaFiles = changedFiles.filter(file => file.endsWith('.java'));

  const explicitSpecs = (options.openapi ?? []).map(spec => path.resolve(directory, spec));
  const discovered = discoverOpenApiFiles(directory);
  const openapiFiles = Array.from(new Set([...explicitSpecs, ...discovered])).filter(fs.existsSync);
  const newOpenApiFiles: string[] = [];

  let state: CompilerState | null = null;
  let javaState: ReturnType<typeof loadJavaProject> | null = null;
  try {
    if (options.language === 'java') throw new Error('Java explicitly requested');
    state = loadProject(directory);
  } catch (typescriptError) {
    try {
      if (options.language === 'typescript') throw typescriptError;
      javaState = loadJavaProject(directory);
    } catch {
      if (openapiFiles.length === 0) throw new Error(`No TypeScript or Java project or OpenAPI document found in ${directory}`);
    }
  }

  let currentGraph = buildGraphForSpecs(directory, openapiFiles, state, javaState);
  if (currentGraph && javaState && (options.semantic ?? 'auto') !== 'off') {
    currentGraph = await enrichJavaGraphWithJdtls(currentGraph, javaState, {
      mode: options.semantic, jdtlsPath: options.jdtlsPath, javaPath: options.javaPath,
    });
  }
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
      ? buildGraphForSpecs(directory, baseSpecPaths, state, javaState)
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
    for (const file of [...changedTypeScriptFiles, ...changedJavaFiles]) {
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
    const resolution = currentGraph?.metadata.workspace;
    const impact = summarizeImpact(changedFiles, uniqueImpacted, resolution);

    return {
      base: options.base,
      language: currentGraph?.metadata.language,
      compilerVersion: currentGraph?.metadata.language === 'typescript'
        ? currentGraph.metadata.tsVersion
        : undefined,
      changedFiles,
      changedTypeScriptFiles,
      changedJavaFiles,
      openapiFiles,
      newOpenApiFiles,
      apiChanges,
      breakingCount,
      safeCount: apiChanges.length - breakingCount,
      impacted: uniqueImpacted,
      impact,
      semantic: currentGraph?.metadata.semantic,
      resolution,
    };
  } finally {
    for (const directoryToRemove of tempDirs) {
      try { fs.rmSync(directoryToRemove, { recursive: true, force: true }); } catch {}
    }
  }
}

export async function runPrCheck(options: PrCheckOptions): Promise<void> {
  const humanOutput = options.format !== 'json';
  if (humanOutput) {
    console.log(chalk.cyan.bold('\nDEEPGRAPH') + chalk.gray(' · PR impact intelligence'));
    console.log(chalk.gray(`Reading codebase: ${path.resolve(options.dir)}`));
    console.log(chalk.gray('Identifying language and project configuration…'));
  }
  const result = await analyzePr(options);
  if (humanOutput && result.language === 'typescript') {
    const workspace = result.resolution;
    const environment = [workspace?.packageManager, workspace?.taskRunner].filter(Boolean).join(' + ');
    console.log(chalk.gray(`Identified: TypeScript — compiler ${result.compilerVersion ?? 'available'}`) +
      (workspace?.mode === 'workspace' ? chalk.gray(`; ${workspace.discoveredProjects.length} projects${environment ? `; ${environment}` : ''}`) : ''));
  } else if (humanOutput && result.language === 'java') {
    const provider = result.semantic?.status === 'available' || result.semantic?.status === 'partial'
      ? 'Eclipse JDT Language Server'
      : 'structural graph; JDT LS not available';
    console.log(chalk.gray(`Identified: Java — ${provider}`));
  }
  if (options.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(chalk.yellow.bold('\n🔎 PR CHECK'));
    console.log(chalk.gray('═'.repeat(80)));
    console.log(chalk.gray('Base:             ') + chalk.white(result.base));
    console.log(chalk.gray('Changed files:    ') + chalk.cyan(result.changedFiles.length));
    if (result.changedJavaFiles.length > 0) console.log(chalk.gray('Java files:       ') + chalk.cyan(result.changedJavaFiles.length));
    console.log(chalk.gray('OpenAPI files:    ') + chalk.cyan(result.openapiFiles.length));
    console.log(chalk.gray('API changes:      ') + chalk.cyan(result.apiChanges.length));
    console.log(chalk.gray('Breaking changes: ') + (result.breakingCount ? chalk.red(result.breakingCount) : chalk.green('0')));
    console.log(chalk.gray('Scope:            ') + chalk.cyan(result.impact.scope));
    console.log(chalk.gray('Affected code:    ') + chalk.cyan(`${result.impact.affectedArtifacts} artifacts; ${result.impact.directConsumers} direct, ${result.impact.transitiveConsumers} transitive; depth ${result.impact.maxDepth}`));
    if (result.impact.affectedProjects.length > 0) {
      console.log(chalk.gray('Projects reached: ') + chalk.white(result.impact.affectedProjects.join(', ')));
    }
    if (result.resolution) {
      const status = result.resolution.unresolvedWorkspaceImports.length === 0 ? chalk.green('complete') : chalk.yellow('partial');
      console.log(chalk.gray('TS resolution:    ') + status + chalk.gray(` (${result.resolution.discoveredProjects.length} projects, ${result.resolution.resolvedWorkspaceImports} workspace imports)`));
      if (result.resolution.unresolvedWorkspaceImports.length > 0) {
        console.log(chalk.yellow(`Unresolved workspace imports: ${result.resolution.unresolvedWorkspaceImports.join(', ')}`));
      }
    }
    if (result.semantic) {
      const color = result.semantic.status === 'available' ? chalk.green : chalk.yellow;
      console.log(chalk.gray('Java semantics:   ') + color(`${result.semantic.status} (${result.semantic.references} refs, ${result.semantic.implementations} implementations, ${result.semantic.calls} calls)`));
      if (result.semantic.status === 'unavailable') {
        console.log(chalk.gray('Semantic provider: ') + chalk.yellow('Eclipse JDT LS unavailable — structural graph only'));
      } else {
        console.log(chalk.gray('Semantic provider: ') + chalk.cyan('Eclipse JDT Language Server'));
      }
    }

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
