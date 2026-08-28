import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface WorkspaceProject {
  configPath: string;
  directory: string;
  packageName?: string;
  sourceFileCount: number;
}

export interface WorkspaceResolutionStatus {
  mode: 'single-project' | 'workspace';
  packageManager?: 'bun' | 'pnpm' | 'yarn' | 'npm';
  taskRunner?: 'turbo' | 'nx';
  workspacePatterns: string[];
  discoveredProjects: WorkspaceProject[];
  resolvedWorkspaceImports: number;
  unresolvedWorkspaceImports: string[];
}

export interface CompilerState {
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFiles: ts.SourceFile[];
  excludedOutputFiles: string[];
  suspectedGeneratedFiles: string[];
  /** Directory supplied to DeepGraph; graph paths are relative to it. */
  projectRoot: string;
  tsVersion: string;
  workspace: WorkspaceResolutionStatus;
  /** The same resolver the combined compiler program used. */
  resolveModule(moduleName: string, containingFile: string): ts.ResolvedModuleWithFailedLookupLocations;
}

interface ParsedProject {
  configPath: string;
  parsed: ts.ParsedCommandLine;
  directory: string;
  packageName?: string;
}

interface WorkspacePackage {
  directory: string;
  manifest: Record<string, unknown>;
}

function normalize(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function isWithinDirectory(filePath: string, directory: string): boolean {
  const relative = path.relative(directory, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function looksGenerated(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return /\/(dist|build)\//.test(normalized) || /\.min\.[cm]?js$/i.test(normalized);
}

function readJson(filePath: string): Record<string, any> | null {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }
}

function parseProjectConfig(configPath: string): ParsedProject | null {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) return null;
  const directory = path.dirname(configPath);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, directory);
  const manifest = readJson(path.join(directory, 'package.json'));
  return { configPath: normalize(configPath), parsed, directory, packageName: manifest?.name };
}

function collectProjectReferences(root: ParsedProject, seen = new Set<string>()): ParsedProject[] {
  if (seen.has(root.configPath)) return [];
  seen.add(root.configPath);
  const projects = [root];
  for (const reference of root.parsed.projectReferences ?? []) {
    const configPath = ts.resolveProjectReferencePath(reference);
    const project = ts.sys.fileExists(configPath) ? parseProjectConfig(configPath) : null;
    if (project) projects.push(...collectProjectReferences(project, seen));
  }
  return projects;
}

function workspacePatterns(root: string): string[] {
  const manifest = readJson(path.join(root, 'package.json'));
  const declared = manifest?.workspaces;
  if (Array.isArray(declared)) return declared.filter((value): value is string => typeof value === 'string');
  if (Array.isArray(declared?.packages)) return declared.packages.filter((value: unknown): value is string => typeof value === 'string');
  const pnpmWorkspace = path.join(root, 'pnpm-workspace.yaml');
  if (!fs.existsSync(pnpmWorkspace)) return [];
  return fs.readFileSync(pnpmWorkspace, 'utf-8')
    .split('\n')
    .map(line => line.match(/^\s*-\s*['"]?([^'"#]+)['"]?\s*(?:#.*)?$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

function ignoredDirectory(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build' || name === '.next' || name === '.turbo';
}

function expandWorkspacePattern(root: string, pattern: string): string[] {
  const parts = pattern.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
  const result: string[] = [];
  const walk = (directory: string, index: number): void => {
    if (index === parts.length) {
      if (fs.existsSync(path.join(directory, 'package.json'))) result.push(directory);
      return;
    }
    const part = parts[index];
    if (!fs.existsSync(directory)) return;
    if (part === '**') {
      walk(directory, index + 1);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !ignoredDirectory(entry.name)) walk(path.join(directory, entry.name), index);
      }
      return;
    }
    if (!part.includes('*')) { walk(path.join(directory, part), index + 1); return; }
    const expression = new RegExp(`^${part.replace(/[.+^${}()|[\\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !ignoredDirectory(entry.name) && expression.test(entry.name)) walk(path.join(directory, entry.name), index + 1);
    }
  };
  walk(root, 0);
  return result;
}

function discoverProjects(root: string): { projects: ParsedProject[]; patterns: string[]; packages: Map<string, WorkspacePackage> } {
  const patterns = workspacePatterns(root);
  const directories = new Set<string>([root]);
  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!'))) {
    for (const directory of expandWorkspacePattern(root, pattern)) directories.add(directory);
  }
  // Workspace manifests use leading `!` to subtract packages from a broad
  // glob. Apply that after positive expansion so `apps/*` plus
  // `!apps/desktop` behaves the same across Bun, pnpm, and Yarn manifests.
  for (const pattern of patterns.filter(pattern => pattern.startsWith('!'))) {
    for (const excluded of expandWorkspacePattern(root, pattern.slice(1))) {
      for (const directory of Array.from(directories)) {
        if (normalize(directory) === normalize(excluded) || isWithinDirectory(directory, excluded)) directories.delete(directory);
      }
    }
  }
  const parsed = new Map<string, ParsedProject>();
  for (const directory of directories) {
    const configPath = path.join(directory, 'tsconfig.json');
    if (!fs.existsSync(configPath)) continue;
    const project = parseProjectConfig(configPath);
    if (project) for (const referenced of collectProjectReferences(project)) parsed.set(referenced.configPath, referenced);
  }
  if (parsed.size === 0) {
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
    const project = configPath ? parseProjectConfig(configPath) : null;
    if (!project) throw new Error(`No tsconfig.json found in ${root}. deep-graph requires a TypeScript project with a tsconfig.json.`);
    for (const referenced of collectProjectReferences(project)) parsed.set(referenced.configPath, referenced);
  }
  const packages = new Map<string, WorkspacePackage>();
  // A root orchestration manifest may share a package name with a published
  // SDK but have no TypeScript source of its own. Only a discovered TS project
  // can be a source-level workspace resolution target.
  const projectDirectories = new Set(Array.from(parsed.values()).map(project => normalize(project.directory)));
  for (const directory of directories) {
    if (!projectDirectories.has(normalize(directory))) continue;
    const manifest = readJson(path.join(directory, 'package.json'));
    if (typeof manifest?.name === 'string') packages.set(manifest.name, { directory, manifest });
  }
  return { projects: Array.from(parsed.values()), patterns, packages };
}

function packageManager(root: string): WorkspaceResolutionStatus['packageManager'] {
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  return undefined;
}

function taskRunner(root: string): WorkspaceResolutionStatus['taskRunner'] {
  if (fs.existsSync(path.join(root, 'turbo.json'))) return 'turbo';
  if (fs.existsSync(path.join(root, 'nx.json'))) return 'nx';
  return undefined;
}

function existingSource(candidates: string[]): string | undefined {
  const extensions = ['', '.ts', '.tsx', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.mts', '/index.cts'];
  for (const candidate of candidates) for (const extension of extensions) {
    const file = candidate.endsWith(extension) && extension !== '' ? candidate : `${candidate}${extension}`;
    if (ts.sys.fileExists(file)) return file;
  }
  return undefined;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
}

function resolveWorkspacePackage(moduleName: string, packages: Map<string, WorkspacePackage>): string | undefined {
  const packageName = Array.from(packages.keys()).sort((a, b) => b.length - a.length).find(name => moduleName === name || moduleName.startsWith(`${name}/`));
  if (!packageName) return undefined;
  const workspace = packages.get(packageName)!;
  const subpath = moduleName.slice(packageName.length).replace(/^\//, '');
  const candidates: string[] = [];
  const exports = workspace.manifest.exports;
  const exportKey = subpath ? `./${subpath}` : '.';
  if (exports && typeof exports === 'object' && !Array.isArray(exports)) {
    candidates.push(...exportTargets((exports as Record<string, unknown>)[exportKey]).map(target => path.join(workspace.directory, target)));
    if (!subpath) candidates.push(...exportTargets(exports).map(target => path.join(workspace.directory, target)));
  }
  if (!subpath) for (const key of ['types', 'source', 'module', 'main']) {
    if (typeof workspace.manifest[key] === 'string') candidates.push(path.join(workspace.directory, workspace.manifest[key] as string));
  }
  candidates.push(path.join(workspace.directory, subpath), path.join(workspace.directory, 'src', subpath));
  return existingSource(candidates);
}

/**
 * Builds one compiler program across every discovered workspace project.
 * Bun/Turbo are reported as environment signals, never used as a resolver.
 */
export function loadProject(targetDir: string): CompilerState {
  const projectRoot = path.resolve(targetDir);
  const discovered = discoverProjects(projectRoot);
  const projects = discovered.projects;
  const rootNames = Array.from(new Set(projects.flatMap(project => project.parsed.fileNames)));
  const optionsByFile = new Map<string, ts.CompilerOptions>();
  for (const project of projects) for (const file of project.parsed.fileNames) optionsByFile.set(normalize(file), project.parsed.options);
  const defaultOptions = projects[0].parsed.options;
  const unresolvedWorkspaceImports = new Set<string>();
  let resolvedWorkspaceImports = 0;
  const resolveModule = (moduleName: string, containingFile: string): ts.ResolvedModuleWithFailedLookupLocations => {
    const options = optionsByFile.get(normalize(containingFile)) ?? defaultOptions;
    const workspacePath = resolveWorkspacePackage(moduleName, discovered.packages);
    if (workspacePath) {
      resolvedWorkspaceImports++;
      return { resolvedModule: { resolvedFileName: workspacePath, extension: ts.Extension.Ts, isExternalLibraryImport: false } };
    }
    const resolved = ts.resolveModuleName(moduleName, containingFile, options, ts.sys);
    if (!resolved.resolvedModule && Array.from(discovered.packages.keys()).some(name => moduleName === name || moduleName.startsWith(`${name}/`))) unresolvedWorkspaceImports.add(moduleName);
    return resolved;
  };
  const host = ts.createCompilerHost(defaultOptions, true);
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map(name => resolveModule(name, containingFile).resolvedModule);
  const program = ts.createProgram({ rootNames, options: defaultOptions, host });
  const checker = program.getTypeChecker();
  const outputDirectories = projects.map(project => project.parsed.options.outDir ? path.resolve(project.directory, project.parsed.options.outDir) : undefined).filter((value): value is string => Boolean(value));
  const excludedOutputFiles: string[] = [];
  const suspectedGeneratedFiles: string[] = [];
  const sourceFiles = program.getSourceFiles().filter(sourceFile => {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules') || !isWithinDirectory(sourceFile.fileName, projectRoot)) return false;
    if (outputDirectories.some(directory => isWithinDirectory(sourceFile.fileName, directory))) { excludedOutputFiles.push(sourceFile.fileName); return false; }
    if (looksGenerated(sourceFile.fileName)) suspectedGeneratedFiles.push(sourceFile.fileName);
    return true;
  });
  return {
    program, checker, sourceFiles, excludedOutputFiles, suspectedGeneratedFiles, projectRoot, tsVersion: ts.version,
    workspace: {
      mode: projects.length > 1 || discovered.patterns.length > 0 ? 'workspace' : 'single-project', packageManager: packageManager(projectRoot), taskRunner: taskRunner(projectRoot), workspacePatterns: discovered.patterns,
      discoveredProjects: projects.map(project => ({ configPath: path.relative(projectRoot, project.configPath).replace(/\\/g, '/'), directory: path.relative(projectRoot, project.directory).replace(/\\/g, '/') || '.', packageName: project.packageName, sourceFileCount: project.parsed.fileNames.length })),
      resolvedWorkspaceImports, unresolvedWorkspaceImports: Array.from(unresolvedWorkspaceImports).sort(),
    },
    resolveModule,
  };
}
