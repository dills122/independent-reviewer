# ADR-002: Use TypeScript and Node.js for the initial runtime

## Status

Accepted

## Date

2026-09-07

## Context

The first implementation needs to express and validate evolving review packets,
stage transitions, provider messages, tool schemas, persisted run records, and
structured reports. It also needs reliable Git and child-process control, a
small local CLI, deterministic offline tests, and a thin OpenRouter integration.

The project does not currently require a daemon, CPU-intensive processing, or a
single self-contained executable. The initial audience is an engineering and
agent-development environment where a managed Node.js runtime is acceptable.

The supporting
[runtime and tooling research spike](../research/2026-09-07-runtime-and-tooling-spike.md)
compared TypeScript/Node.js, Go, Python, and Rust against repository-specific
criteria.

## Decision

Use TypeScript 6 on Node.js 24 LTS for the initial implementation, packaged as
one ESM package with explicit internal module boundaries. Node recommends an
Active or Maintenance LTS release for production, and TypeScript 6 provides the
accepted strict ESM baseline.[^node-releases][^typescript-6]

Start with Node.js built-ins wherever practical, Zod 4 for runtime contract
validation and JSON Schema generation, the thin official `@openrouter/sdk`
client behind a project-owned provider interface, npm with a committed lockfile,
the Node.js test runner, and exact-pinned Biome plus `tsc --noEmit` quality
checks.[^zod-schema][^openrouter-sdk][^node-test]

Provider, contract, verification, and report interfaces remain language-neutral
at their persisted boundaries. Exact package versions must be inspected and
pinned when the runtime scaffold is created.

## Alternatives considered

### Go

Go provides excellent process control, testing, dependency restraint, and
single-binary distribution. It was not selected because the first release is
more heavily shaped by evolving variant-rich JSON contracts than by deployment
or native-runtime constraints. Go should be reconsidered if a self-contained
binary without Node.js becomes a first-release requirement.[^go-build]

### Python

Python with Pydantic is productive for typed data and provider work, but its
runtime and environment coordination is a weaker fit for the intended local CLI
audience than an npm package.[^pydantic-schema][^python-cli]

### Rust

Rust offers strong type and executable guarantees, but would add implementation
and provider-integration complexity without addressing a measured performance,
memory, or hardened-systems requirement.[^cargo][^openrouter-sdk]

## Consequences

- Versioned runtime schemas can drive TypeScript inference, local validation,
  and committed JSON Schema fixtures.
- Runtime validation remains mandatory; TypeScript types alone do not establish
  trust at provider, file, or process boundaries.
- The first distribution requires Node.js 24 LTS and will not promise a bundled
  single executable.
- Runtime dependencies remain deliberately few and exact-pinned.
- Git and configured checks use argument-array process APIs, never shell-built
  command strings.
- The runtime scaffold must define actual install, build, type-check, lint,
  test, and package checks before implementation begins.
- The decision can be revisited if distribution, deployment, team capability,
  or systems-performance requirements materially change.

[^node-releases]: Node.js, [release status and LTS guidance](https://nodejs.org/en/about/previous-releases).
[^typescript-6]: TypeScript, [TypeScript 6.0 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html) and [strict checking](https://www.typescriptlang.org/docs/handbook/2/basic-types.html#strictness).
[^zod-schema]: Zod, [JSON Schema conversion](https://zod.dev/json-schema).
[^openrouter-sdk]: OpenRouter, [Client SDKs](https://openrouter.ai/docs/client-sdks/overview).
[^node-test]: Node.js, [test runner](https://nodejs.org/api/test.html).
[^go-build]: Go, [compiling and installing applications](https://go.dev/doc/tutorial/compile-install) and [`os/exec`](https://pkg.go.dev/os/exec).
[^pydantic-schema]: Pydantic, [JSON Schema](https://pydantic.dev/docs/validation/latest/concepts/json_schema/).
[^python-cli]: Python Packaging Authority, [creating and packaging command-line tools](https://packaging.python.org/en/latest/guides/creating-command-line-tools/).
[^cargo]: Rust, [Cargo commands](https://doc.rust-lang.org/cargo/commands/cargo.html).
