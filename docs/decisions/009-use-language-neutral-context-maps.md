# ADR-009: Use language-neutral context maps and deterministic review units

## Status

Accepted; syntax-backed planning and bounded source-context materialization implemented

## Date

2026-09-10

## Context

Diff capture and path classification fixed avoidable payload waste, but live runs
still gave one reviewer a flat collection of changed evidence and supporting
files. The model had to infer which declaration each change belonged to and
which unchanged contract supported each changed path. Unsupported findings
showed that sending more bytes did not make that inference reliable.

The product must remain language-neutral. A TypeScript-specific AST wrapper
would improve this repository while leaving Python, Go, Java, and other users on
the old path. CCE provides useful chunk/search/expand ideas, but its live mutable
index, ranking-dependent retrieval, and chunk identities do not satisfy frozen
snapshot or exact-coverage requirements.

## Decision

Persist a strict, digest-bound `ReviewContextMapV1` beside each new snapshot
packet. Its core vocabulary is generic: captured file or declaration regions,
BASE/HEAD side, string language ID, exact coordinate unit, producer provenance,
typed relations, and explicit `COMPLETE`, `PARTIAL`, `UNSUPPORTED`, or `FAILED`
producer status. Packet metadata v3 binds the map digest. Inspection verifies
map identity, snapshot identity, and every region against captured content,
including exact offsets, byte length, and line/column coordinates for ranged
regions.
Legacy packet metadata v1/v2 remains readable through a deterministic
file-region fallback map.

Use `web-tree-sitter` WASM behind a runtime-neutral analyzer interface. The
first registry supports JavaScript, TypeScript/TSX, Python, Go, and Java with
exact pinned grammar packages. Every adapter receives captured text and its
digest; none reads the repository. Malformed syntax produces partial regions
plus a diagnostic, not loss of the universal file fallback. Each analyzer emits
at most 512 declaration regions per file. Packet assembly also caps syntax
enrichment at 1,024 regions or 512 KiB of serialized region/relation data;
hitting either bound reports `PARTIAL` while retaining file-level coverage.

Tree-sitter's JavaScript binding reports string indices in UTF-16 code units.
Ranges therefore name `coordinateUnit`, `startOffset`, and
`endOffsetExclusive`; they never mislabel those indices as bytes. Each range
also stores measured UTF-8 `contentByteLength` for deterministic budgets.

Persist a digest-bound `ReviewUnitPlanV1` before provider calls. V1 assigns each
changed path and all its diff evidence exactly once, selects the smallest
enclosing BASE/HEAD declarations when available, attaches direct frozen support
relations under a byte budget, and records every skipped support candidate as a
limitation. Provider batching is separate from coverage ownership.

Send a compact projection of unit, region, relation, and producer metadata in
the blind prompt while retaining the full map and plan locally. Only supporting
sources actually present in the neutral brief can appear in a unit; captured
but budget-dropped relations become explicit limitations. Producer status and
bounded, stable diagnostics keep fallback and parser uncertainty visible
without transmitting raw runtime errors or host paths. Resume
rebuilds and verifies the plan against the frozen packet before reusing the
preliminary assessment.

Unified hunks retain conventional three-line diff context, while the neutral
brief also materializes exact, citable `SOURCE_CONTEXT` windows around changed
BASE and HEAD lines. Windows use a language-neutral 12-line radius, merge when
they overlap, and consume the same initial-evidence budget before unchanged
supporting sources. Budget-dropped windows become explicit evidence constraints
rather than hidden omissions. Review-unit declaration ownership remains seeded
from actual diff lines; supplemental context must not make an adjacent
declaration look changed.

## Consequences

Review input now tells the reviewer which evidence belongs together and names
the exact enclosing declarations without making a model choose coverage.
Unsupported languages retain deterministic file-level units; adding an adapter
does not change orchestration or report contracts.

Reviewers also receive nearby changed-file behavior beyond a unified hunk's
three context lines without receiving an entire large file. Those lines are
part of the digest-bound brief, so existing citation validation can accept or
reject findings against exactly what the reviewer saw.

WASM is about 1.4 times slower than native Tree-sitter in the local synthetic
spike, but absolute parsing time is small beside provider latency. Current
native grammar peer ranges conflict under normal `npm install`; WASM installs
without that resolver override. Grammar packages are large because they include
sources and platform prebuilds, so release packaging may later copy only pinned
WASM assets after a license/update workflow.

This slice does not provide semantic symbol resolution, transitive dependency
expansion, embeddings, or one provider conversation per unit. Direct captured
references remain file-level. SCIP stays the preferred future semantic sidecar;
retrieval ranking may enrich already-covered units but cannot own coverage.

## Validation

Contract tests cover identity, order independence, dangling relations, analyzer
drift, UTF-16/UTF-8 accounting, and budget omissions. Runtime tests parse
JavaScript, TypeScript, Python, Go, and Java, including Unicode identifiers and
recoverable malformed source. Packet tests prove syntax regions are persisted
and tampering is rejected. Orchestrator tests prove the plan is persisted and
included before author disclosure.

Research and spike evidence:
`docs/research/2026-09-10-language-neutral-code-context-evaluation.md`.
