import ts from 'typescript';
import path from 'path';
import type { CompilerState } from '../compiler/loader';
import type { BridgeConfidence, GraphEdge, GraphNode } from '../types/graph';
import { methodId, moduleId, symbolId } from '../extractor/ids';

/**
 * TYPESCRIPT <-> OPENAPI BRIDGE
 *
 * Connects code to the contract it serves or calls. Everything here is a
 * claim about two artifacts being the same thing, and those claims vary
 * wildly in trustworthiness — so every bridge edge carries the evidence
 * that produced it.
 *
 * Strategies run strongest-first, and a stronger match wins: once an
 * operation has an explicit implementation, a name heuristic will not
 * add a competing one.
 *
 *   explicit    @openapi JSDoc annotation
 *   framework   route decorator or router registration
 *   shared_type a TS type generated from / shared with the schema
 *   inferred    name match only
 *
 * `generated` (client-generator metadata) is reserved for a later stage;
 * the tier exists so those edges rank correctly when it lands.
 */

export interface BridgeResult {
  edges: GraphEdge[];
  counts: Partial<Record<BridgeConfidence, number>>;
}

interface ApiIndex {
  /** "POST /login" -> node id */
  byLabel: Map<string, string>;
  /** operationId -> node id */
  byOperationId: Map<string, string>;
  /** "post" + normalized route -> node id */
  byRoute: Map<string, string>;
  /** schema name (lowercased) -> node id */
  schemaByName: Map<string, string>;
}

const ROUTE_DECORATORS = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all',
]);

/**
 * Normalize a route for comparison: strip trailing slashes and reduce
 * every path parameter to a positional marker, so `/users/{id}` from the
 * spec matches `/users/:id` from an Express route.
 */
function normalizeRoute(route: string): string {
  const withoutParams = route
    .replace(/\{[^}]*\}/g, '{}')
    .replace(/:[A-Za-z0-9_]+/g, '{}');
  const trimmed = withoutParams.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function buildApiIndex(apiNodes: GraphNode[]): ApiIndex {
  const index: ApiIndex = {
    byLabel: new Map(),
    byOperationId: new Map(),
    byRoute: new Map(),
    schemaByName: new Map(),
  };

  for (const node of apiNodes) {
    if (node.type === 'api_operation') {
      const method = String(node.attributes.method ?? '').toUpperCase();
      const route = String(node.attributes.route ?? '');

      index.byLabel.set(`${method} ${normalizeRoute(route)}`, node.id);
      index.byRoute.set(`${method.toLowerCase()}${normalizeRoute(route)}`, node.id);

      const opId = node.attributes.operationId;
      if (typeof opId === 'string' && opId) {
        index.byOperationId.set(opId, node.id);
      }
    } else if (node.type === 'api_schema') {
      // First declaration wins, so a duplicate name across two documents
      // does not silently retarget an existing bridge.
      const key = node.name.toLowerCase();
      if (!index.schemaByName.has(key)) index.schemaByName.set(key, node.id);
    }
  }

  return index;
}

/** Look up an operation by "METHOD /route" or by operationId. */
function findOperation(index: ApiIndex, reference: string): string | null {
  const trimmed = reference.trim();

  const match = trimmed.match(/^([A-Za-z]+)\s+(\S+)$/);
  if (match) {
    const [, method, route] = match;
    const byLabel = index.byLabel.get(
      `${method.toUpperCase()} ${normalizeRoute(route)}`
    );
    if (byLabel) return byLabel;
  }

  return index.byOperationId.get(trimmed) ?? null;
}

/** All JSDoc comment text attached to a node, joined. */
function jsDocText(node: ts.Node): string {
  const docs = (node as unknown as { jsDoc?: ts.Node[] }).jsDoc;
  if (!docs?.length) return '';
  return docs.map(d => d.getFullText()).join('\n');
}

/** The string literal passed as the first argument, if there is one. */
function firstStringArg(args: ts.NodeArray<ts.Expression>): string | null {
  const first = args[0];
  if (first && ts.isStringLiteralLike(first)) return first.text;
  return null;
}

export function bridgeToTypeScript(
  state: CompilerState,
  apiNodes: GraphNode[]
): BridgeResult {
  const index = buildApiIndex(apiNodes);
  const edges: GraphEdge[] = [];

  // One bridge per (source, target, kind). Strategies run strongest
  // first, so an earlier claim always wins over a weaker later one.
  const claimed = new Set<string>();
  const counts: Partial<Record<BridgeConfidence, number>> = {};

  const addEdge = (
    from: string,
    to: string,
    type: 'api_implements' | 'api_consumes',
    confidence: BridgeConfidence,
    via: string
  ): void => {
    const key = `${from}|${to}|${type}`;
    if (claimed.has(key)) return;
    claimed.add(key);
    edges.push({ from, to, type, via, confidence });
    counts[confidence] = (counts[confidence] ?? 0) + 1;
  };

  const root = state.projectRoot;

  // Two passes over the same files: explicit annotations everywhere
  // first, then the weaker heuristics.
  interface Candidate {
    /** Graph id of the declaring symbol, or its module as a fallback. */
    holderId: string;
    moduleId: string;
    node: ts.Node;
    /** Class-level route prefix, for decorator-based frameworks. */
    prefix: string;
  }

  const candidates: Candidate[] = [];
  const typeDeclarations: Array<{ id: string; name: string; file: string }> = [];

  for (const sf of state.sourceFiles) {
    const modId = moduleId(sf.fileName, root);

    const visit = (
      node: ts.Node,
      enclosingClass: string | null,
      prefix: string,
      enclosingHolder: string
    ): void => {
      // Anything that is not itself a declaration is attributed to the
      // nearest enclosing one — a `router.post(...)` inside `registerRoutes`
      // belongs to that function, not to the file.
      let holderId = enclosingHolder;
      let nextClass = enclosingClass;
      let nextPrefix = prefix;

      if (ts.isClassDeclaration(node) && node.name) {
        nextClass = node.name.text;
        holderId = symbolId(sf.fileName, nextClass, root);

        // A controller-style class often carries the shared path prefix.
        for (const decorator of ts.getDecorators(node) ?? []) {
          if (!ts.isCallExpression(decorator.expression)) continue;
          const literal = firstStringArg(decorator.expression.arguments);
          if (literal) nextPrefix = literal;
        }
      } else if (ts.isMethodDeclaration(node) && enclosingClass && node.name) {
        holderId = methodId(
          sf.fileName,
          enclosingClass,
          node.name.getText(sf),
          root
        );
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        holderId = symbolId(sf.fileName, node.name.text, root);
      } else if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) ||
          ts.isFunctionExpression(node.initializer))
      ) {
        holderId = symbolId(sf.fileName, node.name.text, root);
      } else if (
        (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
        node.name
      ) {
        typeDeclarations.push({
          id: symbolId(sf.fileName, node.name.text, root),
          name: node.name.text,
          file: path.relative(root, sf.fileName),
        });
        holderId = symbolId(sf.fileName, node.name.text, root);
      }

      // Only keep nodes a strategy could actually match on. Retaining
      // every AST node would hold the whole program in memory for the
      // sake of a handful of annotations and route registrations.
      const interesting =
        jsDocText(node).includes('@openapi') ||
        (ts.getDecorators(node as ts.HasDecorators)?.length ?? 0) > 0 ||
        (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression));

      if (interesting) {
        candidates.push({ holderId, moduleId: modId, node, prefix: nextPrefix });
      }

      ts.forEachChild(node, child => visit(child, nextClass, nextPrefix, holderId));
    };

    ts.forEachChild(sf, child => visit(child, null, '', modId));
  }

  // ── Tier 1: explicit @openapi annotations ─────────────
  //
  //   /** @openapi POST /login */          -> implements
  //   /** @openapi-consumes GET /users */  -> consumes
  //   /** @openapi-schema LoginSuccess */  -> shared type
  //
  // An annotation is a maintained statement of intent, so it outranks
  // anything inferred from shape or naming.
  for (const candidate of candidates) {
    const doc = jsDocText(candidate.node);
    if (!doc.includes('@openapi')) continue;

    for (const match of doc.matchAll(/@openapi(-consumes|-schema)?\s+([^\n*]+)/g)) {
      const kind = match[1] ?? '';
      const reference = match[2].trim();
      if (!reference) continue;

      if (kind === '-schema') {
        const schemaNode = index.schemaByName.get(reference.toLowerCase());
        if (schemaNode) {
          addEdge(candidate.holderId, schemaNode, 'api_implements', 'explicit', 'annotation');
        }
        continue;
      }

      const operation = findOperation(index, reference);
      if (!operation) continue;

      addEdge(
        candidate.holderId,
        operation,
        kind === '-consumes' ? 'api_consumes' : 'api_implements',
        'explicit',
        'annotation'
      );
    }
  }

  // ── Tier 3: framework routes ──────────────────────────
  //
  // Decorator form:  @Post('/login')  on a controller method
  // Router form:     router.post('/login', handler)
  //
  // Both name a real route registration, which is stronger evidence than
  // a shared identifier but weaker than a maintained annotation — a
  // framework can rewrite prefixes in ways static reading will not see.
  for (const candidate of candidates) {
    const { node } = candidate;

    for (const decorator of ts.getDecorators(node as ts.HasDecorators) ?? []) {
      if (!ts.isCallExpression(decorator.expression)) continue;
      const expr = decorator.expression.expression;
      if (!ts.isIdentifier(expr)) continue;

      const verb = expr.text.toLowerCase();
      if (!ROUTE_DECORATORS.has(verb)) continue;

      const literal = firstStringArg(decorator.expression.arguments) ?? '';
      const route = normalizeRoute(`${candidate.prefix}${literal}`);
      const operation = index.byRoute.get(`${verb}${route}`);
      if (operation) {
        addEdge(candidate.holderId, operation, 'api_implements', 'framework', `@${expr.text}`);
      }
    }

    // router.post('/login', handler) / app.get(...) / fetch-style clients
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const verb = node.expression.name.text.toLowerCase();
      if (!ROUTE_DECORATORS.has(verb)) continue;

      const literal = firstStringArg(node.arguments);
      if (!literal || !literal.startsWith('/')) continue;

      const operation = index.byRoute.get(`${verb}${normalizeRoute(literal)}`);
      if (!operation) continue;

      // A handler argument means this registers the route; without one it
      // is a call against the route, i.e. a consumer.
      const hasHandler = node.arguments
        .slice(1)
        .some(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a) || ts.isIdentifier(a));

      addEdge(
        candidate.holderId,
        operation,
        hasHandler ? 'api_implements' : 'api_consumes',
        'framework',
        `${verb}('${literal}')`
      );
    }
  }

  // ── Tier 5: name matching (inferred) ──────────────────
  //
  // Deliberately last and deliberately labelled. `User` in a spec and
  // `User` in TypeScript are frequently unrelated, so these edges exist
  // to be reviewed, not trusted — every consumer of the graph can filter
  // on `confidence === 'inferred'`.
  for (const decl of typeDeclarations) {
    const schemaNode = index.schemaByName.get(decl.name.toLowerCase());
    if (!schemaNode) continue;
    addEdge(decl.id, schemaNode, 'api_implements', 'inferred', 'name match');
  }

  return { edges, counts };
}
