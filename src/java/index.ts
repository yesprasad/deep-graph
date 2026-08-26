import fs from 'fs';
import path from 'path';
import type { DependencyGraph, GraphEdge, GraphMetadata, GraphNode, NodeType } from '../types/graph';
import { graphPath } from '../extractor/ids';

export interface JavaSourceFile {
  fileName: string;
  text: string;
}

export interface JavaProjectState {
  projectRoot: string;
  sourceFiles: JavaSourceFile[];
  buildSystem: 'maven' | 'gradle' | 'unknown';
}

interface JavaType {
  id: string;
  name: string;
  qualifiedName: string;
  type: NodeType;
  source: GraphNode['source'];
  attributes: Record<string, unknown>;
  moduleId: string;
  extendsNames: string[];
  implementsNames: string[];
  headerTypeReferences: string[];
  bodyStart: number;
  bodyEnd: number;
  text: string;
}

const IGNORED_DIRECTORIES = new Set([
  '.git', '.gradle', '.idea', '.deepgraph', 'build', 'target', 'node_modules', 'out', 'vendor',
]);

/**
 * Load Java source without executing Maven or Gradle. The resulting structural
 * graph can optionally be enriched by the JDT LS provider in `jdtls.ts`.
 */
export function loadJavaProject(targetDir: string): JavaProjectState {
  const projectRoot = path.resolve(targetDir);
  const sourceFiles: JavaSourceFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.java')) {
        sourceFiles.push({ fileName: absolute, text: fs.readFileSync(absolute, 'utf8') });
      }
    }
  };

  walk(projectRoot);
  if (sourceFiles.length === 0) {
    throw new Error(`No Java source files found in ${projectRoot}.`);
  }

  return {
    projectRoot,
    sourceFiles,
    buildSystem: fs.existsSync(path.join(projectRoot, 'pom.xml')) ? 'maven'
      : (fs.existsSync(path.join(projectRoot, 'build.gradle')) || fs.existsSync(path.join(projectRoot, 'build.gradle.kts')) || fs.existsSync(path.join(projectRoot, 'settings.gradle')) || fs.existsSync(path.join(projectRoot, 'settings.gradle.kts'))) ? 'gradle'
      : 'unknown',
  };
}

/** Build an explainable, structural Java graph. */
export function extractJavaGraph(state: JavaProjectState): DependencyGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const types: JavaType[] = [];
  const importsByFile = new Map<string, string[]>();

  for (const sourceFile of state.sourceFiles) {
    const relative = graphPath(sourceFile.fileName, state.projectRoot);
    const moduleId = javaModuleId(relative);
    nodes.push({
      id: moduleId,
      type: 'module',
      name: relative,
      attributes: { language: 'java', lineCount: lineCount(sourceFile.text) },
      source: { file: relative },
    });

    const sanitized = sanitize(sourceFile.text);
    const packageName = readPackage(sanitized);
    const imports = readImports(sanitized);
    importsByFile.set(moduleId, imports.map(value => value.name));

    for (const declaration of findTypeDeclarations(sanitized)) {
      const typeName = declaration.name;
      const type = toNodeType(declaration.kind);
      const qualifiedName = packageName ? `${packageName}.${typeName}` : typeName;
      const id = javaSymbolId(relative, qualifiedName);
      const source = sourceLocation(sourceFile.text, declaration.start, relative);
      const bodyEnd = findMatchingBrace(sanitized, declaration.bodyStart);
      const body = bodyEnd === -1 ? '' : sanitized.slice(declaration.bodyStart + 1, bodyEnd);
      const info: JavaType = {
        id, name: typeName, qualifiedName, type, source,
        attributes: {
          language: 'java', package: packageName || undefined, public: declaration.modifiers.includes('public'),
          abstract: declaration.modifiers.includes('abstract'), final: declaration.modifiers.includes('final'),
          annotations: declaration.annotations,
        },
        moduleId, extendsNames: declaration.extendsNames, implementsNames: declaration.implementsNames,
        headerTypeReferences: declaration.headerTypeReferences,
        bodyStart: declaration.bodyStart, bodyEnd, text: body,
      };
      types.push(info);
      nodes.push({ id, type, name: typeName, qualifiedName, attributes: info.attributes, source });
      edges.push({ from: moduleId, to: id, type: 'composition' });
    }
  }

  const byQualifiedName = new Map(types.map(type => [type.qualifiedName, type]));
  const bySimpleName = new Map<string, JavaType[]>();
  for (const type of types) bySimpleName.set(type.name, [...(bySimpleName.get(type.name) ?? []), type]);

  const resolveType = (name: string, moduleId: string): JavaType | undefined => {
    const clean = name.replace(/<.*>/g, '').replace(/\[\]/g, '').trim();
    if (byQualifiedName.has(clean)) return byQualifiedName.get(clean);
    const imported = importsByFile.get(moduleId) ?? [];
    for (const value of imported) {
      if (value.endsWith(`.${clean}`) && byQualifiedName.has(value)) return byQualifiedName.get(value);
      if (value.endsWith('.*')) {
        const candidate = `${value.slice(0, -2)}.${clean}`;
        if (byQualifiedName.has(candidate)) return byQualifiedName.get(candidate);
      }
    }
    const candidates = bySimpleName.get(clean) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  for (const type of types) {
    for (const imported of importsByFile.get(type.moduleId) ?? []) {
      const target = imported.endsWith('.*') ? undefined : byQualifiedName.get(imported);
      if (target) edges.push({ from: type.moduleId, to: target.moduleId, type: 'import', via: imported });
    }
    for (const parent of type.extendsNames) {
      const target = resolveType(parent, type.moduleId);
      if (target) edges.push({ from: type.id, to: target.id, type: 'extends', via: parent });
    }
    for (const contract of type.implementsNames) {
      const target = resolveType(contract, type.moduleId);
      if (target) edges.push({ from: type.id, to: target.id, type: 'implements', via: contract });
    }
    for (const reference of type.headerTypeReferences) {
      const target = resolveType(reference, type.moduleId);
      if (target) edges.push({ from: type.id, to: target.id, type: 'type_reference', via: reference });
    }
    for (const method of findMethods(type.text, type.name, type.bodyStart + 1)) {
      const methodId = javaMethodId(type.id, method.name, method.signature);
      const source = sourceLocation(state.sourceFiles.find(file => javaModuleId(graphPath(file.fileName, state.projectRoot)) === type.moduleId)!.text, method.start, type.source.file);
      nodes.push({
        id: methodId, type: 'method', name: method.name,
        qualifiedName: `${type.qualifiedName}.${method.signature}`,
        attributes: { language: 'java', className: type.name, parameterCount: method.parameterCount, constructor: method.name === type.name, annotations: method.annotations },
        source,
      });
      edges.push({ from: type.id, to: methodId, type: 'composition' });
      for (const reference of method.typeReferences) {
        const target = resolveType(reference, type.moduleId);
        if (target) edges.push({ from: methodId, to: target.id, type: 'type_reference', via: reference });
      }
    }
  }

  const uniqueEdges = dedupeEdges(edges);
  const metadata: GraphMetadata = {
    projectRoot: state.projectRoot, language: 'java', tsVersion: '',
    nodeCount: nodes.length, edgeCount: uniqueEdges.length,
    moduleCount: state.sourceFiles.length, symbolCount: nodes.filter(node => node.type !== 'module').length,
    externalPackages: 0, generatedAt: new Date().toISOString(),
  };
  return { metadata, nodes, edges: uniqueEdges };
}

function javaModuleId(relative: string): string { return `module:${relative}`; }
function javaSymbolId(relative: string, qualifiedName: string): string { return `symbol:${relative}::${qualifiedName}`; }
function javaMethodId(typeId: string, name: string, signature: string): string { return `${typeId}.${name}(${signature})`; }
function lineCount(text: string): number { return text.split(/\r?\n/).length; }
function sourceLocation(text: string, offset: number, file: string): GraphNode['source'] {
  const before = text.slice(0, offset); const lines = before.split(/\r?\n/);
  return { file, line: lines.length, column: lines[lines.length - 1].length + 1 };
}
function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter(edge => { const key = `${edge.from}|${edge.to}|${edge.type}|${edge.via ?? ''}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

function sanitize(text: string): string {
  let output = ''; let index = 0; let mode: 'code' | 'line' | 'block' | 'string' | 'char' | 'text' = 'code';
  const blank = (value: string) => value.replace(/[^\r\n]/g, ' ');
  while (index < text.length) {
    const current = text[index]; const next = text[index + 1];
    if (mode === 'code') {
      if (current === '/' && next === '/') { output += '  '; index += 2; mode = 'line'; continue; }
      if (current === '/' && next === '*') { output += '  '; index += 2; mode = 'block'; continue; }
      if (text.slice(index, index + 3) === '\"\"\"') { output += '   '; index += 3; mode = 'text'; continue; }
      if (current === '\"') { output += ' '; index++; mode = 'string'; continue; }
      if (current === "'") { output += ' '; index++; mode = 'char'; continue; }
      output += current; index++; continue;
    }
    if (mode === 'line') { output += current === '\n' || current === '\r' ? current : ' '; if (current === '\n') mode = 'code'; index++; continue; }
    if (mode === 'block') { if (current === '*' && next === '/') { output += '  '; index += 2; mode = 'code'; } else { output += current === '\n' || current === '\r' ? current : ' '; index++; } continue; }
    if (mode === 'text') { if (text.slice(index, index + 3) === '\"\"\"') { output += '   '; index += 3; mode = 'code'; } else { output += current === '\n' || current === '\r' ? current : ' '; index++; } continue; }
    if (current === '\\') { output += blank(text.slice(index, index + 2)); index += 2; continue; }
    output += current === '\n' || current === '\r' ? current : ' ';
    if ((mode === 'string' && current === '\"') || (mode === 'char' && current === "'")) mode = 'code';
    index++;
  }
  return output;
}

function readPackage(text: string): string | undefined { return text.match(/^\s*package\s+([\w.]+)\s*;/m)?.[1]; }
function readImports(text: string): Array<{ name: string; static: boolean }> {
  return Array.from(text.matchAll(/^\s*import\s+(static\s+)?([\w.]+(?:\.\*)?)\s*;/gm)).map(match => ({ name: match[2], static: Boolean(match[1]) }));
}
function toNodeType(kind: string): NodeType { return kind === 'interface' ? 'interface' : kind === 'enum' ? 'enum' : kind === 'record' ? 'record' : kind === '@interface' ? 'annotation' : 'class'; }
function splitNames(value: string | undefined): string[] { return value ? value.split(',').map(name => name.trim().replace(/<.*>/g, '')).filter(Boolean) : []; }

function findTypeDeclarations(text: string): Array<{ kind: string; name: string; start: number; bodyStart: number; modifiers: string[]; annotations: string[]; extendsNames: string[]; implementsNames: string[]; headerTypeReferences: string[] }> {
  const expression = /(?:^|\n)\s*((?:@[\w.]+(?:\s*\([^\n]*?\))?\s*)*)((?:(?:public|protected|private|abstract|final|static|sealed|non-sealed)\s+)*)((?:class|interface|enum|record|@interface))\s+(\w+)([^\{]*)\{/g;
  const results = [];
  for (const match of text.matchAll(expression)) {
    const tail = match[5] ?? ''; const extendsPart = tail.match(/\bextends\s+([^\b\{]+?)(?=\bimplements\b|$)/)?.[1];
    const implementsPart = tail.match(/\bimplements\s+([^\{]+)/)?.[1];
    const start = (match.index ?? 0) + match[0].lastIndexOf(match[3]);
    const recordParameters = match[3] === 'record' ? tail.match(/\(([^)]*)\)/)?.[1] : undefined;
    const headerTypeReferences = recordParameters
      ? recordParameters.split(',').map(parameter => parameter.trim().replace(/@[\w.]+\s*/g, '').split(/\s+/)[0]).filter(value => value && !isJavaBuiltin(value))
      : [];
    results.push({ kind: match[3], name: match[4], start, bodyStart: (match.index ?? 0) + match[0].lastIndexOf('{'), modifiers: match[2].trim().split(/\s+/).filter(Boolean), annotations: Array.from(match[1].matchAll(/@([\w.]+)/g)).map(value => value[1]), extendsNames: splitNames(extendsPart), implementsNames: splitNames(implementsPart), headerTypeReferences });
  }
  return results;
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index++) { if (text[index] === '{') depth++; else if (text[index] === '}' && --depth === 0) return index; }
  return -1;
}

function findMethods(text: string, owner: string, offset: number): Array<{ name: string; signature: string; start: number; parameterCount: number; annotations: string[]; typeReferences: string[] }> {
  const expression = /(?:^|\n)\s*((?:@[\w.]+(?:\s*\([^\n]*?\))?\s*)*)(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>{}]+>\s+)?([\w.$<>\[\]?]+\s+)?(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\s*(?:\{|;)/g;
  const ignored = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new']); const results = [];
  for (const match of text.matchAll(expression)) {
    const name = match[3]; if (ignored.has(name)) continue;
    const parameters = match[4].trim(); const parameterTypes = parameters ? parameters.split(',').map(parameter => parameter.trim().replace(/@[\w.]+\s*/g, '').split(/\s+/)[0]).filter(Boolean) : [];
    const returnType = (match[2] ?? '').trim();
    // A no-return-type declaration is only a method when it is the constructor.
    if (!returnType && name !== owner) continue;
    const signature = `${name}(${parameterTypes.join(',')})`;
    const annotations = Array.from(match[1].matchAll(/@([\w.]+)/g)).map(value => value[1]);
    results.push({ name, signature, start: offset + (match.index ?? 0) + match[0].lastIndexOf(name), parameterCount: parameterTypes.length, annotations, typeReferences: [returnType, ...parameterTypes].filter(value => value && !isJavaBuiltin(value)) });
  }
  return results;
}
function isJavaBuiltin(value: string): boolean { return /^(void|boolean|byte|short|int|long|float|double|char|String|Object|Integer|Long|Boolean|Double|Float|List|Set|Map|Optional|Stream)$/.test(value.replace(/<.*>/g, '')); }
