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
import { runApiDiff } from './api-diff';
import { runPrCheck } from './pr-check';
import { buildApiGraph, mergeApiGraph, standaloneApiGraph } from '../openapi';
import type { DependencyGraph } from '../types/graph';

/**
 * Resolve `--openapi` into a list of spec files. Accepts the flag more
 * than once, and splits comma-separated values, so a service with a spec
 * per version can be analyzed in one pass.
 */
function collectSpecs(value: string, previous: string[]): string[] {
  return previous.concat(value.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Build the graph for a command that accepts both `--dir` and `--openapi`.
 *
 * Either source alone is valid: TypeScript only (the original behavior),
 * specs only (contract-only repositories), or both — which is where the
 * bridge edges make blast radius cross the boundary.
 */
function buildGraph(
  options: { dir?: string; openapi?: string[]; quiet?: boolean },
  onProgress?: (message: string) => void
): DependencyGraph {
  const specs = options.openapi ?? [];
  const targetDir = path.resolve(options.dir ?? '.');

  // With specs present, a missing TypeScript project is not an error —
  // a repository that holds only a contract is a valid thing to analyze.
  let compilerState: ReturnType<typeof loadProject> | null = null;
  try {
    compilerState = loadProject(targetDir);
    onProgress?.(`Project loaded: ${compilerState.sourceFiles.length} source files`);
  } catch (error) {
    if (specs.length === 0) throw error;
    onProgress?.('No TypeScript project found — analyzing the contract alone');
  }

  // TypeScript first so progress reads in the order the work happens.
  const graph = compilerState ? extractGraph(compilerState) : null;
  if (graph) {
    onProgress?.(
      `Graph built: ${graph.metadata.nodeCount} nodes, ${graph.metadata.edgeCount} edges`
    );
  }

  if (specs.length === 0) return graph!;

  const api = buildApiGraph(specs, compilerState, targetDir);
  const bridgeTotal = Object.values(api.bridges).reduce((a, b) => a + b, 0);
  onProgress?.(
    `API graph: ${api.operationCount} operations, ${api.schemaCount} schemas, ` +
    `${api.propertyCount} fields` +
    (compilerState ? `, ${bridgeTotal} bridges` : '')
  );

  warnUnresolved(api.unresolvedRefs, options.quiet);

  return graph ? mergeApiGraph(graph, api) : standaloneApiGraph(api);
}

function warnUnresolved(refs: string[], quiet?: boolean): void {
  if (quiet || refs.length === 0) return;
  // Unresolved refs mean part of the contract is invisible to the graph.
  // Reporting them keeps a partial spec from looking like a complete one.
  console.log(
    chalk.yellow(`\n⚠️  ${refs.length} unresolved $ref`) +
    chalk.gray(` (external or missing — those schemas are not in the graph)`)
  );
  refs.slice(0, 5).forEach(r => console.log(chalk.gray(`     • ${r}`)));
  if (refs.length > 5) {
    console.log(chalk.gray(`     … and ${refs.length - 5} more`));
  }
}

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
  .version('0.1.1')
  .option('--no-banner', 'Suppress ASCII banner');

// ── Analyze Command ──
program
  .command('analyze')
  .description('Extract dependency graph from a TypeScript project')
  .option('-d, --dir <path>', 'Target project directory', '.')
  .option('-o, --output <path>', 'Output file path', 'deep-graph.json')
  .option('--openapi <path>', 'OpenAPI/Swagger document to include (repeatable)', collectSpecs, [])
  .option('-q, --quiet', 'Suppress console output')
  .option('--no-display', 'Skip visual display')
  .action(async (options) => {
    let spinner: ora.Ora | undefined;

    try {
      const targetDir = path.resolve(options.dir);

      if (!options.quiet) {
        spinner = ora('Loading project...').start();
      }

      const graph = buildGraph(options, message => {
        if (spinner) {
          spinner.succeed(message);
          spinner = options.quiet ? undefined : ora('Working...').start();
        }
      });

      if (spinner) spinner.stop();

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

        const api = graph.metadata.api;
        if (api) {
          console.log(chalk.gray('   API surface:  ') +
            chalk.cyan(api.operationCount) + chalk.gray(' operations, ') +
            chalk.cyan(api.schemaCount) + chalk.gray(' schemas, ') +
            chalk.cyan(api.propertyCount) + chalk.gray(' fields'));

          const bridges = Object.entries(api.bridges).filter(([, n]) => n > 0);
          if (bridges.length > 0) {
            // Confidence is shown per tier, not summed: an inferred name
            // match and a maintained annotation are not the same evidence.
            console.log(chalk.gray('   Code bridges: ') +
              bridges
                .map(([tier, n]) =>
                  (tier === 'inferred' ? chalk.yellow : chalk.cyan)(`${n} ${tier}`)
                )
                .join(chalk.gray(', ')));
          }
        }
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
  .option('--openapi <path>', 'OpenAPI/Swagger document to include (repeatable)', collectSpecs, [])
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
        spinner = ora('Loading project...').start();
        graph = buildGraph(options, message => {
          if (spinner) {
            spinner.succeed(message);
            spinner = ora('Working...').start();
          }
        });
        if (spinner) spinner.stop();
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
  .option('--openapi <path>', 'OpenAPI/Swagger document to include (repeatable)', collectSpecs, [])
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
        spinner = ora('Loading project...').start();
        graph = buildGraph(options, message => {
          if (spinner) {
            spinner.succeed(message);
            spinner = ora('Working...').start();
          }
        });
        if (spinner) spinner.stop();
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

// ── API Diff Command ──
program
  .command('pr-check')
  .description('Run unified PR impact and OpenAPI contract checks')
  .option('-b, --base <branch>', 'Base branch or revision to compare against', 'main')
  .option('-d, --dir <path>', 'Target project directory', '.')
  .option('--openapi <path>', 'OpenAPI/Swagger document (repeatable)', collectSpecs, [])
  .option('-f, --format <type>', 'Output format: table, json', 'table')
  .option('--depth <n>', 'Max traversal depth', '5')
  .option('--fail-on-breaking', 'Exit non-zero when a breaking API change is found')
  .action(async (options) => {
    try {
      runPrCheck({
        base: options.base,
        dir: path.resolve(options.dir),
        openapi: options.openapi,
        depth: parseInt(options.depth, 10),
        format: options.format,
        failOnBreaking: options.failOnBreaking,
      });
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(chalk.red('\n❌ Error:'), error.message);
      }
      process.exit(1);
    }
  });

program
  .command('api-diff')
  .description('Compare an OpenAPI document against its base revision and report breaking changes')
  .option('--openapi <path>', 'OpenAPI/Swagger document (repeatable)', collectSpecs, [])
  .option('-b, --base <revision>', 'Base revision to diff against', 'main')
  .option('-d, --dir <path>', 'Target project directory', '.')
  .option('-g, --graph <path>', 'Existing graph JSON, used to resolve affected consumers')
  .option('--no-consumers', 'Skip consumer resolution (spec-only diff, no TypeScript needed)')
  .option('-f, --format <type>', 'Output format: table, json', 'table')
  .option('--fail-on-breaking', 'Exit non-zero when a breaking change is found')
  .action(async (options) => {
    let spinner: ora.Ora | undefined;

    try {
      if (options.openapi.length === 0) {
        console.error(chalk.red('\n❌ api-diff needs at least one --openapi <path>'));
        process.exit(1);
      }

      // Graph building is only needed to answer "who depends on this",
      // and is deferred to a callback because the diff needs it for two
      // different spec sets — the current one and the base revision's.
      let buildForSpecs:
        | ((specPaths: string[]) => DependencyGraph | null)
        | null = null;

      if (options.consumers !== false) {
        if (options.graph) {
          const graphPath = path.isAbsolute(options.graph)
            ? options.graph
            : path.join(process.cwd(), options.graph);

          if (!fs.existsSync(graphPath)) {
            console.error(chalk.red(`\n❌ Graph file not found: ${graphPath}`));
            process.exit(1);
          }
          // A supplied graph reflects the current spec only, so removed
          // fields will not resolve consumers from it.
          const supplied: DependencyGraph = JSON.parse(
            fs.readFileSync(graphPath, 'utf-8')
          );
          buildForSpecs = () => supplied;
        } else {
          spinner = ora('Building graph for consumer resolution...').start();
          const cache = new Map<string, DependencyGraph | null>();

          buildForSpecs = (specPaths: string[]) => {
            const key = specPaths.join('|');
            if (cache.has(key)) return cache.get(key)!;

            let built: DependencyGraph | null = null;
            try {
              built = buildGraph({
                dir: options.dir,
                openapi: specPaths,
                quiet: true,
              });
            } catch {
              // A spec-only repository is a legitimate case — report the
              // contract change without the consumer half.
              built = null;
            }
            cache.set(key, built);
            return built;
          };

          const probe = buildForSpecs(options.openapi);
          if (probe) {
            spinner.succeed(`Graph built: ${chalk.cyan(probe.metadata.nodeCount)} nodes`);
          } else {
            spinner.warn('No TypeScript project found — reporting contract changes only');
          }
        }
      }

      runApiDiff(options.openapi, {
        base: options.base,
        dir: path.resolve(options.dir),
        format: options.format,
        buildGraph: buildForSpecs,
        failOnBreaking: options.failOnBreaking,
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
