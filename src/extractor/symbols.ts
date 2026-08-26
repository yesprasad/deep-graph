import ts from 'typescript';
import type { CompilerState } from '../compiler/loader';
import type { GraphNode, GraphEdge, NodeType } from '../types/graph';
import { graphPath, moduleId, symbolId, methodId } from './ids';

/**
 * SYMBOL EXTRACTOR
 *
 * Extracts declarations (functions, classes, interfaces, types, enums)
 * and their resolved relationships:
 * - Class extends/implements (resolved through the type checker)
 * - Function call edges (resolved to actual declarations, not string names)
 * - Type references (resolved through generics, aliases, etc.)
 *
 * Every resolution uses checker.getSymbolAtLocation() or
 * checker.getTypeAtLocation() — reading the compiler's already-resolved
 * state, not re-analyzing the source.
 */

export interface SymbolExtractionResult {
  symbolNodes: GraphNode[];
  symbolEdges: GraphEdge[];
  compositionEdges: GraphEdge[];
}

export function extractSymbols(state: CompilerState): SymbolExtractionResult {
  const { checker, sourceFiles, projectRoot } = state;

  const symbolNodes: GraphNode[] = [];
  const symbolEdges: GraphEdge[] = [];
  const compositionEdges: GraphEdge[] = [];

  // Track seen symbols to avoid duplicates
  const seenSymbols = new Set<string>();

  for (const sf of sourceFiles) {
    const relative = graphPath(sf.fileName, projectRoot);
    const parentModuleId = moduleId(sf.fileName, projectRoot);

    ts.forEachChild(sf, function visit(node: ts.Node) {
      // ── Function Declarations ──
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const id = symbolId(sf.fileName, name, projectRoot);

        if (!seenSymbols.has(id)) {
          seenSymbols.add(id);
          const pos = sf.getLineAndCharacterOfPosition(node.getStart());

          symbolNodes.push({
            id,
            type: 'function',
            name,
            qualifiedName: `${relative}::${name}`,
            attributes: {
              exported: hasExportModifier(node),
              async: !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
              parameterCount: node.parameters.length,
            },
            source: {
              file: relative,
              line: pos.line + 1,
              column: pos.character + 1,
            },
          });

          // Composition edge: module contains function
          compositionEdges.push({
            from: parentModuleId,
            to: id,
            type: 'composition',
          });
        }
      }

      // ── Exported arrow functions / const declarations ──
      if (ts.isVariableStatement(node) && hasExportModifier(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) ||
              ts.isFunctionExpression(decl.initializer))
          ) {
            const name = decl.name.text;
            const id = symbolId(sf.fileName, name, projectRoot);

            if (!seenSymbols.has(id)) {
              seenSymbols.add(id);
              const pos = sf.getLineAndCharacterOfPosition(node.getStart());

              symbolNodes.push({
                id,
                type: 'function',
                name,
                qualifiedName: `${relative}::${name}`,
                attributes: {
                  exported: true,
                  arrow: ts.isArrowFunction(decl.initializer),
                  parameterCount: decl.initializer.parameters.length,
                },
                source: {
                  file: relative,
                  line: pos.line + 1,
                  column: pos.character + 1,
                },
              });

              compositionEdges.push({
                from: parentModuleId,
                to: id,
                type: 'composition',
              });
            }
          }
        }
      }

      // ── Class Declarations ──
      if (ts.isClassDeclaration(node) && node.name) {
        const name = node.name.text;
        const id = symbolId(sf.fileName, name, projectRoot);

        if (!seenSymbols.has(id)) {
          seenSymbols.add(id);
          const pos = sf.getLineAndCharacterOfPosition(node.getStart());

          // Count members
          const methods = node.members.filter(ts.isMethodDeclaration).length;
          const properties = node.members.filter(ts.isPropertyDeclaration).length;

          symbolNodes.push({
            id,
            type: 'class',
            name,
            qualifiedName: `${relative}::${name}`,
            attributes: {
              exported: hasExportModifier(node),
              abstract: !!node.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword),
              methodCount: methods,
              propertyCount: properties,
            },
            source: {
              file: relative,
              line: pos.line + 1,
              column: pos.character + 1,
            },
          });

          compositionEdges.push({
            from: parentModuleId,
            to: id,
            type: 'composition',
          });

          // ── Heritage: extends / implements ──
          if (node.heritageClauses) {
            for (const clause of node.heritageClauses) {
              for (const typeExpr of clause.types) {
                const edgeType = clause.token === ts.SyntaxKind.ExtendsKeyword
                  ? 'extends' as const
                  : 'implements' as const;

                const targetType = checker.getTypeAtLocation(typeExpr);
                const targetSymbol = targetType.getSymbol();

                if (targetSymbol) {
                  const declarations = targetSymbol.getDeclarations();
                  if (declarations && declarations.length > 0) {
                    const targetDecl = declarations[0];
                    const targetFile = targetDecl.getSourceFile();

                    // Only create edge if target is in our project
                    if (!targetFile.fileName.includes('node_modules')) {
                      const targetName = targetSymbol.getName();
                      const targetId = symbolId(
                        targetFile.fileName,
                        targetName,
                        projectRoot
                      );

                      symbolEdges.push({
                        from: id,
                        to: targetId,
                        type: edgeType,
                        via: targetName,
                      });
                    }
                  }
                }
              }
            }
          }

          // ── Methods (including the constructor) ──
          for (const member of node.members) {
            const isMethod = ts.isMethodDeclaration(member) && member.body;
            const isConstructor = ts.isConstructorDeclaration(member) && member.body;
            if (!isMethod && !isConstructor) continue;

            const methodName = isConstructor
              ? 'constructor'
              : ts.isIdentifier(member.name!) ? member.name!.text : null;
            if (!methodName) continue; // skip computed method names

            const mId = methodId(sf.fileName, name, methodName, projectRoot);
            if (seenSymbols.has(mId)) continue;
            seenSymbols.add(mId);

            const mPos = sf.getLineAndCharacterOfPosition(member.getStart());

            symbolNodes.push({
              id: mId,
              type: 'method',
              name: methodName,
              qualifiedName: `${relative}::${name}.${methodName}`,
              attributes: {
                className: name,
                static: !!member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword),
                async: !isConstructor && !!member.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword),
                parameterCount: member.parameters.length,
              },
              source: {
                file: relative,
                line: mPos.line + 1,
                column: mPos.character + 1,
              },
            });

            // Composition: the class contains the method (not the module —
            // the class is the method's real parent).
            compositionEdges.push({
              from: id,
              to: mId,
              type: 'composition',
            });
          }
        }
      }

      // ── Interface Declarations ──
      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const id = symbolId(sf.fileName, name, projectRoot);

        if (!seenSymbols.has(id)) {
          seenSymbols.add(id);
          const pos = sf.getLineAndCharacterOfPosition(node.getStart());

          symbolNodes.push({
            id,
            type: 'interface',
            name,
            qualifiedName: `${relative}::${name}`,
            attributes: {
              exported: hasExportModifier(node),
              memberCount: node.members.length,
            },
            source: {
              file: relative,
              line: pos.line + 1,
              column: pos.character + 1,
            },
          });

          compositionEdges.push({
            from: parentModuleId,
            to: id,
            type: 'composition',
          });

          // Interface extends
          if (node.heritageClauses) {
            for (const clause of node.heritageClauses) {
              for (const typeExpr of clause.types) {
                const targetType = checker.getTypeAtLocation(typeExpr);
                const targetSymbol = targetType.getSymbol();

                if (targetSymbol) {
                  const declarations = targetSymbol.getDeclarations();
                  if (declarations && declarations.length > 0) {
                    const targetDecl = declarations[0];
                    const targetFile = targetDecl.getSourceFile();

                    if (!targetFile.fileName.includes('node_modules')) {
                      const targetName = targetSymbol.getName();
                      const targetId = symbolId(
                        targetFile.fileName,
                        targetName,
                        projectRoot
                      );

                      symbolEdges.push({
                        from: id,
                        to: targetId,
                        type: 'extends',
                        via: targetName,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }

      // ── Type Aliases ──
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const id = symbolId(sf.fileName, name, projectRoot);

        if (!seenSymbols.has(id)) {
          seenSymbols.add(id);
          const pos = sf.getLineAndCharacterOfPosition(node.getStart());

          symbolNodes.push({
            id,
            type: 'type_alias',
            name,
            qualifiedName: `${relative}::${name}`,
            attributes: {
              exported: hasExportModifier(node),
            },
            source: {
              file: relative,
              line: pos.line + 1,
              column: pos.character + 1,
            },
          });

          compositionEdges.push({
            from: parentModuleId,
            to: id,
            type: 'composition',
          });
        }
      }

      // ── Enum Declarations ──
      if (ts.isEnumDeclaration(node)) {
        const name = node.name.text;
        const id = symbolId(sf.fileName, name, projectRoot);

        if (!seenSymbols.has(id)) {
          seenSymbols.add(id);
          const pos = sf.getLineAndCharacterOfPosition(node.getStart());

          symbolNodes.push({
            id,
            type: 'enum',
            name,
            qualifiedName: `${relative}::${name}`,
            attributes: {
              exported: hasExportModifier(node),
              memberCount: node.members.length,
            },
            source: {
              file: relative,
              line: pos.line + 1,
              column: pos.character + 1,
            },
          });

          compositionEdges.push({
            from: parentModuleId,
            to: id,
            type: 'composition',
          });
        }
      }

      ts.forEachChild(node, visit);
    });
  }

  // Export modifiers alone are not enough: `export { value }`, re-exports,
  // and default assignments expose symbols without modifying the declaration.
  // Ask the checker for the actual public surface, then ensure it has nodes.
  const projectFiles = new Set(sourceFiles.map(sf => sf.fileName));
  for (const sf of sourceFiles) {
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const target = resolveAlias(checker, exported);
      const declaration = target.getDeclarations()?.find(d =>
        projectFiles.has(d.getSourceFile().fileName)
      );
      if (declaration) {
        ensureExportedSymbol(
          declaration,
          target.getName(),
          projectRoot,
          symbolNodes,
          compositionEdges,
          seenSymbols,
        );
      }
    }
  }

  // An import binding is a resolved use of a specific exported symbol, not
  // merely a file-to-file relationship. These edges make `unused` correct for
  // ordinary named/default imports and give blast radius a readable reason.
  const symbolIds = new Set(symbolNodes.map(n => n.id));
  const seenImportEdges = new Set<string>();
  const addImportReference = (fromId: string, node: ts.Node, via: string) => {
    const resolved = checker.getSymbolAtLocation(node);
    if (!resolved) return;
    const target = resolveAlias(checker, resolved);
    const declaration = target.getDeclarations()?.find(d => projectFiles.has(d.getSourceFile().fileName));
    if (!declaration) return;
    const targetId = symbolId(
      declaration.getSourceFile().fileName,
      exportedName(declaration, target.getName()),
      projectRoot,
    );
    if (!symbolIds.has(targetId)) return;
    const key = `${fromId}|${targetId}|${via}`;
    if (seenImportEdges.has(key)) return;
    seenImportEdges.add(key);
    symbolEdges.push({ from: fromId, to: targetId, type: 'import', via });
  };

  for (const sf of sourceFiles) {
    const fromId = moduleId(sf.fileName, projectRoot);
    ts.forEachChild(sf, function visitImportUse(node: ts.Node) {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const via = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : 'import';
        if (node.importClause.name) addImportReference(fromId, node.importClause.name, via);
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) addImportReference(fromId, element.name, via);
        }
      }

      if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        const specifier = node.moduleSpecifier;
        const via = specifier && ts.isStringLiteral(specifier) ? specifier.text : 're-export';
        for (const element of node.exportClause.elements) addImportReference(fromId, element.name, via);
      }

      // `import * as api` is only evidence for a member once that member is
      // accessed. The checker resolves the property to the exported symbol.
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        addImportReference(fromId, node.name, node.getText(sf));
      }

      ts.forEachChild(node, visitImportUse);
    });
  }

  return {
    symbolNodes,
    symbolEdges,
    compositionEdges,
  };
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function exportedName(declaration: ts.Declaration, fallback: string): string {
  if (
    (ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)) &&
    declaration.name
  ) {
    return declaration.name.text;
  }
  if (
    (ts.isInterfaceDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration) ||
      ts.isVariableDeclaration(declaration)) &&
    ts.isIdentifier(declaration.name)
  ) {
    return declaration.name.text;
  }
  return ts.isExportAssignment(declaration) ? 'default' : fallback;
}

function ensureExportedSymbol(
  declaration: ts.Declaration,
  name: string,
  projectRoot: string,
  symbolNodes: GraphNode[],
  compositionEdges: GraphEdge[],
  seenSymbols: Set<string>,
): void {
  const sourceFile = declaration.getSourceFile();
  const id = symbolId(sourceFile.fileName, name, projectRoot);
  const existing = symbolNodes.find(node => node.id === id);
  if (existing) {
    existing.attributes.exported = true;
    return;
  }

  let type: NodeType | null = null;
  let declarationName = exportedName(declaration, name);
  let attributes: Record<string, unknown> = {};

  if (ts.isFunctionDeclaration(declaration)) {
    type = 'function';
    declarationName = declaration.name?.text ?? name;
    attributes = { exported: true, async: !!declaration.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword), parameterCount: declaration.parameters.length };
  } else if (ts.isClassDeclaration(declaration)) {
    type = 'class';
    declarationName = declaration.name?.text ?? name;
    attributes = { exported: true, abstract: !!declaration.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword) };
  } else if (ts.isInterfaceDeclaration(declaration)) {
    type = 'interface';
    declarationName = declaration.name.text;
    attributes = { exported: true, memberCount: declaration.members.length };
  } else if (ts.isTypeAliasDeclaration(declaration)) {
    type = 'type_alias';
    declarationName = declaration.name.text;
    attributes = { exported: true };
  } else if (ts.isEnumDeclaration(declaration)) {
    type = 'enum';
    declarationName = declaration.name.text;
    attributes = { exported: true, memberCount: declaration.members.length };
  } else if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    type = 'variable';
    declarationName = declaration.name.text;
    attributes = { exported: true };
  } else if (ts.isExportAssignment(declaration)) {
    type = 'variable';
    declarationName = 'default';
    attributes = { exported: true, default: true };
  }

  if (!type) return;
  const nodeId = symbolId(sourceFile.fileName, declarationName, projectRoot);
  if (seenSymbols.has(nodeId)) return;
  seenSymbols.add(nodeId);
  const pos = sourceFile.getLineAndCharacterOfPosition(declaration.getStart());
  symbolNodes.push({
    id: nodeId,
    type,
    name: declarationName,
    qualifiedName: `${graphPath(sourceFile.fileName, projectRoot)}::${declarationName}`,
    attributes,
    source: { file: graphPath(sourceFile.fileName, projectRoot), line: pos.line + 1, column: pos.character + 1 },
  });
  compositionEdges.push({ from: moduleId(sourceFile.fileName, projectRoot), to: nodeId, type: 'composition' });
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
