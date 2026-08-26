import type { GraphNode, GraphEdge } from '../types/graph';

/**
 * OPENAPI CONTRACT DIFF
 *
 * Compares two extracted API graphs and classifies what moved. The
 * classification that matters is breaking vs non-breaking, judged from
 * the consumer's side:
 *
 *   removing a response field  breaks readers      (breaking)
 *   adding a response field    breaks nobody       (safe)
 *   adding a required request field  breaks callers (breaking)
 *   relaxing required -> optional on a request      (safe)
 *
 * Required-ness cuts in opposite directions depending on whether a field
 * is sent or received, which is why request and response schemas are
 * classified separately rather than by a single rule.
 */

export type ChangeKind =
  | 'operation_removed'
  | 'operation_added'
  | 'schema_removed'
  | 'schema_added'
  | 'property_removed'
  | 'property_added'
  | 'property_type_changed'
  | 'property_required_added'
  | 'property_required_removed'
  | 'property_deprecated';

export interface ApiChange {
  kind: ChangeKind;
  breaking: boolean;
  /** Node id in whichever graph the subject exists in. */
  nodeId: string;
  /** Display name — "LoginSuccess.auth", "POST /login". */
  name: string;
  detail: string;
  /** Whether the subject appears in requests, responses, or both. */
  direction: 'request' | 'response' | 'both' | 'unknown';
}

export interface ApiDiff {
  changes: ApiChange[];
  breakingCount: number;
  safeCount: number;
}

interface Indexed {
  operations: Map<string, GraphNode>;
  schemas: Map<string, GraphNode>;
  properties: Map<string, GraphNode>;
  /** schema name -> how the schema is used across operations */
  schemaDirection: Map<string, 'request' | 'response' | 'both'>;
}

/**
 * Index by display name rather than node id: ids embed a service slug,
 * and a renamed `info.title` should not read as "every operation removed".
 */
function indexGraph(nodes: GraphNode[], edges: GraphEdge[]): Indexed {
  const operations = new Map<string, GraphNode>();
  const schemas = new Map<string, GraphNode>();
  const properties = new Map<string, GraphNode>();

  for (const node of nodes) {
    if (node.type === 'api_operation') operations.set(node.name, node);
    else if (node.type === 'api_schema') schemas.set(node.name, node);
    else if (node.type === 'api_property') properties.set(node.name, node);
  }

  // Which side of the wire each schema sits on. A schema reachable from a
  // request body is written by callers; one reachable from a response is
  // read by them. Shared schemas are both, and are judged by the stricter
  // rule in each direction.
  const byId = new Map(nodes.map(n => [n.id, n]));
  const direction = new Map<string, 'request' | 'response' | 'both'>();

  const mark = (schemaNodeId: string, dir: 'request' | 'response'): void => {
    const node = byId.get(schemaNodeId);
    if (!node || node.type !== 'api_schema') return;
    const current = direction.get(node.name);
    direction.set(node.name, !current ? dir : current === dir ? dir : 'both');
  };

  for (const edge of edges) {
    if (edge.type === 'api_request' || edge.type === 'api_parameter') {
      mark(edge.to, 'request');
    } else if (edge.type === 'api_response') {
      mark(edge.to, 'response');
    }
  }

  // Propagate through `$ref` edges: a schema referenced only by a
  // response schema is itself response-side.
  const refEdges = edges.filter(e => e.type === 'api_ref');
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const edge of refEdges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to || to.type !== 'api_schema') continue;

      // The source may be a schema or a property; resolve a property back
      // to its owning schema name.
      const fromSchema =
        from.type === 'api_schema'
          ? from.name
          : typeof from.attributes.schema === 'string'
            ? from.attributes.schema
            : null;
      if (!fromSchema) continue;

      const inherited = direction.get(fromSchema);
      if (!inherited) continue;

      const current = direction.get(to.name);
      const next = !current ? inherited : current === inherited ? current : 'both';
      if (next !== current) {
        direction.set(to.name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return { operations, schemas, properties, schemaDirection: direction };
}

function directionOf(indexed: Indexed, schemaName: unknown): ApiChange['direction'] {
  if (typeof schemaName !== 'string') return 'unknown';
  return indexed.schemaDirection.get(schemaName) ?? 'unknown';
}

/**
 * Is removing this field a breaking change?
 *
 * Response side: yes — a consumer reading it now gets undefined.
 * Request side: no — the server simply stops requiring it.
 * Unknown: treated as breaking, because an unclassified field is more
 * likely unreachable-by-analysis than genuinely unused.
 */
function removalBreaks(direction: ApiChange['direction']): boolean {
  return direction !== 'request';
}

/**
 * Is adding this field a breaking change?
 *
 * Only when it is required and callers must send it.
 */
function additionBreaks(
  direction: ApiChange['direction'],
  required: boolean
): boolean {
  return required && (direction === 'request' || direction === 'both');
}

export function diffApiGraphs(
  before: { nodes: GraphNode[]; edges: GraphEdge[] },
  after: { nodes: GraphNode[]; edges: GraphEdge[] }
): ApiDiff {
  const oldIndex = indexGraph(before.nodes, before.edges);
  const newIndex = indexGraph(after.nodes, after.edges);
  const changes: ApiChange[] = [];

  // ── Operations ────────────────────────────────────────
  for (const [name, node] of oldIndex.operations) {
    if (!newIndex.operations.has(name)) {
      changes.push({
        kind: 'operation_removed',
        breaking: true,
        nodeId: node.id,
        name,
        detail: 'Endpoint no longer declared — callers will 404.',
        direction: 'both',
      });
    }
  }
  for (const [name, node] of newIndex.operations) {
    if (!oldIndex.operations.has(name)) {
      changes.push({
        kind: 'operation_added',
        breaking: false,
        nodeId: node.id,
        name,
        detail: 'New endpoint.',
        direction: 'both',
      });
    }
  }

  // ── Schemas ───────────────────────────────────────────
  for (const [name, node] of oldIndex.schemas) {
    if (!newIndex.schemas.has(name)) {
      const direction = directionOf(oldIndex, name);
      changes.push({
        kind: 'schema_removed',
        breaking: removalBreaks(direction),
        nodeId: node.id,
        name,
        detail: 'Schema no longer declared.',
        direction,
      });
    }
  }
  for (const [name, node] of newIndex.schemas) {
    if (!oldIndex.schemas.has(name)) {
      changes.push({
        kind: 'schema_added',
        breaking: false,
        nodeId: node.id,
        name,
        detail: 'New schema.',
        direction: directionOf(newIndex, name),
      });
    }
  }

  // ── Properties — the field-level surface ──────────────
  for (const [name, node] of oldIndex.properties) {
    const owner = node.attributes.schema;

    // A field vanishing because its whole schema went is already
    // reported once at the schema level; do not repeat it per field.
    if (typeof owner === 'string' && !newIndex.schemas.has(owner)) continue;

    const next = newIndex.properties.get(name);
    const direction = directionOf(oldIndex, owner);

    if (!next) {
      changes.push({
        kind: 'property_removed',
        breaking: removalBreaks(direction),
        nodeId: node.id,
        name,
        detail:
          direction === 'request'
            ? 'Request field removed — callers sending it are unaffected.'
            : 'Response field removed — consumers reading it break.',
        direction,
      });
      continue;
    }

    const oldType = String(node.attributes.dataType ?? '');
    const newType = String(next.attributes.dataType ?? '');
    if (oldType !== newType) {
      changes.push({
        kind: 'property_type_changed',
        breaking: true,
        nodeId: next.id,
        name,
        detail: `Type changed: ${oldType} → ${newType}`,
        direction,
      });
    }

    const wasRequired = node.attributes.required === true;
    const isRequired = next.attributes.required === true;

    if (!wasRequired && isRequired) {
      changes.push({
        kind: 'property_required_added',
        breaking: direction === 'request' || direction === 'both',
        nodeId: next.id,
        name,
        detail:
          direction === 'request' || direction === 'both'
            ? 'Now required — callers omitting it will be rejected.'
            : 'Now required in a response — callers are unaffected.',
        direction,
      });
    } else if (wasRequired && !isRequired) {
      changes.push({
        kind: 'property_required_removed',
        breaking: direction === 'response' || direction === 'both',
        nodeId: next.id,
        name,
        detail:
          direction === 'response' || direction === 'both'
            ? 'No longer guaranteed in the response — consumers must handle absence.'
            : 'No longer required from callers.',
        direction,
      });
    }

    if (next.attributes.deprecated === true && node.attributes.deprecated !== true) {
      changes.push({
        kind: 'property_deprecated',
        breaking: false,
        nodeId: next.id,
        name,
        detail: 'Marked deprecated.',
        direction,
      });
    }
  }

  for (const [name, node] of newIndex.properties) {
    if (oldIndex.properties.has(name)) continue;

    const owner = node.attributes.schema;
    if (typeof owner === 'string' && !oldIndex.schemas.has(owner)) continue;

    const direction = directionOf(newIndex, owner);
    const required = node.attributes.required === true;

    changes.push({
      kind: 'property_added',
      breaking: additionBreaks(direction, required),
      nodeId: node.id,
      name,
      detail: required
        ? 'New required field.'
        : 'New optional field.',
      direction,
    });
  }

  const breakingCount = changes.filter(c => c.breaking).length;

  return {
    changes,
    breakingCount,
    safeCount: changes.length - breakingCount,
  };
}
