# Language-neutral code-context and review-unit evaluation

Status: accepted by ADR-009; first dependency and multi-language slice implemented.
Decision owner: project maintainer.

This report supersedes the TypeScript-first `@ast-grep/napi` disposition in
`2026-09-10-git-context-library-evaluation.md` and
`2026-09-10-review-unit-library-evaluation.md`. Their frozen-input and corpus
gates remain; general-product scope changes parser choice.

## Executive conclusion

Adopt Code Context Engine's useful architecture ideas, not CCE as the review
pipeline's authoritative index. Build a digest-bound `ReviewContextMapV1` from
the frozen packet. Seed every review unit from changed hunks, attach enclosing
syntax regions, and expand through explicit typed relations under a deterministic
budget. Expose progressive disclosure operations equivalent to search, expand,
and related context only after the map exists.

Keep core contracts language-neutral. Use string language identifiers, generic
source regions, typed relation provenance, and pluggable analyzers. Make
Tree-sitter the syntax foundation and prove one registry with JavaScript,
TypeScript/TSX, Python, Go, and Java rather than shipping a TypeScript-only feature. Add an
optional SCIP importer later for precise definitions, references, and
implementations when a trusted language index already exists. Fall back to diff
hunks and bounded line regions for every unsupported or malformed language.

Do not use embeddings or model-selected search to decide required coverage.
They may enrich a unit after deterministic evidence is present, but they cannot
prove that every changed target was reviewed.

## Decision question

Would CCE-style code chunking and related-code mapping improve focused review
units, and which foundation preserves a general multi-language product rather
than tailoring the engine to JavaScript and TypeScript?

This matters because the first live end-to-end run transmitted complete changed
files but produced unsupported findings. More bytes did not produce more
reliable reasoning. Review units need smaller evidence neighborhoods without
losing frozen identity, changed-path coverage, or an auditable explanation of
why each unchanged source entered a model request.

## Scope and stop condition

Compare current CCE source and official documentation, Tree-sitter, ast-grep,
SCIP, Continue's indexing design, and current repository boundaries. Evaluate
chunk identity, relationship quality, language breadth, deterministic packing,
frozen-byte support, operational cost, and failure behavior. Do not install a
dependency, change runtime behavior, make provider calls, or approve a new
public contract. Stop with one build direction and measurable adoption gates.

## Criteria

1. Parse only captured BASE/HEAD bytes after snapshot freeze.
2. Preserve exact path, side, source range, content digest, and analyzer
   provenance for every chunk and relation.
3. Cover every changed hunk even when no language parser exists.
4. Keep core schemas free of JavaScript, TypeScript, Node, or package-manager
   assumptions.
5. Distinguish exact semantic relations, exact syntactic relations, and
   heuristics.
6. Produce stable ordering and unit identity independent of embeddings, file
   timestamps, task completion order, and model queries.
7. Bound unit bytes/tokens while recording every omitted candidate and reason.
8. Add useful languages through adapters without changing orchestration or
   report contracts.

## What CCE actually does

### Documented behavior

- CCE 0.4.26 is a Python 3.11+ beta application. Its current core dependencies
  include Tree-sitter plus separate Python, JavaScript, TypeScript, PHP, Go,
  Rust, Java, and C# grammars.
- CCE parses those languages into function and class regions. Current source
  falls back to one module chunk containing the whole source; this conflicts
  with official documentation that says other files use line-based chunks.
- A chunk records content, function/class/module kind, file path, start/end
  line, language, optional compressed content, and confidence score.
- Search combines embeddings and SQLite full-text search. Current retrieval
  also uses a confidence score, per-file diversity cap, optional token packing,
  and up to two bonus files reached through graph edges.
- CCE exposes progressive disclosure: compact search results, full chunk
  expansion, and related-context lookup.
- Its current benchmark reports strong retrieval savings against full-file
  reads, but explicitly says this is not a comparison with ordinary agent grep
  and partial reads. Reported Recall@10 varies materially: 0.95 on Django and
  0.07 on the Fiber Go monorepo.

Inspected source commit:
[`75071156e08a145fab17c8ce30bb5f418286f434`](https://github.com/elara-labs/code-context-engine/tree/75071156e08a145fab17c8ce30bb5f418286f434).
Sources: [CCE README](https://github.com/elara-labs/code-context-engine),
[CCE chunker](https://github.com/elara-labs/code-context-engine/blob/75071156e08a145fab17c8ce30bb5f418286f434/src/context_engine/indexer/chunker.py),
[CCE retrieval](https://github.com/elara-labs/code-context-engine/blob/75071156e08a145fab17c8ce30bb5f418286f434/src/context_engine/retrieval/retriever.py),
and [CCE package metadata](https://github.com/elara-labs/code-context-engine/blob/75071156e08a145fab17c8ce30bb5f418286f434/pyproject.toml).

### Source observations relevant to this product

- Chunk IDs are the first 16 hex characters of a hash over path, line range,
  and the first 100 content characters. They are not bound to full source,
  snapshot identity, source side, or grammar version.
- Function/class walking can emit nested overlapping regions, such as a class
  and its methods. When any syntax region exists, ordinary top-level statements
  outside those regions are not emitted as a separate module chunk.
- Current import extraction recognizes a bounded set of grammar node shapes and
  reduces several package imports to a root package name. Normal indexing emits
  file-to-module `IMPORTS` edges; current pipeline source does not resolve these
  into frozen repository paths.
- `CALLS` exists in the edge enum, but current normal indexing path does not
  visibly emit call edges. Documentation therefore describes a stronger graph
  than the inspected indexer currently constructs.
- Retrieval stamps source modification time and uses recency as ranking input.
  Graph expansion failures are deliberately ignored, and expansion adds only a
  small number of related files.
- Vector and FTS stores cap persisted chunk content at 5,000 characters.
  `expand_chunk` reads that stored row, so it cannot return complete source for
  a larger chunk despite being described as full-source expansion.
- Inline compressed search results omit chunk ID and end line. Related-context
  results return node kind, name, and path without edge type, source range, or
  source content. These are discovery hints rather than citation evidence.
- CCE reads and watches a live project, installs Git hooks, and persists a local
  mutable index. Independent Reviewer instead freezes cumulative committed and
  working-tree state into a packet before any review call.

### Inference

CCE solves interactive repository exploration. Independent Reviewer needs an
evidence compiler. CCE's syntax regions, hybrid retrieval, caching, and
progressive disclosure are valuable design references, but its mutable live
index, query-dependent ranking, coarse relation graph, and non-canonical chunk
identity cannot own snapshot coverage or report evidence.

## Foundation comparison

| Foundation | Useful capability | Main limit | Decision |
| --- | --- | --- | --- |
| CCE runtime/MCP | Ready search, expansion, compression, cache, and local UI | Python service over live repository; beta; mutable/query-ranked output; current AST support covers eight languages | Architecture reference and optional future exploration adapter only |
| Tree-sitter | General, fast, error-tolerant concrete syntax trees over supplied bytes | Syntax does not resolve symbol identity; each grammar needs versioning, queries, packaging, and tests | Underlying parser standard behind a thin runtime-neutral adapter |
| `@ast-grep/napi` | Convenient Tree-sitter-backed structural traversal over supplied strings | Experimental Node API includes only HTML, CSS, JavaScript, TypeScript, and TSX by default; other languages need dynamic registration; still syntactic | Do not make core; retain as optional structural-search candidate |
| SCIP | Language-agnostic protocol for definitions, references, implementations, ranges, docs, and relationships | Not an indexer; language-specific producers often require compilers/build systems and may read or mutate live build state | Define optional importer boundary now; implement only after a safe packet/reconstruction design |
| Continue indexing | Content-addressed cache, syntax snippets, full-text index, recursively structured chunks, branch tags | Product implementation is editor-oriented and includes mutable repository indexing | Architecture reference for separate artifact layers and content-addressed reuse |
| Glean | Rich persistent semantic facts, cross-language navigation, and stacked immutable index layers | Database service plus language indexers and build integration are far beyond local packet preparation | Defer until large-monorepo, multi-revision, or cross-language semantic demand justifies it |
| Generic text splitters | Cheap fixed/recursive text windows | Can sever declarations and cannot explain semantic or syntactic relationships | Fallback line windows only, not primary code chunker |

Tree-sitter describes itself as general across programming languages, fast
enough for editor updates, and robust in the presence of syntax errors. It
accepts supplied strings or caller-provided readers and exposes byte plus
row/column ranges, but returns concrete syntax rather than resolved program
semantics. ast-grep's CLI supports many languages, while its Node API defaults
to the five web-language variants above. SCIP is explicitly language-agnostic
and standardizes documents, occurrences, symbols, source ranges, and
relationships; its ecosystem currently lists indexers for JVM languages,
JavaScript/TypeScript, Rust, C/C++, Ruby, Python, .NET, Dart, PHP, and others.

Sources: [Tree-sitter introduction](https://tree-sitter.github.io/tree-sitter/),
[Tree-sitter parsing](https://tree-sitter.github.io/tree-sitter/using-parsers/2-basic-parsing.html),
[ast-grep Node API](https://ast-grep.github.io/reference/api),
[ast-grep CLI languages](https://ast-grep.github.io/reference/languages),
[SCIP overview](https://github.com/scip-code/scip),
[SCIP schema](https://github.com/scip-code/scip/blob/main/docs/scip.md), and
[Continue indexing](https://github.com/continuedev/continue/blob/main/core/indexing/README.md).

## Proposed language-neutral boundary

`ReviewContextMapV1` should be a digest-bound artifact beside the snapshot, not
fields improvised inside a prompt. Core concepts:

```text
SourceRegion
  id
  snapshotDigest
  path
  side: BASE | HEAD
  languageId: string
  kind: FILE | DECLARATION | BLOCK | IMPORT | DIFF_HUNK | LINE_WINDOW
  range: explicit coordinate unit plus offsets, line/column coordinates, and UTF-8 byte length
  contentDigest
  displayName?: string
  analyzer: id + version + grammar id/version
  parseStatus: EXACT | RECOVERED | FALLBACK

ContextRelation
  id
  fromRegionId
  toRegionId? or unresolvedTarget
  kind: ENCLOSES | IMPORTS | REFERENCES | CALLS | IMPLEMENTS | TESTS | CONFIGURES
  certainty: SEMANTIC | SYNTACTIC | HEURISTIC
  provenance: analyzer id/version + source range + explanation code

ReviewUnit
  id
  snapshotDigest
  seedHunkIds
  includedRegionIds
  includedRelationIds
  omittedCandidates with reason
  byte/token measurements
  plannerPolicyVersion
```

Names such as function, class, method, package, and module may appear as adapter
metadata, never as required core variants. A language with different constructs
can still emit `DECLARATION`; a file without declaration syntax still emits
`FILE`, `DIFF_HUNK`, and `LINE_WINDOW` regions.

`LanguageAnalyzerV1` should accept path, side, exact bytes, and content digest,
then return regions and candidate relations without filesystem access. A
separate resolver adapter may convert an unresolved import/reference target
into another frozen region. Analyzer failure returns a typed diagnostic and
fallback regions; it never removes the changed hunk.

Map-level producer records must distinguish `COMPLETE`, `PARTIAL`,
`UNSUPPORTED`, and `FAILED`. An absent relation can then mean “not found by a
successful capability” rather than silently meaning “analysis never ran.”
Semantic, syntactic, and heuristic absence must never be treated as proof that a
dependency or caller does not exist.

## Review-unit planning

Use deterministic graph expansion, not a similarity query:

1. Seed one unit from one changed declaration or a bounded adjacent group of
   changed hunks. Every changed hunk belongs to at least one seed.
2. Add smallest enclosing declaration on BASE and HEAD when available.
3. Add directly imported/referenced declaration contracts whose targets resolve
   inside frozen captured sources.
4. Add directly related changed tests and relevant changed configuration through
   explicit relations.
5. Add canonical requirements and selected rules applicable to included changed
   paths.
6. Pack candidates by fixed tier, certainty, normalized path, side, and range.
   Stop at budget and record omissions.

Unit overlap is acceptable. Hidden omission is not. Runner computes global
coverage from seeds and unit outcomes; reviewers only judge supplied code.

Progressive disclosure can then expose three bounded operations over this frozen
map:

```text
search_context(query, filters, continuation)
expand_region(regionId)
related_context(regionId, relationKinds, depth, continuation)
```

Each result must retain region ID, snapshot digest, path/side/range, relation
provenance, and remaining-budget data. Search output may be ranked; required
unit contents may not be.

## Repository fit

Current architecture already supplies most identity primitives:

- `SnapshotManifestV1` owns frozen path/side content digests and classifications.
- `InitialEvidenceV1` owns digest-bound diff and source-context evidence IDs.
- `buildReviewBrief` is the current all-changed-files evidence compiler and
  therefore the replacement point for unit planning.
- finding validation already resolves path/side against snapshot bytes and
  checks transmitted evidence boundaries.

Current `referenced-sources.ts` is the main language-specific seam: it embeds
ES-module parsing and TypeScript/Node resolution candidates. Preserve its
current behavior as a JavaScript/TypeScript resolver adapter, but move no such
extensions or resolution rules into `ReviewContextMapV1`. Other language
adapters must be able to coexist, and absence of an adapter must remain visible
instead of classifying a file as irrelevant.

Persist context map as a separate packet artifact bound to snapshot digest.
Keep `SnapshotManifestV1` as source truth rather than embedding parser output in
it. Packet metadata binds context-map digest; brief and review-unit plan bind
both snapshot and context-map digests. This permits parser/query upgrades to
invalidate planning and resume without changing captured source identity.

Supporting regions must remain read-only and non-citable. Current citation
guard treats `initialEvidence` as citable changed evidence, so related unchanged
chunks need a separate collection rather than being inserted as
`SOURCE_CONTEXT`.

One prerequisite bug needs correction before graph expansion: changed-file
capture scans content for credential markers before adding blobs, while current
unchanged referenced-source capture does not repeat that content scan. A richer
adapter could therefore broaden secret exposure. Core must apply the same path,
content, size, and exclusion policies to every supporting blob before it enters
the map or packet.

## Fastest high-return implementation slice

1. Define `ReviewContextMapV1`, `LanguageAnalyzerV1`, relation certainty, and
   deterministic planner policy. No parser dependency yet.
2. Implement universal diff-hunk plus bounded-line fallback. Prove every current
   packet can produce stable units before syntax enrichment.
3. Spike exact-pinned official Tree-sitter Node binding plus pinned grammars and
   query packs across TypeScript, Python, Go, and Java: enclosing declarations,
   nested declarations, imports, parse errors, Unicode, generated code, and
   large files. Use only supplied packet strings. Compare native and WASM
   packaging only if Node 24 or target-platform support fails.
4. Compare unit payloads on the existing nine false-positive findings plus
   planted real defects in all four languages. Measure finding precision,
   recall, unsupported coverage, bytes, latency, and cost.
5. Adopt Tree-sitter registry only if output is stable across supported
   platforms, fallback preserves all hunk coverage, and review accuracy
   improves. Pin parser, grammar, and query-pack versions in artifact metadata.
6. Add SCIP ingestion later behind an opt-in analyzer when index generation can
   be isolated from the user checkout and secrets. Never run arbitrary language
   builds merely to prepare a default review.

Start planning with one in-scope changed path as one logical unit, attaching
only direct supporting neighbors. This is simplest invariant and immediately
removes unrelated files from each unit. Keep unit identity separate from
provider-call batching: scheduler may pack several small units into one admitted
call, while responses and runner-owned coverage remain keyed by unit ID. Split a
large path into changed-declaration/hunk units only after baseline is proven.

This sequence gives immediate smaller prompts and auditable related context
without waiting for perfect semantic indexing or narrowing product scope to one
language family.

## Tests and adoption gates

- Same frozen packet and policy produce byte-identical map and unit artifacts.
- Every changed hunk appears in at least one unit exactly as frozen.
- Unknown language, missing grammar, parser crash, error node, and oversized
  declaration all retain diff plus line fallback and explicit diagnostics.
- Relation targets cannot escape snapshot, cross BASE/HEAD accidentally, cite
  excluded bytes, or reference an unknown region.
- Supporting blobs pass same secret-path and secret-content policy as changed
  blobs before persistence or transmission.
- Semantic, syntactic, and heuristic relations never compare as equivalent.
- Unit identity changes when any included bytes, relation, analyzer version, or
  planner policy changes.
- Completion order cannot change units, coverage, or report order.
- TypeScript, Python, Go, and Java corpus fixtures pass on macOS and Linux x64;
  Linux arm64 is required before broad production support is claimed.
- Focused units reject materially more unsupported planted findings than the
  all-files baseline without losing known real defects.

## Facts, observations, and inferences

- **Fact:** Tree-sitter provides multi-language incremental concrete syntax and
  remains useful on erroneous input.
- **Fact:** SCIP standardizes language-neutral semantic occurrences and
  relationships but relies on separate indexers.
- **Observation:** current Independent Reviewer freezes exact bytes and validates
  citations, while current CCE indexes a mutable project and ranks by query and
  recency.
- **Observation:** current repository path classification is already broadly
  multi-language; referenced-source resolution is currently JavaScript and
  TypeScript only and says so explicitly.
- **Observation:** CCE's own monorepo benchmark shows top-10 retrieval can miss
  most relevant files in at least one tested repository.
- **Inference:** similarity search improves exploration but cannot own required
  changed-code coverage.
- **Inference:** syntax chunks plus typed relationship provenance are the
  highest-return next evidence improvement.
- **Inference:** a language-neutral core plus syntax and optional semantic
  adapters avoids both extremes: TypeScript lock-in and a heavyweight universal
  compiler/indexer requirement.

## Confidence and unresolved questions

Confidence: high on architecture boundary and on rejecting CCE retrieval as
coverage authority; medium on Tree-sitter packaging until corpus and native
platform tests run; medium on review-quality gain until replay evaluation.

Unresolved: optimal seed grouping for hunks spanning several declarations;
whether import-only relations are enough for first precision gain; how much
context tests need when no exact semantic reference index exists; safe opt-in
SCIP acquisition for each build ecosystem; and whether interactive search earns
its added provider calls after deterministic units are measured.
