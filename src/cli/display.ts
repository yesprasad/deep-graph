import chalk from 'chalk';
import Table from 'cli-table3';
import type { DependencyGraph } from '../types/graph';

export function displayGraph(graph: DependencyGraph): void {
  console.log(chalk.yellow.bold('\n📊 DEPENDENCY MAP'));
  console.log(chalk.gray('═'.repeat(80)));

  // ── Section 1: Module Graph ──
  const modules = graph.nodes.filter(n => n.type === 'module');
  if (modules.length > 0) {
    console.log(chalk.cyan.bold('\n📦 MODULES'));

    const table = new Table({
      head: [
        chalk.cyan('File'),
        chalk.cyan('Exports'),
        chalk.cyan('Lines'),
      ],
      wordWrap: true,
      style: { head: [], border: ['gray'] },
    });

    modules
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(mod => {
        table.push([
          chalk.white(mod.name),
          chalk.cyan(mod.attributes.exportCount ?? 0),
          chalk.gray(mod.attributes.lineCount ?? '?'),
        ]);
      });

    console.log(table.toString());
  }

  // ── Section 2: Import Relationships ──
  const importEdges = graph.edges.filter(e => e.type === 'import');
  if (importEdges.length > 0) {
    console.log(chalk.cyan.bold('\n🔗 IMPORT GRAPH'));

    const table = new Table({
      head: [
        chalk.cyan('From'),
        chalk.cyan('To'),
        chalk.cyan('Specifier'),
      ],
      wordWrap: true,
      style: { head: [], border: ['gray'] },
    });

    importEdges.forEach(edge => {
      const fromName = edge.from.replace('module:', '');
      const toName = edge.to.replace('module:', '').replace('external:', '');
      const isExternal = edge.to.startsWith('external:');

      table.push([
        chalk.white(fromName),
        isExternal ? chalk.magenta(toName) : chalk.white(toName),
        chalk.gray(edge.via || ''),
      ]);
    });

    console.log(table.toString());
  }

  // ── Section 3: Symbols ──
  const symbols = graph.nodes.filter(n =>
    ['class', 'function', 'method', 'interface', 'type_alias', 'enum'].includes(n.type)
  );
  if (symbols.length > 0) {
    console.log(chalk.cyan.bold('\n⚙️  SYMBOLS'));

    const table = new Table({
      head: [
        chalk.cyan('Name'),
        chalk.cyan('Type'),
        chalk.cyan('File'),
        chalk.cyan('Exported'),
      ],
      wordWrap: true,
      style: { head: [], border: ['gray'] },
    });

    symbols
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
      .forEach(sym => {
        const typeIcon = sym.type === 'class' ? '🏗️'
          : sym.type === 'function' ? '⚡'
          : sym.type === 'method' ? '🔧'
          : sym.type === 'interface' ? '📐'
          : sym.type === 'type_alias' ? '🏷️'
          : sym.type === 'enum' ? '📋'
          : '';

        const displayName = sym.type === 'method' ? `${sym.attributes.className}.${sym.name}` : sym.name;

        table.push([
          chalk.white(displayName),
          `${typeIcon} ${chalk.gray(sym.type)}`,
          chalk.gray(sym.source.file),
          sym.attributes.exported ? chalk.green('yes') : chalk.gray('no'),
        ]);
      });

    console.log(table.toString());
  }

  // ── Section 3b: Call Graph ──
  const callEdges = graph.edges.filter(e => e.type === 'call');
  if (callEdges.length > 0) {
    console.log(chalk.cyan.bold('\n📞 CALL GRAPH'));

    const table = new Table({
      head: [
        chalk.cyan('Caller'),
        chalk.cyan('Callee'),
      ],
      wordWrap: true,
      style: { head: [], border: ['gray'] },
    });

    callEdges.forEach(edge => {
      const fromName = edge.from.split('::').pop() || edge.from;
      const toName = edge.to.split('::').pop() || edge.to;

      table.push([chalk.white(fromName), chalk.white(toName)]);
    });

    console.log(table.toString());
  }

  // ── Section 3c: Constructor Dependencies ──
  const depsEdges = graph.edges.filter(e => e.type === 'depends_on');
  if (depsEdges.length > 0) {
    console.log(chalk.cyan.bold('\n🔌 CONSTRUCTOR DEPENDENCIES'));

    const table = new Table({
      head: [
        chalk.cyan('Class'),
        chalk.cyan('Depends On'),
        chalk.cyan('Via Parameter'),
      ],
      wordWrap: true,
      style: { head: [], border: ['gray'] },
    });

    depsEdges.forEach(edge => {
      const fromName = edge.from.split('::').pop() || edge.from;
      const toName = edge.to.split('::').pop() || edge.to;

      table.push([
        chalk.white(fromName),
        chalk.white(toName),
        chalk.gray(edge.via || ''),
      ]);
    });

    console.log(table.toString());
  }

  // ── Section 4: Heritage (extends/implements) ──
  const heritageEdges = graph.edges.filter(
    e => e.type === 'extends' || e.type === 'implements'
  );
  if (heritageEdges.length > 0) {
    console.log(chalk.cyan.bold('\n🧬 INHERITANCE & IMPLEMENTATION'));

    const table = new Table({
      head: [
        chalk.cyan('Source'),
        chalk.cyan('Relationship'),
        chalk.cyan('Target'),
      ],
      wordWrap: true,
      style: { head: [], border: ['gray'] },
    });

    heritageEdges.forEach(edge => {
      const fromName = edge.from.split('::').pop() || edge.from;
      const toName = edge.to.split('::').pop() || edge.to;

      table.push([
        chalk.white(fromName),
        edge.type === 'extends' ? chalk.yellow('extends') : chalk.blue('implements'),
        chalk.white(toName),
      ]);
    });

    console.log(table.toString());
  }

  // ── Section 5: External Dependencies ──
  const externals = graph.nodes.filter(n => n.type === 'external_package');
  if (externals.length > 0) {
    console.log(chalk.cyan.bold('\n📦 EXTERNAL PACKAGES'));
    externals
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(ext => {
        const importCount = graph.edges.filter(
          e => e.to === ext.id && e.type === 'import'
        ).length;
        console.log(
          chalk.gray(' • ') +
          chalk.magenta(ext.name) +
          chalk.gray(` (imported by ${importCount} module${importCount === 1 ? '' : 's'})`)
        );
      });
  }

  // ── Section 6: Summary ──
  console.log(chalk.cyan.bold('\n🧠 PROJECT INSIGHTS'));
  console.log(` • Modules:            ${chalk.cyan(graph.metadata.moduleCount)}`);
  console.log(` • Symbols:            ${chalk.cyan(graph.metadata.symbolCount)}`);
  console.log(` • External Packages:  ${chalk.magenta(graph.metadata.externalPackages)}`);
  console.log(` • Total Nodes:        ${chalk.cyan(graph.metadata.nodeCount)}`);
  console.log(` • Total Edges:        ${chalk.cyan(graph.metadata.edgeCount)}`);
  console.log(` • TypeScript:         ${chalk.gray(graph.metadata.tsVersion)}`);
  console.log(chalk.gray('═'.repeat(80)) + '\n');
}
