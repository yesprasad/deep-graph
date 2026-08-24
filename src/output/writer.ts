import fs from 'fs';
import path from 'path';
import type { DependencyGraph } from '../types/graph';

export function writeGraph(graph: DependencyGraph, outputPath: string): void {
  const formatted = JSON.stringify(graph, null, 2);

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, formatted, 'utf-8');
}
