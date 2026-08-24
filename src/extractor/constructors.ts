import ts from 'typescript';
import type { CompilerState } from '../compiler/loader';
import type { GraphEdge, GraphNode } from '../types/graph';
import { symbolId } from './ids';

/**
 * CONSTRUCTOR DEPENDENCY EXTRACTOR
 *
 * Resolves constructor parameter types on every class to their
 * declaring class or interface — no framework knowledge required.
 *
 * If a class has:
 *   class UserService {
 *     constructor(private db: DatabaseService) {}
 *   }
 *
 * The checker resolves `DatabaseService` to its declaration file
 * and emits a `depends_on` edge. This captures DI wiring (NestJS,
 * Angular, InversifyJS) without hardcoding decorator names, because
 * the structural dependency exists regardless of what runtime
 * container wires it.
 *
 * Untyped parameters (`constructor(db)`) resolve to `any` and
 * produce no edge — the checker has nothing to point to.
 */

export interface ConstructorExtractionResult {
  dependsOnEdges: GraphEdge[];
  decoratorAttributes: Map<string, string[]>;
}

export function extractConstructorDeps(
  state: CompilerState,
  symbolNodes: GraphNode[]
): ConstructorExtractionResult {
  const { checker, sourceFiles, projectRoot } = state;

  const dependsOnEdges: GraphEdge[] = [];
  const decoratorAttributes = new Map<string, string[]>();
  const seenEdges = new Set<string>();

  const knownNodeIds = new Set(
    symbolNodes.filter(n => n.type === 'class' || n.type === 'interface').map(n => n.id)
  );

  for (const sf of sourceFiles) {
    ts.forEachChild(sf, function visit(node: ts.Node) {
      if (!ts.isClassDeclaration(node) || !node.name) {
        ts.forEachChild(node, visit);
        return;
      }

      const className = node.name.text;
      const classId = symbolId(sf.fileName, className, projectRoot);

      // Collect decorator names as optional metadata (no gating)
      const decorators = collectDecoratorNames(node);
      if (decorators.length > 0) {
        decoratorAttributes.set(classId, decorators);
      }

      // Resolve every constructor parameter's type annotation
      const ctor = node.members.find(ts.isConstructorDeclaration);
      if (ctor) {
        for (const param of ctor.parameters) {
          const resolved = resolveParameterType(param, checker, projectRoot);
          if (resolved && resolved.targetId !== classId) {
            const key = `${classId}|${resolved.targetId}`;
            if (!seenEdges.has(key) && knownNodeIds.has(resolved.targetId)) {
              seenEdges.add(key);
              dependsOnEdges.push({
                from: classId,
                to: resolved.targetId,
                type: 'depends_on',
                via: resolved.paramName,
              });
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    });
  }

  return { dependsOnEdges, decoratorAttributes };
}

interface ResolvedParam {
  targetId: string;
  paramName: string;
}

function resolveParameterType(
  param: ts.ParameterDeclaration,
  checker: ts.TypeChecker,
  projectRoot: string
): ResolvedParam | null {
  const paramName = ts.isIdentifier(param.name) ? param.name.text : '?';

  // If the parameter has a decorator with a class argument (e.g.
  // @InjectRepository(UserEntity)), try resolving that argument first —
  // it's often more specific than the generic wrapper type annotation.
  const paramDecorators = ts.canHaveDecorators(param) ? ts.getDecorators(param) : undefined;
  if (paramDecorators) {
    for (const dec of paramDecorators) {
      if (ts.isCallExpression(dec.expression) && dec.expression.arguments.length > 0) {
        const firstArg = dec.expression.arguments[0];
        const resolved = resolveExpressionToDeclaration(firstArg, checker, projectRoot);
        if (resolved) return { targetId: resolved, paramName };
      }
    }
  }

  // Resolve the type annotation itself
  if (!param.type) return null;

  const type = checker.getTypeAtLocation(param.type);
  let symbol = type.getSymbol();
  if (!symbol) return null;

  if (symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }

  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return null;

  const decl = declarations[0];
  const declFile = decl.getSourceFile();
  if (declFile.fileName.includes('node_modules')) return null;

  if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
    const targetName = symbol.getName();
    return { targetId: symbolId(declFile.fileName, targetName, projectRoot), paramName };
  }

  return null;
}

function resolveExpressionToDeclaration(
  expr: ts.Expression,
  checker: ts.TypeChecker,
  projectRoot: string
): string | null {
  let symbol = checker.getSymbolAtLocation(expr);
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
    return symbolId(declFile.fileName, decl.name.text, projectRoot);
  }
  if (ts.isInterfaceDeclaration(decl)) {
    return symbolId(declFile.fileName, decl.name.text, projectRoot);
  }

  return null;
}

function collectDecoratorNames(node: ts.ClassDeclaration): string[] {
  const modifiers = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
  if (!modifiers) return [];

  const names: string[] = [];
  for (const decorator of modifiers) {
    if (ts.isCallExpression(decorator.expression)) {
      const expr = decorator.expression.expression;
      if (ts.isIdentifier(expr)) {
        names.push(expr.text);
      } else if (ts.isPropertyAccessExpression(expr)) {
        names.push(expr.name.text);
      }
    } else if (ts.isIdentifier(decorator.expression)) {
      names.push(decorator.expression.text);
    }
  }

  return names;
}
