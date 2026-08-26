# TypeScript support

DeepGraph uses the bundled TypeScript compiler API to construct the TypeScript
graph. It resolves imports, aliases, re-exports, symbols, type references,
inheritance, and statically resolvable calls through the same project context
used by the compiler.

## Requirements

- Node.js 18+
- A `tsconfig.json`
- Installed dependencies (`node_modules`) when external or workspace imports
  need to resolve
- TypeScript 4.7+ is recommended; DeepGraph is tested on TypeScript 5.x

## Run it

```bash
deep-graph pr-check --base origin/main
deep-graph analyze --dir /path/to/project
deep-graph blast src/types/graph.ts
```

DeepGraph identifies the project and compiler version in human-readable output:

```text
Identified: TypeScript — compiler 5.x
```

## Coverage boundary

TypeScript project references are followed. Workspace packages that are linked
only by package-manager symlinks need their dependencies installed, just as they
do for `tsc` itself. Dynamic imports and computed `require()` calls cannot be
proven statically and are not represented as resolved edges.

Mixed TypeScript/JavaScript projects work when `allowJs` is enabled in the
tsconfig. Pure JavaScript projects without a tsconfig are not supported.
