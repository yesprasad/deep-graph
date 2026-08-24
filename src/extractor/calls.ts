import ts from 'typescript';
import type { CompilerState } from '../compiler/loader';
import type { GraphEdge, GraphNode } from '../types/graph';
import { symbolId, methodId } from './ids';

/**
 * CALL GRAPH EXTRACTOR
 *
 * Extracts function-to-function and method-to-method call edges by
 * resolving each call site's callee through the type checker — not by
 * matching the text of the call expression against declared names.
 *
 * checker.getSymbolAtLocation() on a call's callee resolves through
 * imports, re-exports, and aliasing to the actual declaration, the same
 * way `go to definition` does in an editor — and it resolves `this.foo()`
 * and `obj.method()` exactly the same way it resolves a plain identifier,
 * since it's reading the checker's already-computed type of `this`/`obj`,
 * not re-deriving it.
 *
 * Scope: top-level named functions, exported arrow/function-expression
 * consts, and class methods/constructors — the same set extractSymbols()
 * tracks as `function`/`method` nodes. Calls through a callback stored in
 * a variable, or dispatched dynamically (`obj[key]()`), aren't resolved —
 * the checker has no single declaration to point at for those.
 */

export interface CallExtractionResult {
  callEdges: GraphEdge[];
}

export function extractCalls(
  state: CompilerState,
  symbolNodes: GraphNode[]
): CallExtractionResult {
  const { checker, sourceFiles, projectRoot } = state;

  const trackedCallableIds = new Set(
    symbolNodes.filter(n => n.type === 'function' || n.type === 'method').map(n => n.id)
  );

  const trackedClassIds = new Set(
    symbolNodes.filter(n => n.type === 'class').map(n => n.id)
  );

  const callEdges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  for (const sf of sourceFiles) {
    walk(sf, null);

    function walk(node: ts.Node, callerId: string | null): void {
      // Named function declaration: everything in its body attributes to it.
      if (ts.isFunctionDeclaration(node) && node.name) {
        const id = symbolId(sf.fileName, node.name.text, projectRoot);
        const nextCallerId = trackedCallableIds.has(id) ? id : callerId;
        if (node.body) {
          ts.forEachChild(node.body, child => walk(child, nextCallerId));
        }
        return;
      }

      // Exported arrow function / function expression assigned to a const.
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          ) {
            const id = symbolId(sf.fileName, decl.name.text, projectRoot);
            const nextCallerId = trackedCallableIds.has(id) ? id : callerId;
            walk(decl.initializer, nextCallerId);
          } else if (decl.initializer) {
            walk(decl.initializer, callerId);
          }
        }
        return;
      }

      // Class method / constructor: body attributes to the method, scoped
      // to its declaring class.
      if (
        (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) &&
        node.body &&
        ts.isClassDeclaration(node.parent) &&
        node.parent.name
      ) {
        const className = node.parent.name.text;
        const name = ts.isConstructorDeclaration(node)
          ? 'constructor'
          : ts.isIdentifier(node.name) ? node.name.text : null;

        if (name) {
          const id = methodId(sf.fileName, className, name, projectRoot);
          const nextCallerId = trackedCallableIds.has(id) ? id : callerId;
          ts.forEachChild(node.body, child => walk(child, nextCallerId));
          return;
        }
      }

      if (ts.isCallExpression(node) && callerId) {
        const target = resolveCallTarget(node);
        if (target && target.id !== callerId) {
          const key = `${callerId}|${target.id}|${target.name}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            callEdges.push({
              from: callerId,
              to: target.id,
              type: 'call',
              via: target.name,
            });
          }
        }
      }

      if (ts.isNewExpression(node) && callerId) {
        const target = resolveNewTarget(node);
        if (target && target.id !== callerId) {
          const key = `${callerId}|${target.id}|${target.name}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            callEdges.push({
              from: callerId,
              to: target.id,
              type: 'call',
              via: `new ${target.name}`,
            });
          }
        }
      }

      ts.forEachChild(node, child => walk(child, callerId));
    }
  }

  function resolveCallTarget(node: ts.CallExpression): { id: string; name: string } | null {
    const expr = node.expression;
    let nameNode: ts.Node;

    if (ts.isIdentifier(expr)) {
      nameNode = expr;
    } else if (ts.isPropertyAccessExpression(expr)) {
      // Handles namespace-qualified calls (`utils.formatDate()`) and
      // method calls (`this.foo()`, `obj.method()`) uniformly — the
      // checker resolves the property to a declaration either way.
      nameNode = expr.name;
    } else {
      return null;
    }

    let symbol = checker.getSymbolAtLocation(nameNode);
    if (!symbol) return null;

    // An imported identifier resolves to an alias symbol whose own
    // declaration is the import specifier, not the function. Follow it
    // to the real declaration — same principle as the heritage resolution
    // in extractSymbols().
    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) return null;

    const decl = declarations[0];
    const declFile = decl.getSourceFile();
    if (declFile.fileName.includes('node_modules')) return null;

    let id: string;
    let declName: string;

    if (ts.isFunctionDeclaration(decl) && decl.name) {
      declName = decl.name.text;
      id = symbolId(declFile.fileName, declName, projectRoot);
    } else if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
      declName = decl.name.text;
      id = symbolId(declFile.fileName, declName, projectRoot);
    } else if (
      (ts.isMethodDeclaration(decl) || ts.isConstructorDeclaration(decl)) &&
      ts.isClassDeclaration(decl.parent) &&
      decl.parent.name
    ) {
      const className = decl.parent.name.text;
      declName = ts.isConstructorDeclaration(decl)
        ? 'constructor'
        : ts.isIdentifier(decl.name) ? decl.name.text : '';
      if (!declName) return null;
      id = methodId(declFile.fileName, className, declName, projectRoot);
    } else {
      return null;
    }

    if (!trackedCallableIds.has(id)) return null;

    return { id, name: declName };
  }

  function resolveNewTarget(node: ts.NewExpression): { id: string; name: string } | null {
    const expr = node.expression;
    let nameNode: ts.Node;

    if (ts.isIdentifier(expr)) {
      nameNode = expr;
    } else if (ts.isPropertyAccessExpression(expr)) {
      nameNode = expr.name;
    } else {
      return null;
    }

    let symbol = checker.getSymbolAtLocation(nameNode);
    if (!symbol) return null;

    if (symbol.flags & ts.SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) return null;

    const decl = declarations[0];
    const declFile = decl.getSourceFile();
    if (declFile.fileName.includes('node_modules')) return null;

    if (ts.isClassDeclaration(decl) && decl.name) {
      const className = decl.name.text;
      const ctorId = methodId(declFile.fileName, className, 'constructor', projectRoot);
      if (trackedCallableIds.has(ctorId)) {
        return { id: ctorId, name: className };
      }
      const classId = symbolId(declFile.fileName, className, projectRoot);
      if (trackedClassIds.has(classId)) {
        return { id: classId, name: className };
      }
    }

    return null;
  }

  return { callEdges };
}
