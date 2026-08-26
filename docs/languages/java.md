# Java support

DeepGraph always builds a source-level Java graph first. It discovers packages,
local imports, classes, interfaces, records, enums, annotations, methods,
inheritance, and local type relationships without executing Maven or Gradle.

For compiler-resolved PR analysis, it can enrich that graph through Eclipse JDT
Language Server (JDT LS). JDT LS imports the Maven or Gradle project and provides
resolved cross-file references, implementations and overrides, incoming calls,
and diagnostics.

## Run it

```bash
deep-graph pr-check --language java --base origin/main
```

Use strict semantic coverage in CI when Java resolution is required:

```bash
deep-graph pr-check --language java --semantic required --base origin/main
```

## Semantic modes

| Mode | Behaviour |
| --- | --- |
| `auto` (default) | Builds a structural graph if JDT LS cannot run, and reports `partial` or `unavailable` coverage. |
| `required` | Fails instead of producing a limited semantic result. Use this for high-confidence CI gates. |
| `off` | Runs structural analysis only. |

## JDT LS setup

JDT LS needs an extracted Eclipse JDT Language Server distribution and Java 21+
to run. Configure it with environment variables:

```bash
export DEEP_GRAPH_JDTLS_PATH=/path/to/jdt-language-server
export DEEP_GRAPH_JAVA_PATH=/path/to/java
```

Or pass explicit paths per invocation:

```bash
deep-graph pr-check --language java --semantic required \
  --jdtls /path/to/jdt-language-server \
  --java /path/to/java \
  --base origin/main
```

The repository should also provide the build tool and JDK version its Maven or
Gradle build declares—prefer `./mvnw` or `./gradlew` wrappers. DeepGraph does
not compile or modify the application; JDT LS uses the project model to resolve
the code.

## Reading coverage

Every Java report declares its evidence level:

```text
Java semantics: available   # JDT LS imported the project cleanly
Java semantics: partial     # Some references resolved; diagnostics limit confidence
Java semantics: unavailable # Structural graph only
```

When semantics are unavailable, DeepGraph does not claim exact overload
selection, external dependency resolution, framework wiring, or call paths it
cannot prove.

## Current boundary

Spring runtime route extraction and Java-to-OpenAPI bridges are not yet
implemented. They are planned on top of the JDT LS semantic foundation.
