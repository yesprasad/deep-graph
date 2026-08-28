# TypeScript support

DeepGraph uses the bundled TypeScript compiler API to construct the TypeScript
graph. It resolves imports, aliases, re-exports, symbols, type references,
inheritance, and statically resolvable calls through the same project context
used by the compiler.

## Requirements

- Node.js 18+
- A `tsconfig.json`
- Installed dependencies (`node_modules`) when external imports need to resolve
- TypeScript 4.7+ is recommended; DeepGraph is tested on TypeScript 5.x

## Run it

```bash
deep-graph pr-check --base origin/main
deep-graph analyze --dir /path/to/project
deep-graph blast src/types/graph.ts
```

DeepGraph identifies the project and compiler version in human-readable output:

```text
Identified: TypeScript — compiler 5.x; 12 discovered projects; bun + turbo
```

## Coverage boundary

DeepGraph discovers workspace patterns from `package.json` and
`pnpm-workspace.yaml`, then combines every workspace `tsconfig.json` and
TypeScript project reference into one program. Workspace package names and
package exports resolve directly to source where possible; package-manager
symlinks are not required for those internal relationships. Each source file
uses its own `tsconfig` for `baseUrl` and `paths`, so aliases such as `@/*`,
`@ui/*`, or `@repo/*` remain project-local rather than being hard-coded.

Bun/Turbo, pnpm, Yarn, npm, Nx, and other runners are discovery signals, not
semantic dependencies. DeepGraph's TypeScript resolver remains the source of
truth. The JSON graph and `pr-check --format json` report the project list and
any unresolved workspace package imports; unresolved imports mean the graph is
partial.

Dynamic imports and computed `require()` calls cannot be proven statically and
are not represented as resolved edges.

Mixed TypeScript/JavaScript projects work when `allowJs` is enabled in the
tsconfig. Pure JavaScript projects without a tsconfig are not supported.
