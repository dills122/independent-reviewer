# Git and context library evaluation

Status: revised after adversarial validation and first implementation slice.
Decision owner: project maintainer.

## Executive conclusion

Adopt focused libraries behind product-owned policy adapters. Native Git plus
`parse-diff@0.12.0` now replaces custom line-diff computation while manifest
remains path/status authority. This removes commodity algorithm code and fixes
two reproduced failures: a CRLF-only edit disappeared, and 264 sparse edits in a
20,000-line file degraded into 455,389 bytes of whole-file evidence.

Adopt `execa` next for process lifecycle and `picomatch` for one explicit path
dialect. Make `@ast-grep/napi` the next review-quality slice, parsing packet
bytes with line-based fallback. Use `gpt-tokenizer` for supported-model packing
and measurement while retaining conservative fallback for unknown OpenRouter
tokenizers. Treat `@ataraxy-labs/sem` and `diff-core` as architecture references.

## Decision question

Which proposed libraries should enter the Independent Reviewer now, which need
an isolated spike, and which should be deferred or rejected?

Answer matters now because diff-based evidence and path classification just
landed. Adding abstractions without checking frozen-snapshot and security
contracts could replace small local code with dependencies that do not preserve
the same guarantees.

## Scope and stop condition

Evaluate `execa`, `simple-git`, `isomorphic-git`, `parse-diff`,
`@ast-grep/napi`, `ts-morph`, `tree-sitter`, `ignore`, `fast-glob`, `picomatch`,
`gpt-tokenizer`, `@langchain/textsplitters`, `@ataraxy-labs/sem`, and
`diff-core`. Use current primary documentation and the repository's present
implementation. Do not install packages, change runtime dependencies, make paid
provider calls, or authorize a new architecture. Stop when each option has an
evidence-backed adopt, spike, defer, or reject disposition.

## Criteria

1. Preserve cumulative committed, staged, unstaged, and untracked Git semantics.
2. Read code only from the frozen packet after capture.
3. Keep packet generation deterministic and index-preserving.
4. Keep repository and Git configuration from executing untrusted helpers.
5. Improve review signal or materially reduce maintained code.
6. Support pinned TypeScript 6 and Node.js 24 with auditable failure behavior.
7. Keep token admission conservative across OpenRouter model families.

## Method and sources

Reviewed current repository capture, classification, evidence assembly, and
admission boundaries. Compared official package metadata, public APIs, security
history, platform/runtime support, and whether each tool can consume frozen
packet bytes without rereading live worktree state. No packages were installed.

Primary source index:

- Git diff behavior and helper controls: [Git documentation](https://git-scm.com/docs/git-diff)
- `execa`: [API](https://github.com/sindresorhus/execa/blob/main/docs/api.md), [package metadata](https://raw.githubusercontent.com/sindresorhus/execa/main/package.json)
- `simple-git`: [project documentation](https://github.com/steveukx/git-js)
- `isomorphic-git`: [command reference](https://isomorphic-git.org/docs/en/alphabetic)
- `parse-diff`: [project documentation](https://github.com/sergeyt/parse-diff)
- `@ast-grep/napi`: [JavaScript API](https://ast-grep.github.io/reference/api), [usage guide](https://ast-grep.github.io/guide/api-usage/js-api)
- `ts-morph`: [project documentation](https://ts-morph.com/)
- `tree-sitter`: [Node bindings](https://github.com/tree-sitter/node-tree-sitter)
- matching/traversal: [`ignore`](https://github.com/kaelzhang/node-ignore), [`picomatch`](https://github.com/micromatch/picomatch), [`fast-glob`](https://github.com/mrmlnc/fast-glob), [Node `path.matchesGlob`](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern)
- context/token tools: [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer), [`@langchain/textsplitters`](https://js.langchain.com/docs/concepts/text_splitters/), [`sem`](https://github.com/Ataraxy-Labs/sem), [`diff-core`](https://github.com/jamesaphoenix/diff-core)

## Comparison and dispositions

| Option | Evidence | Repository fit | Decision |
| --- | --- | --- | --- |
| `execa` | Mature subprocess API supports argument arrays, byte buffers, timeouts, cancellation, and non-throwing exits. Environment extension is enabled by default. | Owns commodity lifecycle mechanics while a small adapter retains `extendEnv: false`, Git environment, output, and exit policy. | Adopt in next maintenance slice. |
| `simple-git` | High-level Git wrapper; complex plumbing still uses raw commands and some parsers depend on porcelain text. | Current capture intentionally uses NUL-delimited plumbing and byte output. Wrapper enlarges parser and dependency surface without replacing core logic. | Reject for capture. |
| `isomorphic-git` | Pure-JavaScript object/database implementation with status, blob, and merge-base APIs. | Missing required parity for attributes, native diff/rename behavior, and current cumulative working-tree semantics. `statusMatrix` refresh can update index metadata unless disabled. | Reject for current pipeline. |
| `parse-diff` | Small, zero-dependency parser for native unified patches. | Native Git renders frozen temporary BASE/HEAD files; parser validates one-file output and supplies structured hunks/statistics. Manifest still owns identity. | Adopted at exact version `0.12.0`. |
| `@ast-grep/napi` | Parses source strings and exposes structural matching through native Node bindings. API remains marked experimental and native-platform failures remain possible. | Can operate on packet bytes and enrich changed hunks with containing declarations without live filesystem access. | Next required quality slice, with native-failure fallback. |
| `ts-morph` | Rich TypeScript compiler wrapper with in-memory filesystems and TypeScript 6 support. | Valuable only if type-aware evidence proves necessary; default project loading risks crossing frozen boundary and dependency weight is high. | Defer; require packet-only virtual filesystem. |
| `tree-sitter` | Multi-language incremental syntax foundation with per-language grammars and native bindings. | Duplicates the near-term ast-grep experiment and adds grammar/platform management. | Defer until multi-language demand exists. |
| `ignore` | Implements many `.gitignore` rules but documents differences from Git. | Git already supplies canonical tracked/untracked and ignore decisions. Reimplementation risks drift. | Reject. |
| `picomatch` | Fast general glob matcher. Node 24 also provides stable `path.matchesGlob`. | Repository already had two dialects: a custom case-insensitive compiler and direct Node matching. One adapter can define semantics and delete both paths. | Adopt after defining exact case/glob semantics. |
| `fast-glob` | Filesystem traversal and matching; result order is not inherently the product contract. | Live-tree traversal violates snapshot-first evidence selection and duplicates Git enumeration. | Reject. |
| `gpt-tokenizer` | Local OpenAI-family encodings and model mappings, including current `o200k` families. | OpenRouter can route to non-OpenAI tokenizers, so counts cannot safely admit calls. Useful for packing heuristics and measured telemetry. | Telemetry-only spike. |
| `@langchain/textsplitters` | Generic RAG chunkers with additional runtime dependencies. | Syntax-unaware chunking can sever diffs and evidence coordinates; current problem is review context, not document retrieval. | Reject. |
| `@ataraxy-labs/sem` | Pre-1.0 semantic diff tool accepts before/after input; npm wrapper downloads an external binary and tool includes caches and optional cloud behavior. | Useful black-box quality benchmark, but evolving binary/platform/security contract is unsuitable for core capture. | Benchmark and architecture reference only. |
| `diff-core` | Rust/libgit2/tree-sitter engine with an intermediate representation, dependency graph, change flows, and risk ranking. | Strong design ideas, but not a Node library and normal operation rereads a repository rather than the frozen packet. | Architecture reference only. |

## Facts, observations, and inferences

- **Fact:** Git supports bounded unified context and can invoke configured
  external diff/text-conversion helpers unless callers disable them.
- **Observation:** Native renderer reconstructs fixed-name temporary files from
  frozen packet blobs, invokes Git with explicit algorithm/context/config flags,
  disables external diff and text conversion, parses one file, and removes the
  temporary directory.
- **Observation:** The earlier custom renderer normalized CRLF/LF before
  comparison and its bounded Myers fallback could turn sparse changes into a
  whole-file replacement above the evidence budget.
- **Inference:** Frozen input and side-effect controls belong in the adapter;
  line differencing and unified parsing are commodity library responsibilities.
- **Fact:** Node 24 documents `path.matchesGlob` as stable.
- **Observation:** Current standards rules already use that built-in matcher.
- **Observation:** A custom exclusion matcher and Node `path.matchesGlob` already
  created two dialects.
- **Inference:** Define one dialect, then use `picomatch` behind one adapter.
- **Fact:** `gpt-tokenizer` models OpenAI tokenizer families, not every provider
  tokenizer available through OpenRouter.
- **Inference:** Token estimates may prioritize evidence but cannot authorize a
  request that the byte ceiling rejects.

## Recommendation and next gates

Owner: project maintainer.

1. Keep adopted native Git plus `parse-diff` renderer. Its edge corpus and full
   suite must remain green.
2. Replace subprocess lifecycle with exact-pinned `execa`, preserving the
   current Git adapter contract and environment isolation.
3. Define path glob semantics and consolidate matching through `picomatch`.
4. Implement `@ast-grep/napi` against a fixed corpus:
   changed declarations, overloads, JSX, parse errors, 10k-line files, Linux
   arm64, Linux x64, and macOS. Gate: measurable finding/coverage improvement,
   deterministic output, bounded latency, and exact line fallback on failure.
5. Separately compare `gpt-tokenizer` estimates with provider-reported usage.
   Gate: telemetry error distribution only; no admission-policy change.
6. Benchmark `sem` as an isolated executable and mine `diff-core` for IR,
   dependency-flow, and risk-grouping ideas. Do not permit either to read live
   state in production evaluation.

## Confidence, limits, and unresolved questions

Confidence: high for native Git plus `parse-diff`; medium for syntax-context
gain. Exact dependency installed with zero npm audit findings, public API and
types inspected, and full repository suite passed. No broad transitive/native
platform audit ran. Main
unresolved question is whether declaration context improves reviewer accuracy
enough to offset native binary operations and packet growth. That is the next
experiment, not an assumption in this decision.
