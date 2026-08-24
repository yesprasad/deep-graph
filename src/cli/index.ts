import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { loadProject } from '../compiler/loader';
import { extractGraph } from '../extractor';
import { writeGraph } from '../output/writer';
import { displayGraph } from './display';
import { runBlast } from './blast';
import { runBlastPr } from './blast-pr';
import type { DependencyGraph } from '../types/graph';

const banner = `
  ██████╗ ███████╗███████╗██████╗        ██████╗ ██████╗  █████╗ ██████╗ ██╗  ██╗
  ██╔══██╗██╔════╝██╔════╝██╔══██╗      ██╔════╝ ██╔══██╗██╔══██╗██╔══██╗██║  ██║
  ██║  ██║█████╗  █████╗  ██████╔╝█████╗██║  ███╗██████╔╝███████║██████╔╝███████║
  ██║  ██║██╔══╝  ██╔══╝  ██╔═══╝ ╚════╝██║   ██║██╔══██╗██╔══██║██╔════╝██╔══██║
  ██████╔╝███████╗███████╗██║            ╚██████╔╝██║  ██║██║  ██║██║     ██║  ██║
  ╚═════╝ ╚══════╝╚══════╝╚═╝             ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝
`;

const program = new Command();

const showBanner = !process.argv.includes('--no-banner') && !process.argv.includes('--quiet');
if (showBanner) {
  console.log(chalk.cyan(banner));
  console.log(chalk.gray('        Compiler-aware dependency graph extraction for TypeScript projects'));
  console.log(chalk.gray('        ────────────────────────────────────────────────────────────────\n'));
}

program
  .name('deep-graph')
  .description('Compiler-aware dependency graph extraction for TypeScript projects')
  .version('0.1.0')
  .option('--no-banner', 'Suppress ASCII banner');

// ── Analyze Command ──
program
  .command('analyze')
  .description('Extract dependency graph from a TypeScript project')
  .option('-d, --dir <path>', 'Target project directory', '.')
  .option('-o, --output <path>', 'Output file path', 'deep-graph.json')
  .option('-q, --quiet', 'Suppress console output')
  .option('--no-display', 'Skip visual display')
  .action(async (options) => {
    let spinner: ora.Ora | undefined;

    try {
      const targetDir = path.resolve(options.dir);

      // Step 1: Load the TypeScript project
      if (!options.quiet) {
        spinner = ora('Loading TypeScript project...').start();
      }

      const compilerState = loadProject(targetDir);

      if (spinner) {
        spinner.succeed(
          `Project loaded: ${chalk.cyan(compilerState.sourceFiles.length)} source files ` +
          `(TypeScript ${chalk.gray(compilerState.tsVersion)})`
        );
      }

      // Step 2: Extract the graph
      if (!options.quiet) {
        spinner = ora('Extracting dependency graph...').start();
      }

      const graph = extractGraph(compilerState);

      if (spinner) {
        spinner.succeed(
          `Graph built: ${chalk.cyan(graph.metadata.nodeCount)} nodes, ` +
          `${chalk.cyan(graph.metadata.edgeCount)} edges`
        );
      }

      // Step 3: Write output
      const outputPath = path.isAbsolute(options.output)
        ? options.output
        : path.join(targetDir, options.output);

      writeGraph(graph, outputPath);

      if (!options.quiet) {
        console.log(chalk.green('\n✅ Analysis complete'));
        console.log(chalk.gray('   Output:       ') + chalk.white(outputPath));
        console.log(chalk.gray('   Density:      ') +
          chalk.cyan((graph.metadata.edgeCount / graph.metadata.nodeCount).toFixed(2)) +
          chalk.gray(' edges/node'));
      }

      // Step 4: Display
      if (options.display !== false && !options.quiet) {
        displayGraph(graph);
      }
    } catch (error: unknown) {
      if (spinner) spinner.fail();
      if (error instanceof Error) {
        console.error(chalk.red('\n❌ Error:'), error.message);
        if (process.env.DEBUG) {
          console.error(chalk.gray('\nStack trace:'));
          console.error(error.stack);
        }
      } else {
        console.error(chalk.red('\n❌ Unknown error occurred'));
      }
      process.exit(1);
    }
  });

// ── Blast Command ──
program
  .command('blast')
  .description('Analyze blast radius for a target file or symbol')
  .argument('<target>', 'Target file path or symbol name')
  .option('-d, --dir <path>', 'Target project directory', '.')
  .option('-g, --graph <path>', 'Path to existing graph JSON (skips extraction)')
  .option('-f, --format <type>', 'Output format: table, json, csv', 'table')
  .option('--depth <n>', 'Max traversal depth', '5')
  .action(async (target: string, options) => {
    let spinner: ora.Ora | undefined;

    try {
      let graph: DependencyGraph;

      if (options.graph) {
        // Use existing graph file
        const graphPath = path.isAbsolute(options.graph)
          ? options.graph
          : path.join(process.cwd(), options.graph);

        if (!fs.existsSync(graphPath)) {
          console.error(chalk.red(`\n❌ Graph file not found: ${graphPath}`));
          process.exit(1);
        }

        graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      } else {
        // Extract fresh graph
        const targetDir = path.resolve(options.dir);

        if (!options.quiet) {
          spinner = ora('Loading TypeScript project...').start();
        }

        const compilerState = loadProject(targetDir);
        if (spinner) spinner.succeed(`Project loaded: ${chalk.cyan(compilerState.sourceFiles.length)} source files`);

        if (!options.quiet) {
          spinner = ora('Extracting dependency graph...').start();
        }

        graph = extractGraph(compilerState);
        if (spinner) spinner.succeed(`Graph built: ${chalk.cyan(graph.metadata.nodeCount)} nodes, ${chalk.cyan(graph.metadata.edgeCount)} edges`);
      }

      runBlast(graph, target, {
        format: options.format,
        depth: parseInt(options.depth, 10),
      });
    } catch (error: unknown) {
      if (spinner) spinner.fail();
      if (error instanceof Error) {
        console.error(chalk.red('\n❌ Error:'), error.message);
      }
      process.exit(1);
    }
  });

// ── Blast PR Command ──
program
  .command('blast-pr')
  .description('Blast radius for all files changed in a PR (relative to base branch)')
  .option('-b, --base <branch>', 'Base branch to diff against', 'main')
  .option('-d, --dir <path>', 'Target project directory', '.')
  .option('-g, --graph <path>', 'Path to existing graph JSON (skips extraction)')
  .option('-f, --format <type>', 'Output format: table, json, csv', 'table')
  .option('--depth <n>', 'Max traversal depth', '5')
  .action(async (options) => {
    let spinner: ora.Ora | undefined;

    try {
      let graph: DependencyGraph;

      if (options.graph) {
        const graphPath = path.isAbsolute(options.graph)
          ? options.graph
          : path.join(process.cwd(), options.graph);

        if (!fs.existsSync(graphPath)) {
          console.error(chalk.red(`\n❌ Graph file not found: ${graphPath}`));
          process.exit(1);
        }

        graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      } else {
        const targetDir = path.resolve(options.dir);

        spinner = ora('Loading TypeScript project...').start();
        const compilerState = loadProject(targetDir);
        spinner.succeed(`Project loaded: ${chalk.cyan(compilerState.sourceFiles.length)} source files`);

        spinner = ora('Extracting dependency graph...').start();
        graph = extractGraph(compilerState);
        spinner.succeed(`Graph built: ${chalk.cyan(graph.metadata.nodeCount)} nodes, ${chalk.cyan(graph.metadata.edgeCount)} edges`);
      }

      runBlastPr(graph, {
        base: options.base,
        dir: path.resolve(options.dir),
        format: options.format,
        depth: parseInt(options.depth, 10),
      });
    } catch (error: unknown) {
      if (spinner) spinner.fail();
      if (error instanceof Error) {
        console.error(chalk.red('\n❌ Error:'), error.message);
      }
      process.exit(1);
    }
  });

// ── Unused Command ──
program
  .command('unused')
  .description('Find exported symbols that nothing depends on (dead exports)')
  .option('-d, --dir <path>', 'Target project directory', '.')
  .option('-g, --graph <path>', 'Path to existing graph JSON (skips extraction)')
  .option('-f, --format <type>', 'Output format: table, json', 'table')
  .action(async (options) => {
    let spinner: ora.Ora | undefined;

    try {
      let graph: DependencyGraph;

      if (options.graph) {
        const graphPath = path.isAbsolute(options.graph)
          ? options.graph
          : path.join(process.cwd(), options.graph);

        if (!fs.existsSync(graphPath)) {
          console.error(chalk.red(`\n❌ Graph file not found: ${graphPath}`));
          process.exit(1);
        }

        graph = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
      } else {
        const targetDir = path.resolve(options.dir);

        spinner = ora('Loading TypeScript project...').start();
        const compilerState = loadProject(targetDir);
        spinner.succeed(`Project loaded: ${chalk.cyan(compilerState.sourceFiles.length)} source files`);

        spinner = ora('Extracting dependency graph...').start();
        graph = extractGraph(compilerState);
        spinner.succeed(`Graph built: ${chalk.cyan(graph.metadata.nodeCount)} nodes, ${chalk.cyan(graph.metadata.edgeCount)} edges`);
      }

      // Find all exported symbols
      const exportedSymbols = graph.nodes.filter(
        n => n.type !== 'module' && n.type !== 'external_package' && n.attributes.exported
      );

      // Build set of all edge targets (nodes that something points to)
      const hasInbound = new Set<string>();
      for (const edge of graph.edges) {
        if (edge.type !== 'composition') {
          hasInbound.add(edge.to);
        }
      }

      // Also count any node that appears as a call/injects/extends/implements target
      // from a different file as "used"
      const unused = exportedSymbols.filter(n => !hasInbound.has(n.id));

      if (options.format === 'json') {
        const result = unused.map(n => ({
          name: n.name,
          type: n.type,
          file: n.source.file,
          line: n.source.line,
        }));
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.yellow.bold('\n🗑️  DEAD EXPORTS'));
      console.log(chalk.gray('═'.repeat(80)));
      console.log(chalk.gray(`Exported symbols with zero dependents — nothing imports, calls, extends, or injects them.\n`));

      if (unused.length === 0) {
        console.log(chalk.green('✅ No dead exports found. Every exported symbol is used.\n'));
        return;
      }

      {
        const Table = (await import('cli-table3')).default;
        const table = new Table({
          head: [
            chalk.cyan('Symbol'),
            chalk.cyan('Type'),
            chalk.cyan('File'),
            chalk.cyan('Line'),
          ],
          wordWrap: true,
          style: { head: [], border: ['gray'] },
        });

        unused
          .sort((a, b) => a.source.file.localeCompare(b.source.file) || a.name.localeCompare(b.name))
          .forEach(n => {
            table.push([
              chalk.white(n.name),
              chalk.gray(n.type),
              chalk.gray(n.source.file),
              chalk.gray(n.source.line?.toString() || '?'),
            ]);
          });

        console.log(table.toString());
        console.log(chalk.yellow(`\n📊 ${unused.length} dead export${unused.length === 1 ? '' : 's'} found`) +
          chalk.gray(` out of ${exportedSymbols.length} total exports`));
        console.log(chalk.gray('─'.repeat(80)) + '\n');
      }
    } catch (error: unknown) {
      if (spinner) spinner.fail();
      if (error instanceof Error) {
        console.error(chalk.red('\n❌ Error:'), error.message);
      }
      process.exit(1);
    }
  });

// ── MCP Init Command ──
program
  .command('mcp-init')
  .description('Generate MCP server config for AI tools (Claude Code, Copilot, Cursor, etc.)')
  .option('-t, --tool <name>', 'Target tool: claude, copilot, cursor, windsurf, all', 'all')
  .option('--global', 'Use global npx command instead of local path')
  .action(async (options) => {
    const tool = options.tool.toLowerCase();
    const useNpx = options.global || !fs.existsSync(path.join(process.cwd(), 'node_modules', '@yesprasad', 'deep-graph'));

    const mcpConfig = useNpx
      ? { command: 'npx', args: ['-y', '@yesprasad/deep-graph-mcp'] }
      : { command: 'node', args: ['node_modules/@yesprasad/deep-graph/bin/deep-graph-mcp.js'] };

    const targets: { name: string; file: string; content: string }[] = [];

    if (tool === 'claude' || tool === 'all') {
      targets.push({
        name: 'Claude Code',
        file: '.mcp.json',
        content: JSON.stringify({
          mcpServers: {
            'deep-graph': { command: mcpConfig.command, args: mcpConfig.args, env: {} }
          }
        }, null, 2),
      });
    }

    if (tool === 'copilot' || tool === 'all') {
      const vscodeMcp = {
        servers: {
          'deep-graph': { command: mcpConfig.command, args: mcpConfig.args, env: {} }
        }
      };
      targets.push({
        name: 'GitHub Copilot (VS Code)',
        file: '.vscode/mcp.json',
        content: JSON.stringify(vscodeMcp, null, 2),
      });
    }

    if (tool === 'cursor' || tool === 'all') {
      targets.push({
        name: 'Cursor',
        file: '.cursor/mcp.json',
        content: JSON.stringify({
          mcpServers: {
            'deep-graph': { command: mcpConfig.command, args: mcpConfig.args }
          }
        }, null, 2),
      });
    }

    if (tool === 'windsurf' || tool === 'all') {
      targets.push({
        name: 'Windsurf',
        file: '.windsurf/mcp.json',
        content: JSON.stringify({
          mcpServers: {
            'deep-graph': { command: mcpConfig.command, args: mcpConfig.args }
          }
        }, null, 2),
      });
    }

    if (targets.length === 0) {
      console.error(chalk.red(`\n❌ Unknown tool: ${tool}`));
      console.error(chalk.gray('   Valid options: claude, copilot, cursor, windsurf, all'));
      process.exit(1);
    }

    console.log(chalk.cyan('\n🔌 deep-graph MCP Server Setup\n'));

    for (const target of targets) {
      const filePath = path.join(process.cwd(), target.file);
      const dir = path.dirname(filePath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(filePath)) {
        // Merge into existing config
        try {
          const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          const serverKey = existing.mcpServers ? 'mcpServers' : 'servers';
          if (!existing[serverKey]) existing[serverKey] = {};
          existing[serverKey]['deep-graph'] = { command: mcpConfig.command, args: mcpConfig.args, env: {} };
          fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + '\n');
          console.log(chalk.green(`  ✅ ${target.name}`) + chalk.gray(` → merged into ${target.file}`));
        } catch {
          fs.writeFileSync(filePath, target.content + '\n');
          console.log(chalk.green(`  ✅ ${target.name}`) + chalk.gray(` → ${target.file} (overwritten, was not valid JSON)`));
        }
      } else {
        fs.writeFileSync(filePath, target.content + '\n');
        console.log(chalk.green(`  ✅ ${target.name}`) + chalk.gray(` → ${target.file}`));
      }
    }

    console.log(chalk.gray('\n   Server command: ') + chalk.white(`${mcpConfig.command} ${mcpConfig.args.join(' ')}`));
    console.log(chalk.gray('   Tools exposed:  ') + chalk.white('blast_radius, dependencies, unused_exports, graph_summary'));
    console.log(chalk.gray('\n   Restart your AI tool to pick up the new MCP server.\n'));
  });

// Default: show help
if (process.argv.length === 2) {
  program.help();
}

program.parse(process.argv);
