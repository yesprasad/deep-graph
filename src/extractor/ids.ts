import path from 'path';

/** Normalize graph paths so graph IDs and CLI input are portable across OSes. */
export function graphPath(filePath: string, projectRoot?: string): string {
  const value = projectRoot ? path.relative(projectRoot, filePath) : filePath;
  return value.replace(/\\/g, '/');
}

/** Create a stable ID for a source file */
export function moduleId(filePath: string, projectRoot: string): string {
  const relative = graphPath(filePath, projectRoot);
  return `module:${relative}`;
}

/** Create a stable ID for a top-level declaration */
export function symbolId(filePath: string, name: string, projectRoot: string): string {
  const relative = graphPath(filePath, projectRoot);
  return `symbol:${relative}::${name}`;
}

/** Create a stable ID for a method scoped to its declaring class */
export function methodId(
  filePath: string,
  className: string,
  methodName: string,
  projectRoot: string
): string {
  return symbolId(filePath, `${className}.${methodName}`, projectRoot);
}
