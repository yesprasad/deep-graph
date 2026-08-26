import ts from 'typescript';
import type { CompilerState } from '../compiler/loader';
import type { GraphNode, GraphEdge } from '../types/graph';
import { graphPath, moduleId } from './ids';

/**
 * MODULE EXTRACTOR
 *
 * Extracts the file-to-file dependency graph by reading the compiler's
 * resolved module map. Every import statement has already been resolved
 * by the TypeScript compiler to an actual file path or external package.
 *
 * This is what tree-sitter cannot do:
 * - tree-sitter sees: import { foo } from './bar'
 * - tsc knows: that resolves to /project/src/utils/bar.ts via path alias
 *
 * - tree-sitter sees: import { Router } from 'express'
 * - tsc knows: that resolves to node_modules/express/index.d.ts (external)
 */

/** Create a stable ID for an external package placeholder */
function externalId(packageName: string): string {
  return `external:${packageName}`;
}

/** Extract the package name from a node_modules path */
function getPackageName(filePath: string): string | null {
  const nmIndex = filePath.lastIndexOf('node_modules');
  if (nmIndex === -1) return null;

  const afterNm = filePath.substring(nmIndex + 'node_modules/'.length);
  // Handle scoped packages: @scope/package
  if (afterNm.startsWith('@')) {
    const parts = afterNm.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return afterNm.split('/')[0];
}

export interface ModuleExtractionResult {
  moduleNodes: GraphNode[];
  externalNodes: GraphNode[];
  importEdges: GraphEdge[];
  compositionEdges: GraphEdge[];
}

export function extractModules(state: CompilerState): ModuleExtractionResult {
  const { program, checker, sourceFiles, projectRoot } = state;

  const moduleNodes: GraphNode[] = [];
  const externalNodes: GraphNode[] = [];
  const importEdges: GraphEdge[] = [];
  const compositionEdges: GraphEdge[] = [];

  // Track external packages to avoid duplicate placeholder nodes
  const seenExternals = new Set<string>();

  // Step 1: Create a module node for each source file
  for (const sf of sourceFiles) {
    const relative = graphPath(sf.fileName, projectRoot);
    const id = moduleId(sf.fileName, projectRoot);

    // Count exports in this module
    const symbol = checker.getSymbolAtLocation(sf);
    const exports = symbol ? checker.getExportsOfModule(symbol) : [];

    moduleNodes.push({
      id,
      type: 'module',
      name: relative,
      attributes: {
        exportCount: exports.length,
        lineCount: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1,
      },
      source: {
        file: relative,
      },
    });
  }

  // Step 2: Walk import declarations and resolve targets
  for (const sf of sourceFiles) {
    const fromId = moduleId(sf.fileName, projectRoot);

    ts.forEachChild(sf, function visit(node: ts.Node) {
      // Handle: import { x } from './y'  |  import * as x from './y'
      if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
        processModuleSpecifier(node.moduleSpecifier, fromId, sf);
      }

      // Handle: export { x } from './y'
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        processModuleSpecifier(node.moduleSpecifier, fromId, sf);
      }

      // Handle: import x = require('./y')
      if (
        ts.isImportEqualsDeclaration(node) &&
        node.moduleReference &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression
      ) {
        processModuleSpecifier(
          node.moduleReference.expression,
          fromId,
          sf
        );
      }

      // Handle: const x = require('./y') — dynamic require
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.Identifier &&
        (node.expression as ts.Identifier).text === 'require' &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        processModuleSpecifier(node.arguments[0], fromId, sf);
      }

      ts.forEachChild(node, visit);
    });
  }

  function processModuleSpecifier(
    specifier: ts.Expression,
    fromId: string,
    sourceFile: ts.SourceFile
  ): void {
    if (!ts.isStringLiteral(specifier)) return;

    const moduleText = specifier.text;

    // Use the compiler's resolved module map — this is the key insight.
    // The compiler has already done the hard work of resolving paths.
    const resolvedModules = (sourceFile as any).resolvedModules;

    // Try the program's resolution API
    const resolved = ts.resolveModuleName(
      moduleText,
      sourceFile.fileName,
      program.getCompilerOptions(),
      ts.sys
    );

    if (resolved.resolvedModule) {
      const resolvedPath = resolved.resolvedModule.resolvedFileName;

      if (resolved.resolvedModule.isExternalLibraryImport) {
        // External package — create placeholder node
        const packageName = getPackageName(resolvedPath) || moduleText;
        const toId = externalId(packageName);

        if (!seenExternals.has(packageName)) {
          seenExternals.add(packageName);
          externalNodes.push({
            id: toId,
            type: 'external_package',
            name: packageName,
            attributes: {
              isExternal: true,
            },
            source: {
              file: `node_modules/${packageName}`,
            },
          });
        }

        importEdges.push({
          from: fromId,
          to: toId,
          type: 'import',
          via: moduleText,
        });
      } else {
        // Local project file — resolve to module node
        const toId = moduleId(resolvedPath, state.projectRoot);

        // Only create edge if target is a known source file
        const targetExists = sourceFiles.some(
          sf => sf.fileName === resolvedPath
        );

        if (targetExists) {
          importEdges.push({
            from: fromId,
            to: toId,
            type: 'import',
            via: moduleText,
          });
        }
      }
    }
  }

  return {
    moduleNodes,
    externalNodes,
    importEdges,
    compositionEdges,
  };
}
