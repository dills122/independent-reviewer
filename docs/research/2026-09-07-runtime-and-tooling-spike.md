# Runtime and tooling research spike

Status: complete; recommendation accepted in
[ADR-002](../decisions/002-use-typescript-node-runtime.md).

Date: 2026-09-07

Decision owner: repository owner.

## Executive conclusion

Adopt **TypeScript 6 on Node.js 24 LTS** for the first implementation, using a
single ESM package and a deliberately small dependency surface.

TypeScript is the best fit because this product is dominated by versioned JSON
contracts, discriminated lifecycle states, model messages, tool schemas, and
validated provider responses. Its advantage is not model-call performance: the
network and model dominate that latency, and language choice does not materially
reduce metered tokens. Its advantage is making the protocol easier to express,
inspect, evolve, and test without slowing the first useful release.

Go is the strongest alternative. Choose Go instead if distributing one
self-contained binary to machines without a managed runtime becomes a first-
release requirement. That is not currently an acceptance gate, and prioritizing
it now would trade away schema ergonomics and iteration speed for a benefit we
do not yet need.

Do not use a high-level agent SDK for the core workflow. The local orchestrator
must own conversation state, tool dispatch, visibility gates, persistence,
budgets, and retries. Use the thin official OpenRouter TypeScript client behind
the project-owned provider interface, with all responses validated locally.

## Decision question

Which language and minimal toolchain best implement the local independent-review
engine described in [`docs/review-protocol-spec.md`](../review-protocol-spec.md),
while preserving trust boundaries, delivery speed, maintainability, efficient
metered model use, and a credible path to later host automation?

## Scope and stop condition

Compared options:

- TypeScript on Node.js;
- Go;
- Rust; and
- Python.

The spike covered contract/schema support, OpenRouter integration, Git and child
process control, testing, CLI distribution, dependency risk, and operational
fit. It did not install dependencies, create runtime code, benchmark model
quality, choose a reviewer model, or authorize implementation.

Research stopped once current primary documentation was sufficient to identify
one recommendation, one credible runner-up, implementation consequences, and
conditions that would change the decision. A toy implementation would mostly
measure author familiarity and would not resolve the important tradeoff.

## Decision criteria

The comparison uses these repository-specific weights. Scores are an inference,
not an externally measured fact.

| Criterion | Weight | Why it matters here |
| --- | ---: | --- |
| Contract and schema fidelity | 25% | Packets, reports, tools, state, and errors are the product boundary. |
| OpenRouter and protocol fit | 20% | The provider must support structured output and tool loops without owning orchestration. |
| Delivery speed and maintainability | 15% | The goal is to make a proven workflow explicit without building a research platform. |
| Git, filesystem, and process control | 15% | Snapshot capture and local verification are core trust boundaries. |
| Testing and deterministic fixtures | 10% | Blind-stage withholding and dirty-tree capture require strong offline tests. |
| CLI distribution | 10% | The first interface is local, with broader distribution later. |
| Dependency and security posture | 5% | Reviewed source and provider credentials make dependency restraint important. |

## Repository and environment observations

### Observation: project shape

At commit `5bfdcd919782648aad7ccf7ba5da6d86425f419f`, the repository contains
architecture and setup documentation but no runtime manifest or application
dependency. The protocol specification calls for a single local CLI, JSON-like
contracts, Git subprocesses, local artifact persistence, a mock provider, and a
future OpenRouter adapter. There is no CPU-intensive workload or resident
service that would justify optimizing for native execution performance first.

### Observation: available local toolchains

The research environment was macOS 26.6.2 on arm64 with:

```text
Node.js v22.22.1
npm 10.9.4
Go 1.26.5
Rust 1.99.0-nightly
Python 3.14.6
Git 2.50.1 (Apple Git-155)
```

This confirms all four candidates are locally feasible. It is not a reason to
select one. Node 24 LTS would need to be added to the project environment if the
recommendation is accepted.

## Documented facts and implications

### Shared facts

- **Documented fact:** OpenRouter's direct API is language-neutral, and its thin
  official clients cover TypeScript, Python, and Go. Its client/agent comparison
  says the client SDK leaves conversation loops and tool dispatch to the
  application, whereas the agent SDK manages them. [OpenRouter client SDKs](https://openrouter.ai/docs/client-sdks/overview)
  **Inference:** TypeScript, Python, and Go are all viable for transport. The
  project should avoid the agent SDK because automatic orchestration overlaps
  the state machine we must enforce and audit.
- **Documented fact:** OpenRouter supports tool calls and strict structured
  outputs for compatible models, and recommends `require_parameters: true` plus
  local model-capability checks. [Tool calling](https://openrouter.ai/docs/guides/features/tool-calling),
  [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs),
  [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
  **Inference:** JSON Schema quality and runtime validation matter more than an
  ecosystem-specific agent abstraction.
- **Documented fact:** OpenRouter responses include native-tokenizer input,
  output, reasoning, cache, and cost information. Different models tokenize the
  same input differently. [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting),
  [model metadata](https://openrouter.ai/docs/guides/overview/models)
  **Inference:** no language has a meaningful inherent token-cost advantage.
  The token strategy belongs in deterministic context selection, output caps,
  measurement, and model configuration.
- **Documented fact:** Git provides stable, NUL-delimited porcelain status and
  raw diff formats for machine parsing, including rename, deletion, mode, and
  unmerged-state information. [Git status](https://git-scm.com/docs/git-status),
  [Git diff](https://git-scm.com/docs/git-diff)
  **Inference:** invoke the installed Git CLI rather than reimplementing Git or
  starting with a language-specific Git library. This applies to every candidate.

### TypeScript and Node.js

- **Documented fact:** Node 24 is the latest LTS line as of the research date;
  Node recommends production applications use an Active or Maintenance LTS
  release. [Node releases](https://nodejs.org/en/about/previous-releases)
- **Documented fact:** TypeScript 6 is stable, defaults to strict checking, and
  prepares projects for the native TypeScript 7 compiler. The TypeScript
  documentation recommends strict checks for new projects. [TypeScript 6](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html),
  [strict checking](https://www.typescriptlang.org/docs/handbook/2/basic-types.html#strictness)
- **Documented fact:** Node can execute erasable TypeScript directly, while
  making clear that it does no type checking and ignores `tsconfig.json` at
  runtime. [Node TypeScript support](https://nodejs.org/api/typescript.html)
  **Inference:** use native execution for development/tests only alongside an
  explicit `tsc --noEmit` gate; emit JavaScript for the packaged CLI.
- **Documented fact:** Node's `execFile` does not spawn a shell by default and
  supports explicit arguments, working directory, timeout, environment, and
  abort signal. [Node child processes](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)
  **Inference:** this is a suitable primitive for Git and configured named
  checks; model text never needs shell interpolation.
- **Documented fact:** Node's built-in test runner is stable and uses process
  isolation by default across test files. [Node test runner](https://nodejs.org/api/test.html)
  **Inference:** the initial project does not need Jest or Vitest to test pure
  contracts, fixture repositories, subprocess behavior, or a mock provider.
- **Documented fact:** Zod 4 can validate TypeScript-shaped runtime data and
  emit JSON Schema, including Draft 7 and Draft 2020-12, while rejecting
  unrepresentable types by default. [Zod JSON Schema](https://zod.dev/json-schema)
  **Inference:** one schema definition can back runtime validation, inferred
  TypeScript types, committed schema artifacts, and conservative provider
  schemas if generation is snapshot-tested.
- **Documented fact:** Node single-executable applications remain marked active
  development and have platform test limitations. [Node single executable applications](https://nodejs.org/api/single-executable-applications.html)
  **Inference:** do not make Node SEA part of the first distribution contract.

### Go

- **Documented fact:** `go build` emits an executable, the standard `testing`
  tool is integrated with the toolchain, native fuzzing is supported, and
  `govulncheck` uses a curated Go vulnerability database. [Building Go](https://go.dev/doc/tutorial/compile-install),
  [Go security](https://go.dev/doc/security/)
- **Documented fact:** `os/exec` intentionally avoids invoking a system shell,
  and `CommandContext` can terminate work when a context expires. [Go `os/exec`](https://pkg.go.dev/os/exec)
- **Documented fact:** the official OpenRouter Go SDK exists but is beta and
  warns that breaking changes may occur in `0.x` releases. [OpenRouter Go SDK](https://github.com/OpenRouterTeam/go-sdk)
- **Documented fact:** a prominent Go JSON Schema generator supports Draft
  2020-12 but remains pre-1.0 and uses reflection and struct tags. [Invopop JSON Schema](https://github.com/invopop/jsonschema)
  **Inference:** Go is excellent for a durable CLI and process runner, but the
  schema toolchain is less direct for rapidly evolving, deeply variant protocol
  contracts than TypeScript plus Zod.

### Rust

- **Documented fact:** Cargo provides integrated build, test, package, and
  executable workflows, while Rust supports many platforms and cross-compilation
  targets. [Cargo](https://doc.rust-lang.org/cargo/commands/cargo.html),
  [Rust installation and targets](https://rust-lang.org/tools/install/)
- **Documented fact:** Serde/Schemars can derive JSON Schema from Rust types.
  [Schemars](https://docs.rs/schemars/latest/schemars/)
- **Documented fact:** OpenRouter's official client list includes TypeScript,
  Python, and Go, but not Rust. [OpenRouter client SDKs](https://openrouter.ai/docs/client-sdks/overview)
  **Inference:** Rust offers excellent executable distribution and type safety,
  but adds implementation complexity without solving a measured performance or
  memory problem. Raw HTTP is feasible, but provider maintenance would be more
  project-owned.

### Python

- **Documented fact:** Pydantic provides runtime validation and Draft 2020-12
  JSON Schema generation from typed models. [Pydantic JSON Schema](https://pydantic.dev/docs/validation/latest/concepts/json_schema/)
- **Documented fact:** Python's `subprocess.run` supports explicit arguments,
  output capture, environment, working directory, timeout, and no-shell
  operation. [Python subprocess](https://docs.python.org/3/library/subprocess.html)
- **Documented fact:** current Python packaging guidance installs CLI tools with
  `pipx`, which creates and manages an isolated virtual environment. Python
  virtual environments are disposable but not movable or copyable. [Packaging CLI tools](https://packaging.python.org/en/latest/guides/creating-command-line-tools/),
  [virtual environments](https://docs.python.org/3/library/venv.html)
  **Inference:** Python is nearly as ergonomic as TypeScript for contracts and
  provider work, but distributing a predictable local CLI requires more runtime
  and environment coordination than an npm package for the intended initial
  audience or a Go binary.

## Consistent option comparison

Scores are `1` (poor fit) through `5` (strong fit), weighted by the criteria
above. They summarize the cited facts plus repository-specific inference; they
are not benchmark results.

| Option | Contract/schema | Provider/protocol | Delivery/maintenance | Git/process | Testing | Distribution | Dependency/security | Weighted result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| TypeScript/Node | 5.0 | 5.0 | 5.0 | 4.0 | 4.0 | 3.0 | 3.0 | **4.45** |
| Go | 3.5 | 4.0 | 4.0 | 5.0 | 5.0 | 5.0 | 5.0 | **4.28** |
| Python | 4.5 | 4.5 | 4.5 | 4.0 | 4.5 | 2.5 | 3.5 | **4.18** |
| Rust | 4.0 | 2.5 | 2.5 | 5.0 | 4.5 | 5.0 | 4.0 | **3.78** |

### TypeScript failure modes

- Static types disappear at runtime. Mitigation: validate every external and
  persisted boundary with schemas; never cast provider JSON into trust.
- npm dependency trees can grow quickly. Mitigation: prefer Node built-ins,
  pin direct tools, commit the lockfile, and justify every runtime dependency.
- A Node runtime is required for the initial package. Mitigation: target the
  engineering/agent environment first and defer bundled executables until demand
  is demonstrated.
- Generated provider types may change. Mitigation: isolate the SDK behind the
  project adapter, pin it, runtime-validate its results, and contract-test message
  translation.

### Go failure modes

- Reflection/tag-based schema generation can diverge from desired external
  contracts. Mitigation if Go is selected: commit generated schemas and validate
  them against golden fixtures.
- Evolving nested sum types requires more custom marshal/unmarshal and schema
  work. This is manageable but affects the most frequently changed part of the
  product.
- A beta provider SDK may force updates. Mitigation: isolate or use `net/http`
  directly.

### Python failure modes

- Interpreter and environment variability complicates reproducible CLI support.
- Runtime typing is strong with Pydantic, but static guarantees require a second
  type-checking tool and consistently maintained annotations.
- Packaging is sound but asks users to manage Python/pipx or consume separately
  built executables.

### Rust failure modes

- Compile-time safety does not remove the need for runtime JSON validation.
- Slower implementation and higher code complexity would delay validation of
  the product protocol.
- The project would own more OpenRouter transport integration because no official
  Rust client is currently listed.

## Recommended initial toolchain

This is the accepted initial stack, not installation authority. Exact dependency
versions must be pinned and inspected when the scaffold is approved.

| Concern | Recommendation | Reason |
| --- | --- | --- |
| Runtime | Node.js 24 LTS | Supported LTS line; broad filesystem, process, crypto, HTTP, and stream primitives. |
| Language | TypeScript 6, ESM | Strong contract modeling and current strict defaults; matches the official provider client. |
| Package manager | npm with committed `package-lock.json` | Adequate for one package; `npm ci` verifies manifest/lock agreement and avoids another bootstrap tool. |
| Type settings | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUncheckedSideEffectImports`, `erasableSyntaxOnly` | Makes absence, indexed access, imports, and native TS execution constraints explicit. |
| Contract schemas | Zod 4 plus committed generated JSON Schema fixtures | One source for runtime validation and TypeScript inference; Draft 7/provider and Draft 2020-12/local forms are testable. |
| Provider transport | Pinned `@openrouter/sdk` client only | Thin typed client designed for custom orchestration; do not use `@openrouter/agent`. |
| Git/process | Installed Git CLI via `execFile`/`spawn`, never shell strings | Uses Git's stable machine formats and avoids command interpolation. |
| CLI parsing | Node `util.parseArgs` initially | Stable built-in is sufficient for four command families and keeps runtime dependencies down. |
| Tests | `node:test` plus `node:assert/strict` | Stable built-in runner; fixture repositories and mock provider need no test framework initially. |
| Format/lint | Exact-pinned Biome plus `tsc --noEmit` | One formatter/linter tool plus the compiler's semantic checks; avoid an ESLint/Prettier stack until a missing rule justifies it. |
| Build | `tsc` to ESM JavaScript; no bundler | The package is small and targets one current LTS runtime. |
| Packaging | npm package with a `bin` entry; `npm pack` smoke test | Matches the initial engineering audience; no unstable single-executable commitment. |
| Hashing | Node `crypto`, SHA-256, canonical JSON serialization | Stable built-in and interoperable artifact identities. |
| Configuration | JSON validated by the same contract layer | Avoid a YAML/TOML parser dependency in the first slice. |

Use a source layout aligned with the agreed module boundaries:

```text
src/
  cli/
  contracts/
  evidence/
  orchestrator/
  provider/
  report/
  snapshot/
  verification/
test/
  fixtures/
  integration/
  unit/
schemas/
```

The exact package names and scripts belong in the implementation specification
after the language decision is accepted.

## Token and cost implications

### Documented fact

OpenRouter bills using model/provider tokenization and returns actual usage and
cost in responses. Prompt caching varies by provider/model, and cache use can
affect routing. Account-level ZDR disables OpenRouter response caching because
response caching retains data. [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting),
[prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching),
[response caching](https://openrouter.ai/docs/guides/features/response-caching)

### Inference

Language selection should not be justified by token efficiency. The initial
implementation should instead:

- measure UTF-8 bytes deterministically before sending and use a conservative,
  model-specific token estimator only when one is verified;
- enforce provider `maxOutputTokens` and project-owned per-stage budgets;
- persist actual provider usage and cost from every response;
- send compact JSON manifests and identifiers, not repeated prose;
- make evidence reads paginated and digest-addressed;
- preserve stable prompt prefixes so provider prompt caching can help when it is
  compatible with the selected privacy policy; and
- never enable response caching merely to save cost when the data-retention
  policy forbids it.

The thin SDK provides typed access but does not replace these project-level
controls.

## Confidence and limitations

Confidence: **moderately high** that TypeScript/Node is the best first runtime
under the current acceptance gates.

Limitations:

- No dependency was installed or package API inspected locally.
- No implementation benchmark was run; none is currently decision-critical.
- Team language preference and long-term contributor profile were not supplied.
- Cross-platform support targets beyond the initial local workflow are not yet
  explicit.
- The official OpenRouter SDKs and TypeScript ecosystem continue to evolve; pin
  and inspect the chosen versions before adoption.
- JSON Schema accepted by individual model/provider combinations can be a
  restricted subset. Provider-facing schema fixtures require a live opt-in
  compatibility smoke test.

## What would change the recommendation

Select **Go** if any of these become first-release requirements:

- one self-contained executable with no Node installation;
- broad deployment to heterogeneous developer machines;
- a long-lived background service or high-concurrency local daemon;
- materially stricter control over transitive runtime dependencies; or
- maintainers are substantially more effective in Go than TypeScript.

Reconsider **Python** if the project becomes primarily an evaluation/research
tool tied to Python ML and data-processing libraries rather than a distributable
review engine.

Reconsider **Rust** if profiling reveals a real performance/memory constraint,
the verification executor becomes a hardened systems component, or a Rust
maintainer base becomes a requirement.

## Recommendation and next gate

The repository owner accepted:

> Use TypeScript 6 on Node.js 24 LTS for a single ESM package, starting with
> Node built-ins, Zod 4, the thin OpenRouter client, and exact-pinned Biome. Keep
> the provider, verification, and contract boundaries language-neutral.

The next gate is a scaffold specification that names exact versions after
inspecting the packages, adds the AI Central TypeScript profile, defines
build/test/lint commands, and implements only the first contract-and-packet
slice. This research does not authorize those changes.

## Source index

Primary sources used:

1. [OpenRouter client SDK comparison](https://openrouter.ai/docs/client-sdks/overview)
2. [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
3. [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
4. [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
5. [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
6. [Node release status](https://nodejs.org/en/about/previous-releases)
7. [Node TypeScript support](https://nodejs.org/api/typescript.html)
8. [Node child processes](https://nodejs.org/api/child_process.html)
9. [Node test runner](https://nodejs.org/api/test.html)
10. [TypeScript 6 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html)
11. [Zod JSON Schema conversion](https://zod.dev/json-schema)
12. [Git status machine format](https://git-scm.com/docs/git-status)
13. [Git diff machine format](https://git-scm.com/docs/git-diff)
14. [Go build](https://go.dev/doc/tutorial/compile-install)
15. [Go process execution](https://pkg.go.dev/os/exec)
16. [OpenRouter Go SDK](https://github.com/OpenRouterTeam/go-sdk)
17. [Rust Cargo](https://doc.rust-lang.org/cargo/commands/cargo.html)
18. [Rust Schemars](https://docs.rs/schemars/latest/schemars/)
19. [Python subprocess](https://docs.python.org/3/library/subprocess.html)
20. [Pydantic JSON Schema](https://pydantic.dev/docs/validation/latest/concepts/json_schema/)
21. [Python CLI packaging](https://packaging.python.org/en/latest/guides/creating-command-line-tools/)
22. [Biome getting started](https://biomejs.dev/guides/getting-started/)
