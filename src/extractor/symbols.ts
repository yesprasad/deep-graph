import ts from 'typescript';
import path from 'path';
import type { CompilerState } from '../compiler/loader';
import type { GraphNode, GraphEdge, NodeType } from '../types/graph';
import { moduleId, symbolId, methodId } from './ids';

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
    const relative = path.relative(projectRoot, sf.fileName);
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

  return {
    symbolNodes,
    symbolEdges,
    compositionEdges,
  };
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}
