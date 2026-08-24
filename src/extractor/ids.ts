import path from 'path';

/** Create a stable ID for a source file */
export function moduleId(filePath: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, filePath);
  return `module:${relative}`;
}

/** Create a stable ID for a top-level declaration */
export function symbolId(filePath: string, name: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, filePath);
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
