import ts from 'typescript';
import path from 'path';
import fs from 'fs';

export interface CompilerState {
  program: ts.Program;
  checker: ts.TypeChecker;
  sourceFiles: ts.SourceFile[];
  projectRoot: string;
  tsVersion: string;
}

/** A parsed tsconfig plus the resolved path it came from. */
interface ParsedProject {
  configPath: string;
  parsed: ts.ParsedCommandLine;
}

function parseProjectConfig(configPath: string): ParsedProject | null {
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) return null;

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
  );
  return { configPath, parsed };
}

/**
 * Recursively resolve a tsconfig's `references` (TypeScript project
 * references) and union every referenced project's fileNames into one
 * rootNames list.
 *
 * `ts.createProgram` doesn't do this by itself — `references` tells the
 * compiler how to order incremental builds, not which files belong to
 * the program. A "solution" tsconfig (references only, no include/files
 * of its own — the common root-of-a-monorepo shape) resolves to zero
 * files without this; each referenced package was invisible.
 */
function collectProjectFileNames(
  root: ParsedProject,
  seen: Set<string> = new Set()
): Set<string> {
  const fileNames = new Set<string>();
  if (seen.has(root.configPath)) return fileNames;
  seen.add(root.configPath);

  for (const f of root.parsed.fileNames) fileNames.add(f);

  for (const ref of root.parsed.projectReferences ?? []) {
    const refConfigPath = ts.resolveProjectReferencePath(ref);
    if (!ts.sys.fileExists(refConfigPath)) continue;

    const refProject = parseProjectConfig(refConfigPath);
    if (!refProject) continue;

    for (const f of collectProjectFileNames(refProject, seen)) {
      fileNames.add(f);
    }
  }

  return fileNames;
}

/**
 * Load a TypeScript project and return the compiler's resolved state.
 * 
 * This is the observation hook:
 * 1. Find the project config (tsconfig.json)
 * 2. Create the program (triggers full resolution)
 * 3. Get the type checker (holds resolved symbols, types, references)
 * 4. Never emit — we only read
 * 
 * The type checker has already resolved every import to a real file,
 * every symbol to its declaration, every type through generics.
 * Tree-sitter can't do any of this.
 */
export function loadProject(targetDir: string): CompilerState {
  const absoluteDir = path.resolve(targetDir);

  // Step 1: Find tsconfig.json
  const configPath = ts.findConfigFile(
    absoluteDir,
    ts.sys.fileExists,
    'tsconfig.json'
  );

  if (!configPath) {
    throw new Error(
      `No tsconfig.json found in ${absoluteDir}. ` +
      `deep-graph requires a TypeScript project with a tsconfig.json.`
    );
  }

  // Step 2: Parse the config
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) {
    const message = ts.flattenDiagnosticMessageText(
      configFile.error.messageText,
      '\n'
    );
    throw new Error(`Error reading tsconfig.json: ${message}`);
  }

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath)
  );

  if (parsedConfig.errors.length > 0) {
    const messages = parsedConfig.errors
      .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    throw new Error(`tsconfig.json errors:\n${messages}`);
  }

  // Step 2b: Follow TypeScript project references, if any. A "solution"
  // tsconfig at a monorepo root often has no files of its own — just
  // `references` pointing at each package's tsconfig — so fileNames
  // would otherwise be empty.
  const rootNames = parsedConfig.projectReferences?.length
    ? Array.from(collectProjectFileNames({ configPath, parsed: parsedConfig }))
    : parsedConfig.fileNames;

  // Step 3: Create the program — this triggers full resolution
  // The compiler parses, binds, and resolves everything.
  // We read the result. We never call program.emit().
  //
  // Deliberately not passing `projectReferences` here: doing so makes
  // the compiler treat each referenced project as a separate build unit
  // that must already have its .d.ts output on disk (composite project
  // semantics), and fails with "output file has not been built from
  // source file" otherwise. rootNames already has every referenced
  // project's files flattened in, so a single ordinary program compiles
  // all of them from source directly — which is what we want to read.
  const program = ts.createProgram({
    rootNames,
    options: parsedConfig.options,
  });

  // Step 4: Get the type checker — our window into resolved state
  const checker = program.getTypeChecker();

  // Step 5: Filter to project source files (exclude node_modules, .d.ts)
  const projectRoot = path.dirname(configPath);
  const sourceFiles = program.getSourceFiles().filter(sf => {
    const filePath = sf.fileName;
    // Skip declaration files
    if (sf.isDeclarationFile) return false;
    // Skip node_modules
    if (filePath.includes('node_modules')) return false;
    // Only include files under the project root
    if (!filePath.startsWith(projectRoot)) return false;
    return true;
  });

  return {
    program,
    checker,
    sourceFiles,
    projectRoot,
    tsVersion: ts.version,
  };
}
