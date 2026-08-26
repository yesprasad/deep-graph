import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import type { DependencyGraph, GraphEdge, GraphNode } from '../types/graph';
import type { JavaProjectState } from './index';

interface Position { line: number; character: number; }
interface Range { start: Position; end: Position; }
interface Location { uri: string; range: Range; }
interface CallHierarchyItem { name: string; uri: string; range: Range; selectionRange: Range; }
interface IncomingCall { from: CallHierarchyItem; fromRanges: Range[]; }
interface Diagnostic {
  range: Range;
  severity?: number;
  message: string;
}
interface PublishDiagnosticsParams { uri: string; diagnostics: Diagnostic[]; }

export interface JavaSemanticOptions {
  mode?: 'off' | 'auto' | 'required';
  jdtlsPath?: string;
  javaPath?: string;
  workspacePath?: string;
  timeoutMs?: number;
}

/**
 * Enrich a structural Java graph with JDT LS answers. JDT LS is the semantic
 * authority; all returned relationships retain precise source evidence.
 */
export async function enrichJavaGraphWithJdtls(
  graph: DependencyGraph,
  state: JavaProjectState,
  options: JavaSemanticOptions = {}
): Promise<DependencyGraph> {
  const mode = options.mode ?? 'auto';
  if (mode === 'off') return graph;
  const jdtlsPath = resolveJdtlsPath(options.jdtlsPath);
  const javaPath = options.javaPath
    ?? process.env.DEEP_GRAPH_JAVA_PATH
    ?? (process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java') : 'java');
  if (!jdtlsPath) return withUnavailable(graph, 'JDT LS not found. Set DEEP_GRAPH_JDTLS_PATH or use --semantic off.');

  // Eclipse cannot import a project when its own workspace metadata lives
  // inside that project. Keep JDT LS state outside the repository.
  const workspacePath = options.workspacePath ?? path.join(
    os.tmpdir(), 'deepgraph-jdtls', workspaceKey(state.projectRoot)
  );
  fs.mkdirSync(workspacePath, { recursive: true });
  const client = new JdtlsClient({ javaPath, jdtlsPath, workspacePath, timeoutMs: options.timeoutMs ?? 60_000 });

  try {
    await client.start(state.projectRoot);
    for (const sourceFile of state.sourceFiles) client.didOpen(sourceFile.fileName, sourceFile.text);

    const nodesByFile = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) {
      const list = nodesByFile.get(node.source.file) ?? [];
      list.push(node); nodesByFile.set(node.source.file, list);
    }
    const semanticNodes = graph.nodes.filter(node => ['class', 'interface', 'record', 'enum', 'annotation', 'method'].includes(node.type));
    const semanticEdges: GraphEdge[] = [];
    let references = 0; let implementations = 0; let calls = 0;

    for (const target of semanticNodes) {
      if (!target.source.line) continue;
      const uri = pathToFileURL(path.resolve(state.projectRoot, target.source.file)).toString();
      const position = { line: target.source.line - 1, character: Math.max(0, (target.source.column ?? 1) - 1) };

      const locations = await client.request<Location[] | null>('textDocument/references', {
        textDocument: { uri }, position, context: { includeDeclaration: false },
      });
      for (const location of locations ?? []) {
        const sourceNode = nodeAtLocation(graph, state.projectRoot, location, nodesByFile, true);
        if (!sourceNode || sourceNode.id === target.id) continue;
        semanticEdges.push(evidenceEdge(sourceNode.id, target.id, 'type_reference', target.name, 'reference', state.projectRoot, location));
        references++;
      }

      if (target.type === 'class' || target.type === 'interface' || target.type === 'method') {
        const locations = await client.request<Location[] | null>('textDocument/implementation', { textDocument: { uri }, position });
        for (const location of locations ?? []) {
          const implementation = nodeAtLocation(graph, state.projectRoot, location, nodesByFile, false);
          if (!implementation || implementation.id === target.id) continue;
          const edgeType = target.type === 'method' ? 'overrides' : 'implements';
          semanticEdges.push(evidenceEdge(implementation.id, target.id, edgeType, target.name, 'implementation', state.projectRoot, location));
          implementations++;
        }
      }

      if (target.type === 'method') {
        const items = await client.request<CallHierarchyItem[] | null>('textDocument/prepareCallHierarchy', { textDocument: { uri }, position });
        for (const item of items ?? []) {
          const incoming = await client.request<IncomingCall[] | null>('callHierarchy/incomingCalls', { item });
          for (const relation of incoming ?? []) {
            const caller = nodeAtLocation(graph, state.projectRoot, { uri: relation.from.uri, range: relation.from.selectionRange }, nodesByFile, false);
            if (!caller || caller.id === target.id) continue;
            const range = relation.fromRanges[0] ?? relation.from.selectionRange;
            semanticEdges.push(evidenceEdge(caller.id, target.id, 'call', target.name, 'incoming_call', state.projectRoot, { uri: relation.from.uri, range }));
            calls++;
          }
        }
      }
    }

    graph.edges = dedupeEdges([...graph.edges, ...semanticEdges]);
    graph.metadata.edgeCount = graph.edges.length;
    graph.metadata.semantic = {
      provider: 'jdtls', status: client.diagnostics.length > 0 ? 'partial' : 'available',
      references, implementations, calls, diagnostics: client.diagnostics.length,
      diagnosticSamples: client.diagnostics.slice(0, 20).map(diagnostic => ({
        file: graphRelativeFile(state.projectRoot, diagnostic.uri),
        line: diagnostic.diagnostic.range.start.line + 1,
        severity: diagnosticSeverity(diagnostic.diagnostic.severity),
        message: diagnostic.diagnostic.message,
      })),
    };
    return graph;
  } catch (error) {
    if (mode === 'required') throw error;
    return withUnavailable(graph, error instanceof Error ? error.message : 'JDT LS semantic analysis failed.');
  } finally {
    await client.stop();
  }
}

function resolveJdtlsPath(explicit?: string): string | undefined {
  const candidate = explicit ?? process.env.DEEP_GRAPH_JDTLS_PATH;
  if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  return undefined;
}
function workspaceKey(projectRoot: string): string { return Buffer.from(path.resolve(projectRoot)).toString('base64url').slice(0, 32); }
function withUnavailable(graph: DependencyGraph, message: string): DependencyGraph {
  graph.metadata.semantic = { provider: 'jdtls', status: 'unavailable', references: 0, implementations: 0, calls: 0, diagnostics: 0, message };
  return graph;
}
function evidenceEdge(from: string, to: string, type: GraphEdge['type'], via: string, kind: 'reference' | 'implementation' | 'incoming_call', root: string, location: Location): GraphEdge {
  const file = graphRelativeFile(root, location.uri);
  return { from, to, type, via, evidence: { provider: 'jdtls', kind, file, line: location.range.start.line + 1 } };
}
function graphRelativeFile(root: string, uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  return path.relative(root, fileURLToPath(uri)).replace(/\\/g, '/');
}
function diagnosticSeverity(severity: number | undefined): 'error' | 'warning' | 'information' | 'hint' | undefined {
  return severity === 1 ? 'error' : severity === 2 ? 'warning' : severity === 3 ? 'information' : severity === 4 ? 'hint' : undefined;
}
function nodeAtLocation(graph: DependencyGraph, root: string, location: Location, nodesByFile: Map<string, GraphNode[]>, preferMethod: boolean): GraphNode | undefined {
  const file = graphRelativeFile(root, location.uri); const line = location.range.start.line + 1;
  const candidates = (nodesByFile.get(file) ?? []).filter(node => node.source.line === line && node.type !== 'module');
  const method = candidates.find(node => node.type === 'method');
  if (preferMethod && method) return method;
  return method ?? candidates[0] ?? graph.nodes.find(node => node.type === 'module' && node.source.file === file);
}
function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => { const key = `${edge.from}|${edge.to}|${edge.type}|${edge.via ?? ''}|${edge.evidence?.kind ?? ''}|${edge.evidence?.file ?? ''}|${edge.evidence?.line ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

class JdtlsClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (reason: Error) => void }>();
  readonly diagnostics: Array<{ uri: string; diagnostic: Diagnostic }> = [];

  constructor(private readonly options: { javaPath: string; jdtlsPath: string; workspacePath: string; timeoutMs: number }) {}

  async start(root: string): Promise<void> {
    const launcher = fs.readdirSync(path.join(this.options.jdtlsPath, 'plugins')).find(name => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name));
    if (!launcher) throw new Error(`JDT LS launcher not found in ${this.options.jdtlsPath}.`);
    const config = process.platform === 'darwin' ? 'config_mac' : process.platform === 'win32' ? 'config_win' : 'config_linux';
    const args = [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Dlog.level=ERROR', '-Xmx1G', '--add-modules=ALL-SYSTEM',
      '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
      '-jar', path.join(this.options.jdtlsPath, 'plugins', launcher), '-configuration', path.join(this.options.jdtlsPath, config), '-data', this.options.workspacePath,
    ];
    this.process = spawn(this.options.javaPath, args, { cwd: root, stdio: 'pipe' });
    this.process.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.stderr.on('data', () => undefined);
    this.process.on('error', error => this.rejectPending(error));
    this.process.on('exit', code => { if (code && code !== 0) this.rejectPending(new Error(`JDT LS exited with code ${code}.`)); });
    const initialized = await this.request<any>('initialize', {
      processId: null, rootUri: pathToFileURL(root).toString(), workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: path.basename(root) }],
      capabilities: { workspace: { workspaceFolders: true, symbol: { dynamicRegistration: false } }, textDocument: { references: { dynamicRegistration: false }, implementation: { dynamicRegistration: false }, callHierarchy: { dynamicRegistration: false }, publishDiagnostics: { relatedInformation: true } } },
    });
    if (!initialized?.capabilities) throw new Error('JDT LS did not return server capabilities.');
    this.notify('initialized', {});
    // JDT LS imports Maven/Gradle projects asynchronously after `initialized`.
    // Waiting for its ServiceReady notification prevents valid source files from
    // being analysed as isolated "non-project" documents.
    this.notify('workspace/didChangeConfiguration', {
      settings: { java: { import: { maven: { enabled: true }, gradle: { enabled: true } } } },
    });
    await this.waitForServiceReady();
  }
  didOpen(file: string, text: string): void { this.notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(file).toString(), languageId: 'java', version: 1, text } }); }
  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const task = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send({ jsonrpc: '2.0', id, method, params });
    return withTimeout(task, this.options.timeoutMs, `JDT LS timed out resolving ${method}.`);
  }
  notify(method: string, params: unknown): void { this.send({ jsonrpc: '2.0', method, params }); }
  async stop(): Promise<void> {
    if (!this.process || this.process.killed) return;
    try { await this.request('shutdown', null); this.notify('exit', null); } catch { this.process.kill(); }
  }
  private async waitForServiceReady(): Promise<void> {
    if (this.serviceReady) return;
    await Promise.race([
      new Promise<void>(resolve => { this.resolveServiceReady = resolve; }),
      new Promise<void>(resolve => setTimeout(resolve, 15_000)),
    ]);
  }
  private send(value: unknown): void { const body = Buffer.from(JSON.stringify(value), 'utf8'); this.process?.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); this.process?.stdin.write(body); }
  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const boundary = this.buffer.indexOf('\r\n\r\n'); if (boundary === -1) return;
      const header = this.buffer.slice(0, boundary).toString('utf8'); const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) { this.buffer = Buffer.alloc(0); return; }
      const size = Number(match[1]); const start = boundary + 4; if (this.buffer.length < start + size) return;
      const message = JSON.parse(this.buffer.slice(start, start + size).toString('utf8')); this.buffer = this.buffer.slice(start + size);
      if (message.id !== undefined && this.pending.has(message.id)) { const pending = this.pending.get(message.id)!; this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result); }
      else if (message.method === 'language/status' && message.params?.type === 'ServiceReady') {
        this.serviceReady = true;
        this.resolveServiceReady?.();
      } else if (message.method === 'textDocument/publishDiagnostics') {
        const params = message.params as PublishDiagnosticsParams;
        this.diagnostics.push(...(params.diagnostics ?? []).map(diagnostic => ({ uri: params.uri, diagnostic })));
      }
    }
  }
  private rejectPending(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
  private serviceReady = false;
  private resolveServiceReady: (() => void) | undefined;
}
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> { return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))]); }
