# Steering discovery and author-absence contract research

Status: completed for planning; implementation evidence pending. Decision owner:
project maintainer.

## Executive conclusion

Adopt one product-owned normalized guidance contract with family-specific
discovery adapters. Do not force Codex, Claude, Gemini, Kiro, Copilot, and
Cursor metadata through one assumed glob or import dialect. Preserve supported
native applicability rules, label deliberate product restrictions, and render
cross-family guidance as semantic peers in a deterministic presentation order.

Route every applicable guidance source and imported reference through the
existing snapshot secret policy before artifact creation. Any secret-bearing,
unsafe, or unresolved input needed to construct applicable guidance stops
preflight without persisting or transmitting its bytes.

Define steering thresholds from exact UTF-8 content bytes and exact incremental
serialized wire bytes under the resolved `maxConversationBytes` policy. Use the
existing model-independent token upper bound for repeated-call cost admission.
Represent author opt-out as an explicit digest-bound state in new request,
packet, run-event, and report versions rather than overloading a missing file.

## Decision question

What exact, testable contracts should address independent-review findings about
secret handling, deterministic ordering, harness applicability, steering budget
math, and `--no-author` lifecycle behavior?

Answer matters before implementation because these choices affect snapshot
trust, artifact identity, provider payloads, cost admission, and resume safety.

## Scope and stop condition

Scope is current repository contracts plus official documentation for supported
harnesses and security guidance. No package installation, runtime code change,
provider call, or dependency adoption is authorized by this research.

Stop when each finding has a retained decision, normative behavior, failure
outcome, implementation consequence, and verification gate.

## Method and source index

Repository contracts and capture behavior were inspected at
`99509213bc5e4bec9ef1d5ad735b53cbd325081c` with the six documentation changes
on `codex/plan-friendly-reviewer-ux` present. External claims use current primary
sources:

- Codex instruction discovery: [OpenAI `AGENTS.md` documentation](https://developers.openai.com/codex/guides/agents-md)
- Claude instruction hierarchy, rules, and imports: [Claude Code memory documentation](https://code.claude.com/docs/en/memory)
- Gemini context hierarchy and settings: [Gemini context files](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html) and [configuration](https://google-gemini.github.io/gemini-cli/docs/get-started/configuration.html)
- Gemini imports: [Memory Import Processor](https://google-gemini.github.io/gemini-cli/docs/core/memport.html)
- Gemini ignore behavior: [Gemini ignore documentation](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-ignore.html)
- Kiro paths, inclusion modes, and references: [Kiro steering documentation](https://kiro.dev/docs/steering/)
- Copilot locations, `applyTo`, and imports: [GitHub Copilot CLI custom instructions](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
- Cursor rule types and nested scope: [Cursor rules documentation](https://docs.cursor.com/context/rules)
- Secret handling: [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
- Candidate CLI/input libraries: [`commander`](https://github.com/tj/commander.js) and [`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js)
- Candidate document libraries: [remark](https://github.com/remarkjs/remark),
  [`yaml`](https://github.com/eemeli/yaml), and
  [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser)
- Candidate matching libraries: [`picomatch`](https://github.com/micromatch/picomatch),
  [`braces`](https://github.com/micromatch/braces), and
  [`ignore`](https://github.com/kaelzhang/node-ignore)
- Picomatch security floor:
  [GHSA-3v7f-55p6-f55p](https://github.com/micromatch/picomatch/security/advisories/GHSA-3v7f-55p6-f55p)

## Evidence

### Documented facts

- Codex loads at most one instruction file per directory, preferring
  `AGENTS.override.md`, walks root to working directory, and gives deeper files
  later placement. It excludes machine-global files from a repository-only
  interpretation and has a default combined byte ceiling.
- Claude supports project `CLAUDE.md`, nested `CLAUDE.md`, recursive
  `.claude/rules/**/*.md`, YAML `paths` arrays, and `@path` imports. Imports
  resolve relative to the containing file and recurse to at most four hops.
- Gemini combines hierarchical context files, supports configurable context
  filenames, respects Git and Gemini ignore files by default, and supports
  recursive imports with cycle detection and a default five-level ceiling.
- Kiro workspace steering supports `always`, `fileMatch`, `manual`, and `auto`
  modes. `fileMatchPattern` accepts a string or array; file references use
  `#[[file:...]]`. Kiro also recognizes root and nested `AGENTS.md` files.
- Copilot combines repository instructions without a general cross-source
  precedence, uses comma-separated `applyTo` patterns for modular files, and
  recognizes `.github` instructions plus repository `AGENTS.md`, `CLAUDE.md`,
  `.claude/CLAUDE.md`, and `GEMINI.md`. It expands `@` references only in the
  repository-wide file, `AGENTS.md`, and `CLAUDE.md` locations; references in
  `GEMINI.md` are not expanded.
- Cursor project rules use `.mdc` metadata for always-on, glob-attached,
  agent-selected, and manual modes. Nested `.cursor/rules` directories add
  directory scope, and triggered rules may reference files.
- OWASP recommends least exposure for secrets and says plaintext secrets must
  never be logged.
- Commander 15 is ESM and requires Node.js 22.12 or newer, compatible with this
  repository's Node.js 24 baseline. `@inquirer/prompts` exposes an editor prompt
  using the user's configured editor. Remark supplies typed CommonMark ASTs and
  lint plugins. `yaml` exposes document/parser layers but intentionally recovers
  from malformed input, so product code must inspect errors before accepting its
  AST. `jsonc-parser` exposes positional scanner/visitor APIs suitable for
  bounded duplicate-aware settings parsing.
- `picomatch` supplies widely adopted glob mechanics but affected releases before
  patched 4.0.4, 3.0.2, and 2.3.2 lines cannot be admitted. `braces` supplies
  bounded compilation/expansion controls. `ignore` implements Gitignore-specific
  ordering and negation and explicitly distinguishes those semantics from globs.

### Repository observations

- `src/snapshot/git-capture.ts` applies secret filename and content checks before
  a captured side becomes a transmissible blob. Diagnostics identify policy and
  marker class without needing to retain the credential value.
- `src/contracts/canonical-json.ts` preserves array order. Unspecified discovery
  order can therefore change prompt bytes and digest-bound resume identity.
- `src/orchestrator/two-stage-review.ts` measures conversation limits as exact
  UTF-8 bytes of serialized messages. Its conservative input-token bound counts
  each serialized UTF-8 byte as one possible token and adds 256 units per
  message.
- Current standards request v2 requires an author overview, packet metadata
  binds its digest, and orchestrator expects author packet when building
  final-stage messages. Older request v1 permits absence but does not provide
  explicit new lifecycle required by `--no-author`.

### Inferences

- Guidance capture that bypasses current secret admission creates a new
  exfiltration path even if provider error handling remains credential-safe.
- Cross-family semantic precedence is not supported by vendor documentation;
  deterministic presentation order must therefore be explicitly non-semantic.
- One matcher can supply commodity glob mechanics only after each adapter has
  translated its own frontmatter and path base into a declared normalized
  dialect. Gitignore behavior is a different grammar and should use a qualified
  Gitignore implementation rather than `picomatch`.
- A missing author file is ambiguous between deliberate opt-out, incomplete
  capture, incompatible packet version, and corruption. A discriminated,
  digest-bound state removes that ambiguity.

## Normalized discovery contract

First version supports only deterministic repository-owned behavior from frozen
BASE tree. An adapter takes complete canonical guidance-target set derived from
the frozen snapshot and returns source-to-target applicability records. In the
family table, “changed path” means a target's `applicabilityPath`, not an
unqualified manifest field.

All repository-relative paths use `/`, reject `.`/`..` and absolute forms after
normalization, and compare case-sensitively on every platform. Globs match those
normalized paths from base documented below. Dynamic model-selected and manual
modes are unconditionally excluded in v1. A future explicit-selection feature
requires a new versioned canonical input and is not implied by discovery
enablement or advanced policy.

| Family | Supported BASE sources | Applicability and native order | Supported imports/references | Deliberate first-version limits |
| --- | --- | --- | --- | --- |
| Codex | `AGENTS.override.md`, otherwise `AGENTS.md`, at each ancestor directory of a changed path | At most one per directory; root to changed-file parent | None | Machine-global files and configured fallback filenames excluded |
| Claude | Root or ancestor `CLAUDE.md`, root `.claude/CLAUDE.md`, recursive root `.claude/rules/**/*.md` | Ancestor files broad-to-specific; rules without `paths` apply to all changed paths; `paths` arrays match repository-relative paths | `@path` in `CLAUDE.md`; relative to containing file; maximum four hops | Absolute/out-of-repository imports, local/home policy, `claudeMdExcludes`, and settings-layer merging excluded |
| Gemini | Default `GEMINI.md` names plus safe basename overrides from BASE `.gemini/settings.json` | Root plus all descendant context files that a root-started session would load, ordered by depth then path; BASE Git/Gemini ignores honored when enabled | `@path`; relative to containing file; cycle detection; maximum five levels | Global files, absolute/out-of-repository imports, include directories, environment expansion, and non-basename custom names excluded |
| Kiro | Root and ancestor `AGENTS.md` for each changed path; root `.kiro/steering/**/*.md` | `AGENTS.md` applies to its directory subtree, broad-to-specific; missing/`always` steering applies to all; `fileMatch` applies when any declared pattern matches a changed path | `#[[file:...]]` in Kiro steering, relative to containing file | Kiro-specific inclusion metadata does not apply to `AGENTS.md`; `manual` and `auto` steering unconditionally excluded in v1; global/cloud steering excluded |
| Copilot | Root `.github/copilot-instructions.md`; root `.github/instructions/**/*.instructions.md`; root and ancestor `AGENTS.md` and `CLAUDE.md` for each changed path; root `.claude/CLAUDE.md`; root and ancestor `GEMINI.md` for each changed path | Repository-wide and root agent files apply to all; ancestor agent files apply to their directory subtree; modular file requires comma-split `applyTo`; `excludeAgent: code-review` excludes it | Recursive `@path` in `.github/copilot-instructions.md`, `AGENTS.md`, and every supported `CLAUDE.md` location; relative, in-repository, product maximum five hops; `GEMINI.md` references remain opaque text | User/custom directories and imports from modular instruction files excluded |
| Cursor | Root and nested `.cursor/rules/**/*.mdc` | `alwaysApply: true` applies within nested directory scope; non-empty `globs` additionally path-match; agent-requested/manual modes excluded | `@filename` in an included rule, relative to containing rule | User/team rules, legacy `.cursorrules`, and model relevance selection excluded |

After applicability filtering for one target, each family assigns
`nativeOrder` as zero-based position in this exact presentation sequence. These
ranks are deterministic product presentation, not added semantic precedence:

| Family | Applicable-source sequence for one target |
| --- | --- |
| Codex | Selected ancestor instruction files from repository root to changed-file parent |
| Claude | Ancestor `CLAUDE.md` root-to-parent; root `.claude/CLAUDE.md`; applicable `.claude/rules` by normalized path |
| Gemini | Applicable context files by directory depth, then normalized path |
| Kiro | Ancestor `AGENTS.md` root-to-parent; applicable `.kiro/steering` files by normalized path |
| Copilot | `.github/copilot-instructions.md`; ancestor `AGENTS.md` root-to-parent; ancestor `CLAUDE.md` root-to-parent; root `.claude/CLAUDE.md`; ancestor `GEMINI.md` root-to-parent; applicable modular instructions by normalized path |
| Cursor | Applicable rules by enclosing-directory depth, then normalized path |

Depth and integer comparisons are numeric; all path tie-breaks use ECMAScript
UTF-16 code-unit order. A source applicable to several targets receives a
separate recognition and `nativeOrder` for each target.

BASE `.gemini/settings.json` is data for Gemini adapter only. Recognized fields
are `context.fileName`, `context.fileFiltering.respectGitIgnore`, and
`context.fileFiltering.respectGeminiIgnore`. Strings must be bounded basenames;
unknown settings are ignored and shown, while malformed recognized fields stop
that adapter before provider access.

Supported conditional glob fields are parsed according to native shape, then
matched with one product dialect: POSIX separators, repository-relative base,
case-sensitive comparison, `*`, `**`, `?`, bracket expressions, and brace
expansion where native family documents it. Empty, invalid, or over-limit
patterns fail applicable-source preflight. Tests, not matcher package name, are
normative oracle.

Gemini `.gitignore`/`.geminiignore` inputs retain Gitignore ordering, directory
anchoring, comments, and negation. `ignore` is a candidate for that commodity
grammar, subject to parity fixtures against Git. This is distinct from earlier
rejection of `ignore` as capture authority: native Git remains capture authority.

### Snapshot-to-guidance target projection

Guidance applicability is derived from `SnapshotPathEntryV1` before any adapter
runs. One strict `GuidanceTargetV1` contains:

```text
{
  targetId,
  manifestPath,
  applicabilityPath,
  side,
  role,
  changeType
}
```

`manifestPath` is the owning entry's `path`. `applicabilityPath` is the path used
for ancestor discovery and glob matching. `side` is `BASE` or `HEAD`; `role` is
`PRIMARY` or `RELOCATION_SOURCE`; and `changeType` repeats the owning manifest
entry's closed change type. `targetId` is `guidance_target_<digest>` over
canonical JSON of `{ schemaVersion: 1, snapshotDigest, manifestPath,
applicabilityPath, side, role, changeType }`.

Projection is exact:

| Snapshot change type | Canonical guidance targets | Reason |
| --- | --- | --- |
| `ADDED`, `UNTRACKED` | one `HEAD` / `PRIMARY` target at `path` | Result exists only at destination |
| `DELETED` | one `BASE` / `PRIMARY` target at `path` | Removed file exists only in BASE |
| `MODIFIED`, `TYPE_CHANGED` | one `HEAD` / `PRIMARY` target at `path` | BASE and HEAD share path; one applicability evaluation avoids duplicate authority |
| `RENAMED` | one `BASE` / `RELOCATION_SOURCE` target at `previousPath` and one `HEAD` / `PRIMARY` target at `path` | Review covers removal from old scope and result in new scope |
| `COPIED` | one `HEAD` / `PRIMARY` target at `path` | Retained source is comparison context, not a changed target; a separately modified source has its own manifest entry |

Targets sort and deduplicate by `applicabilityPath`, `side`, `role`,
`manifestPath`, `changeType`, then `targetId`, all textual comparisons in UTF-16
order. The target array must equal fresh projection from the digest-bound
manifest: missing, extra, differently sided, or differently roled targets fail
before discovery. Prompt provenance renders target role and side so guidance for
a rename source cannot appear to govern only its destination. Tests cover moves
and copies across nested guidance scopes, same-directory relocations, additions,
deletions, modified copy sources, and adapter-order permutations.

Every target, including a HEAD destination, is matched only against guidance
content from frozen BASE. Destination path may be absent from BASE; adapters walk
its lexical ancestors and evaluate its normalized path against whatever BASE
guidance exists there. A newly added destination directory or HEAD-only steering
cannot authorize itself.

## Normative discovery resource limits

First-version limits are protocol constants, not advanced-policy overrides. A
limit is inclusive unless stated otherwise. Except for diagnostic retention,
which has the deterministic compaction rule below, exceeding one produces
`GUIDANCE_DISCOVERY_LIMIT_EXCEEDED`, stops guidance preflight before provider or
credential access, and does not continue with partial authority:

| Resource | Limit |
| --- | ---: |
| Snapshot change entries admitted to guidance discovery | 4,096 entries |
| Canonical guidance targets after relocation projection | 8,192 targets |
| Unique target applicability paths | 8,192 paths |
| Recognized direct-source candidates before applicability filtering | 4,096 paths |
| Applicable canonical source nodes, including import-only nodes | 256 nodes |
| Canonical direct-recognition records | 65,536 records |
| Canonical source/applicable-target pairs | 65,536 pairs |
| Normalized repository path | 4,096 UTF-16 code units |
| Import/reference requested specifier | 1,024 UTF-16 code units |
| One guidance content blob admitted for parsing | 64 KiB UTF-8 |
| Gemini configured context basenames | 8 names, 128 UTF-8 bytes each |
| `.gemini/settings.json` | 64 KiB UTF-8, 16 nesting levels, 256 JSON nodes |
| Frontmatter per guidance source | 16 KiB UTF-8, 16 nesting levels, 256 YAML nodes |
| Conditional patterns per source | 64 patterns, 512 UTF-8 bytes each |
| Brace syntax per pattern | 8 groups and computed expansion product at most 256 |
| Compiled matcher alternatives per source | 1,024 alternatives |
| Import/reference occurrences for one source and family | 32 occurrences |
| Canonical import/reference occurrences in one review | 2,048 occurrences |
| Expanded import/reference edges in one review | 512 edges |
| Repository-internal symlink chain | 16 links |
| Persisted guidance diagnostics | 256 entries |

Pattern expansion product is computed with saturating integer arithmetic before
expansion, so rejected input cannot allocate its expanded set. YAML aliases,
custom tags, duplicate keys, and merge keys are rejected; JSON duplicate keys
are rejected before conversion to plain data. Node counts include mapping keys,
mapping values, and sequence elements. Family import-depth ceilings of four or
five hops remain lower independent limits.

Cap identities are exact. Snapshot entries count unique manifest `path` values;
targets count unique `targetId` values; applicability paths count unique
normalized target `applicabilityPath` values. Direct candidates count unique
normalized `discoveredPath` values before
symlink resolution; the same candidate found by several adapters counts once.
Recognitions count unique complete recognition tuples. Nodes count unique
`sourceId` values after resolved-path/digest merging. Applicability counts unique
`(sourceId, targetId)` pairs. Occurrences count unique `occurrenceId` values;
the per-source/family occurrence cap counts syntax matches before canonical
deduplication because parsing consumed that work. Expanded edges count unique
`edgeId` values. Separate family occurrences and separate target edges
therefore consume separate capacity. Declared pattern
entries and their computed alternatives count before duplicate elimination
because each consumes parser/matcher work. Diagnostics count unique complete
diagnostic records.

Canonical sets may retain at most the limit plus one overflow sentinel while
being constructed; exceeding a stopping cap stops further content reads and
produces no partial graph. Fatal discovery diagnostics persist only in the
runner-owned preflight/run-attempt record, never in a partial `GuidanceGraphV1`.
Diagnostic retention is the sole non-fatal exception: when more than 256 warning
or exclusion diagnostics exist, retain the first 255 by the canonical diagnostic
sort below, plus one `DIAGNOSTIC_LIMIT_EXCEEDED` summary containing total omitted
count and no source content. Tests cover below, exactly-at, and above every cap,
including diagnostic compaction, plus wide/deep YAML, JSON, brace, import,
symlink, and multi-family adversarial cases.

These are product safety limits, not claimed harness limits. The 4,096-unit
repository-path cap matches `SnapshotPathV1Schema`; the tighter 1,024-unit limit
applies only to untrusted import specifier text. The 64 KiB source cap matches
the aggregate steering stop threshold. Remaining caps bound graph and parser
work before aggregate byte admission while leaving ample room for normal
repository guidance. Changing any value requires a versioned contract update
and new boundary evidence.

## Complete serialized guidance-graph contract

`GuidanceGraphV1` is a strict object with no unknown fields:

```text
{
  schemaVersion: 1,
  graphId,
  snapshotDigest,
  baseCommit,
  targets[],
  nodes[],
  occurrences[],
  edges[],
  diagnostics[]
}
```

`snapshotDigest` is the complete frozen manifest identity. `baseCommit` is the
frozen lowercase 40- or 64-hex Git object ID and must equal that manifest's BASE.
`targets` is the exact sorted projection defined above. `nodes` sorts by
`sourceId`, `occurrences` by `occurrenceId`, `edges` by `edgeId`, and diagnostics
by `code`, nullable `path` (null first), nullable numeric `startUtf16` (null
first), then `diagnosticId`. Every text comparison uses ECMAScript UTF-16 code
units; numeric fields compare numerically.

Every digest below is the existing `DigestV1` SHA-256 over UTF-8 RFC 8785/JCS
serialization from `digestCanonicalJson`; identifier suffixes use its lowercase
hex `value`. `graphId` is `guidance_<digest>` over every graph field except
`graphId`. Implementation must extend and reuse the shared identifier primitive
rather than declare a local lookalike. Validation rejects unsorted arrays,
duplicates, dangling references, unknown enum values or fields, false derived
values, and any recomputed ID or digest mismatch before prompt construction or
resume. Timestamps, adapter order, filesystem order, and host paths never enter
this artifact or an identity input.

### Source nodes and direct recognitions

One strict `GuidanceSourceNodeV1` serializes:

```text
{
  sourceId,
  resolvedPath,
  contentDigest,
  semanticTier,
  applicableTargetIds[],
  directRecognitions[]
}
```

`sourceId` is `guidance_source_<digest>` over canonical JSON of
`{ schemaVersion: 1, baseCommit, resolvedPath, contentDigest }`. Content remains
in one separately digest-verified blob addressed by `contentDigest`, which is a
strict `DigestV1`. `resolvedPath`, `discoveredPath`, and every target path use
the existing `SnapshotPathV1Schema`. Loading or resuming requires exactly one
matching blob; missing or digest-mismatched content fails before prompt
construction. `applicableTargetIds` is a sorted unique UTF-16 identifier vector
exactly equal to the derived union described below. Nodes serialize in
`sourceId` order, independent of prompt presentation.

Node has no singular `sourceKind`; kind belongs to each direct recognition, so
multi-family and direct-plus-import merging cannot overwrite it. One strict
direct recognition is:

```text
{
  familyId,
  sourceKind,
  nativeOrder,
  applicableTargetId,
  discoveredPath
}
```

`familyId` is one of `CODEX`, `CLAUDE`, `GEMINI`, `KIRO`, `COPILOT`, `CURSOR`,
or `INDEPENDENT_REVIEWER`. `sourceKind` is one of
`CODEX_AGENTS`, `CODEX_AGENTS_OVERRIDE`, `CLAUDE_MD`,
`CLAUDE_DOT_CLAUDE_MD`, `CLAUDE_RULE`, `GEMINI_CONTEXT`, `KIRO_AGENTS`,
`KIRO_STEERING`, `COPILOT_REPOSITORY`, `COPILOT_MODULAR`, `COPILOT_AGENTS`,
`COPILOT_CLAUDE`, `COPILOT_DOT_CLAUDE`, `COPILOT_GEMINI`, `CURSOR_RULE`, or
`REVIEWER_RULES`. Invalid family/kind combinations fail validation.

Allowed combinations are closed: `CODEX` uses `CODEX_AGENTS` or
`CODEX_AGENTS_OVERRIDE`; `CLAUDE` uses `CLAUDE_MD`,
`CLAUDE_DOT_CLAUDE_MD`, or `CLAUDE_RULE`; `GEMINI` uses `GEMINI_CONTEXT`;
`KIRO` uses `KIRO_AGENTS` or `KIRO_STEERING`; `COPILOT` uses
`COPILOT_REPOSITORY`, `COPILOT_MODULAR`, `COPILOT_AGENTS`, `COPILOT_CLAUDE`,
`COPILOT_DOT_CLAUDE`, or `COPILOT_GEMINI`; `CURSOR` uses `CURSOR_RULE`; and
`INDEPENDENT_REVIEWER` uses `REVIEWER_RULES`.

Every applicable direct `(family, source kind, target ID, discovered path)`
produces one recognition with that family's table-derived `nativeOrder`.
Recognitions sort and deduplicate by the canonical key `familyId`, numeric
`nativeOrder`, `applicableTargetId`, `discoveredPath`, then `sourceKind`.
Across the complete graph, recognition slot `(familyId, applicableTargetId,
discoveredPath)` must identify exactly one `sourceId`, `sourceKind`, and
`nativeOrder`. Identical complete records collapse; disagreement in any slot is
`GUIDANCE_RECOGNITION_CONFLICT`, not last-writer wins. BASE
`.independent-reviewer/rules.md` emits one `INDEPENDENT_REVIEWER` /
`REVIEWER_RULES` recognition per target, always with native order zero.

`semanticTier` is derived, never adapter-selected: `REVIEWER_SPECIFIC` exactly
when node contains a `REVIEWER_RULES` recognition; otherwise `REPOSITORY_PEER`.
An imported reference to reviewer rules may add provenance but cannot raise or
lower authority. Import-only nodes are `REPOSITORY_PEER`.

### Import occurrences and expanded edges

Import parsing first emits strict syntax occurrences, separate from applicability:

```text
{
  occurrenceId,
  familyId,
  syntaxKind,
  importerSourceId,
  requestedSpecifier,
  startUtf16,
  endUtf16
}
```

`syntaxKind` is one of `CLAUDE_AT_PATH`, `GEMINI_AT_PATH`,
`KIRO_FILE_REFERENCE`, `COPILOT_AT_PATH`, or `CURSOR_AT_FILENAME` and must match
`familyId`: respectively `CLAUDE`, `GEMINI`, `KIRO`, `COPILOT`, or `CURSOR`.
`CODEX` and `INDEPENDENT_REVIEWER` emit no occurrences in v1. After family
syntax decoding, `requestedSpecifier` preserves code units except that `\\` path
separators become `/`; line breaks are invalid. It
may contain relative `..` segments, while absolute, NUL-bearing, or
repository-escaping resolution still fails. Offsets form a non-empty half-open
UTF-16 range inside digest-bound importer content and select the raw source token
whose family-decoded and separator-normalized value equals
`requestedSpecifier`. `occurrenceId` is `guidance_occurrence_<digest>` over
canonical JSON of every field except `occurrenceId`. Identical occurrence
records collapse. One physical span recognized under two families is two
occurrences; repeated textual imports at different spans remain distinct.

Applicability expansion emits strict edges:

```text
{
  edgeId,
  occurrenceId,
  importedSourceId,
  applicableTargetId
}
```

`edgeId` is `guidance_edge_<digest>` over canonical JSON of every
field except `edgeId`. For each occurrence, compute sorted unique family-specific
applicable targets on importer: direct recognition target IDs with same
`familyId` plus target IDs on its inbound edges whose occurrence has same
`familyId`. Emit exactly one edge for every
`(occurrenceId, importedSourceId, applicableTargetId)`. Thus one occurrence
applicable to N targets creates N edges; same syntax
recognized by F families has F occurrence records and corresponding expansions.
Exact duplicate edges collapse; any same occurrence/target resolving to different
source IDs is `GUIDANCE_IMPORT_RESOLUTION_CONFLICT`.

Resolve each occurrence to one BASE node before expansion; zero targets is
unresolved and more than one distinct target is
`GUIDANCE_IMPORT_RESOLUTION_CONFLICT`. Expand in fixed-point rounds over
canonically sorted occurrences and paths until no edge is added. For each
family/target expansion, deterministic depth-first ancestry tracks
`(familyId, sourceId, applicableTargetId)`; encountering an active tuple is a
cycle and fails applicable-source preflight. Family hop limits, total
occurrence/edge caps, and symlink cap apply independently. Validation requires
every occurrence importer and every edge occurrence/imported source to exist,
requires each edge target to belong to graph `targets`, recomputes closure
against frozen BASE, and rejects both missing and extra derived edges.

Node `applicableTargetIds` is derived after expansion as sorted unique union of
its direct-recognition target IDs and inbound-edge target IDs. Direct and imported
resolution of same BASE `resolvedPath` and content digest always shares one
`sourceId`, one node, and one blob; recognitions and edges remain separate sorted
provenance. Same resolved path with a different digest is impossible within one
BASE snapshot and fails identity verification if presented.

### Diagnostics

One strict `GuidanceDiagnosticV1` serializes all fields, using null rather than
omission for inapplicable values:

```text
{
  diagnosticId,
  code,
  severity,
  path,
  startUtf16,
  omittedCount
}
```

`code` is one of `UNSELECTED_MANUAL_MODE`,
`UNSELECTED_MODEL_SELECTED_MODE`, `EMPTY_SOURCE`,
`UNKNOWN_SETTING_IGNORED`, `MARKDOWN_SYNTAX_WARNING`,
`MARKDOWN_STYLE_WARNING`, or `DIAGNOSTIC_LIMIT_EXCEEDED`. `severity` is derived:
the two `UNSELECTED_*` codes use `EXCLUSION`; all others use `WARNING`. Fatal
diagnostics do not enter a graph. `path` is a normalized repository path or null; `startUtf16` is a
nonnegative integer or null and is valid only with a path. `omittedCount` is a
positive integer only for `DIAGNOSTIC_LIMIT_EXCEEDED` and null otherwise; that
summary alone has null path and position. `diagnosticId` is
`guidance_diagnostic_<digest>` over canonical JSON of every field except the ID.
Diagnostics never store source excerpts, secret values, setting values,
exception stacks, host paths, or adapter-order data. Exact duplicates collapse
by `diagnosticId` before retention and sorting.

### Canonical prompt presentation

Prompt node key is semantic tier (`REPOSITORY_PEER` before
`REVIEWER_SPECIFIC`), origin rank (`0` with direct recognitions, otherwise `1`),
complete direct-recognition vector, `resolvedPath`, then `sourceId`. Vector
comparison uses the canonical recognition key defined above and places shorter
equal prefix first. Import-only peer nodes therefore render after direct peer
nodes by path and identity; reviewer rules always render last.

Within each block, recognitions use canonical recognition order. Inbound edges
sort by their occurrence's `familyId`, `importerSourceId`, numeric `startUtf16`,
numeric `endUtf16`, `requestedSpecifier`, `applicableTargetId`, then `edgeId`.
Import markers reference `sourceId`; content for each node renders once per
provider payload. Direct-plus-import content remains in direct-node position.
Same source sent in another model call is counted again.

### Cross-artifact binding and resume

`guidanceGraphDigest` is the strict `DigestV1` whose value is the digest suffix
of `graphId`. Internal graph validation is necessary but not sufficient: the
exact graph must also be cross-bound through every persisted and transmitted
identity that can outlive one process.

The first guidance-capable protocol versions use this chain:

1. Build graph from one verified snapshot manifest. Require graph
   `snapshotDigest` and `baseCommit` to equal manifest identity before writing
   any graph or guidance blob.
2. Store `guidance-graph.json` inside snapshot packet and reuse packet's
   content-addressed blob store for admitted source content. `PacketMetadataV4`
   stores `guidanceGraphDigest` beside context-map and author bindings.
3. `NeutralReviewBriefV3` stores
   `{ graphId, guidanceGraphDigest }` and exact canonical prompt presentation;
   its `briefDigest` identity payload includes both. A graph is never loaded by
   mutable path without checking packet binding first.
4. `RUN_STARTED` stores `guidanceGraphDigest` and exact new prompt/result protocol
   versions; runner-owned final report metadata repeats graph digest. Provider
   candidates do not repeat runner-owned identity fields.
5. Existing `CALL_STARTED.inputDigest` continues to digest the complete provider
   request, including exact rendered guidance and prompt version. Retried
   application request input is byte-identical; separately recorded
   transport-routing audit fields may differ under existing retry policy.
6. Final-stage resume re-reads packet, verifies manifest, graph, every referenced
   blob, packet metadata, and brief; rebuilds graph, brief, plan, and provider
   messages; then requires exact equality with persisted artifacts plus
   `RUN_STARTED.guidanceGraphDigest`, `briefDigest`, plan/context/config digests,
   prompt/result versions, and relevant prior `CALL_STARTED.inputDigest` values.

Replacing graph with another self-consistent graph, replacing one source blob
and recomputing graph, removing graph, or mixing old/new packet, brief, event,
prompt, result, or report versions fails locally before another provider call.
Tests cover those substitutions after preliminary persistence and after a
definite resumable final-stage 429. Existing packets remain readable under their
own protocol; they are never silently upgraded into guidance-capable resume.

## Failure contract

- Manual or model-selected sources are respectively `UNSELECTED_MANUAL_MODE` or
  `UNSELECTED_MODEL_SELECTED_MODE` and visible; v1 provides no override and they
  do not fail preflight.
- Empty source files are `EMPTY_SOURCE` warnings unless a supported applicable
  file imports them, in which case import resolution fails.
- Malformed recognized frontmatter, invalid/over-limit globs, unresolved imports,
  import cycles/depth overflow, unsupported absolute/out-of-repository imports,
  and external symlink targets stop preflight when they affect an otherwise
  applicable source.
- Repository-internal symlink chains may resolve only through BASE entries, must
  remain inside repository, and use bounded cycle/depth checks.
- Every applicable root and imported/reference file passes existing secret
  filename and content policy before artifact creation. Secret-path rejection or
  content marker stops preflight, records path plus policy/marker class only,
  and creates no content blob, prompt excerpt, packet field, or provider request.
- Changed HEAD guidance remains review-target evidence subject to normal capture
  policy; it never substitutes for BASE authority.

## Exact steering-budget contract

Definitions use integer arithmetic and current engine measurements:

- `contentBytes`: sum of exact UTF-8 byte lengths for canonical included source
  content, each source counted once after within-payload deduplication.
- `wireBytes(stage)`: exact UTF-8 byte length of serialized provider messages
  with guidance minus same stage skeleton without guidance. This includes JSON
  escaping, source labels, provenance, separators, and wrappers.
- `capacityBytes`: resolved `budgets.maxConversationBytes`. A simple model
  profile resolves this to a value safe for primary and every fallback; advanced
  JSON supplies one common authoritative cap.
- `tokenUnits(stage)`: existing conservative input-token upper bound with
  guidance minus same bound without guidance.

Default warning occurs at or above 32 KiB `contentBytes` or when any possible
stage has `10 * wireBytes(stage) >= capacityBytes`. Default stop occurs at or
above 64 KiB or when any stage has
`5 * wireBytes(stage) >= capacityBytes`. Stop wins over warning. No floating
point or rounded display value participates in admission.

Initial preflight reserves `tokenUnits(stage)` for preliminary, possible finding
verifier, final, and one largest permitted provider retry. It does not reserve a
repair call. Inspection displays each configured repair's maximum incremental
exposure and total possible repair exposure, clearly labeled `on-demand`, beside
the initially reserved amount. Immediately before each repair, admission
recomputes the actual repair messages and schema against remaining conversation,
token, and cost capacity. A repair request cannot be sent when that check fails.
Source bytes deduplicate only inside one payload, never across separate provider
requests. Existing total token, total cost, per-call output, and conversation
checks remain independent hard backstops.

Minimum steering admission ships with first transmissible guidance slice.
Automatic harness discovery and richer lint may follow later, but no live path
may send Markdown guidance before secret, content-byte, wire-ratio,
conversation, token, and cost checks pass.

## Explicit author-absence lifecycle

New friendly-review request and packet versions use a discriminated author
context state:

```text
PROVIDED -> separate author artifact plus canonical digest
DECLINED -> canonical { schemaVersion, status: "DECLINED" } marker digest
```

Packet metadata always binds status and digest. `PROVIDED` requires matching
separate author artifact; `DECLINED` forbids one. Local inspection may show
status before spending, but blind and finding-verification provider inputs show
neither presence nor absence. After preliminary persistence and optional
finding verification, one versioned `AUTHOR_CONTEXT_RELEASED` transition sends
either author packet or explicit declined marker to final reconciliation.

A declined final report records a typed runner-owned value such as
`authorContext: { status: "DECLINED", noteCode:
"AUTHOR_CONTEXT_DECLINED" }` and an empty author claim ledger. Renderer turns
the code into a non-blocking note that no author claims were evaluated. The note
does not enter the formal `limitations` array, because current report validation
correctly prevents `READY` and `READY_WITH_FOLLOW_UPS` when that array is
non-empty. Author absence alone therefore does not select a verdict; evidence
coverage, findings, unresolved preliminary concerns, and true limitations do.
Resume requires matching request, packet, prompt, result, run-record versions,
author status, and author digest. Existing runs retain existing schemas; old and
new lifecycle artifacts cannot be mixed or silently upgraded.

## Option comparison

| Decision area | Selected | Rejected alternative | Reason |
| --- | --- | --- | --- |
| Secret response | Stop applicable guidance preflight | Silently omit and continue | Missing authoritative context could create false confidence; secret bytes must not persist |
| Cross-family order | Stable non-semantic presentation plus explicit tiers | Filesystem enumeration or invented family authority | Preserves deterministic identity without claiming vendor-backed precedence |
| Harness matching | Family adapters into one normalized path model | One undifferentiated `picomatch` parser | Native metadata shapes, roots, ignores, and imports differ |
| Relocation applicability | Typed snapshot-derived targets; rename old+new, copy destination only | Unqualified changed-path set | Preserves removal/destination scope without treating retained copy source as changed |
| Resume binding | Graph digest cross-bound through packet, brief, run, call, report, and resume | Validate graph only in isolation | Prevents replacement with another internally valid graph between stages |
| Dynamic/manual modes | Unconditionally exclude in v1 | Promise selection without canonical input | Avoids an undefined control surface and unstable review identity |
| Commodity mechanics | Qualified libraries behind product adapters | Hand-written parsers and matchers | Reduces grammar and maintenance risk while retaining product semantics locally |
| Threshold ratio | Exact incremental serialized bytes / resolved conversation bytes | Tokenizer-specific percentage | Existing hard cap is model-independent and exact; routed tokenizers differ |
| Author opt-out | Explicit versioned `DECLINED` artifact state | Missing optional file | Removes corruption/intent ambiguity and makes resume compatibility testable |

## Confidence, limitations, and next gate

Confidence is high for source locations, supported metadata shapes, secret
boundary, ordering need, budget arithmetic, and explicit author-state design.
Confidence is medium for perfect behavioral parity with every harness release;
official documentation leaves some conflict and matcher details unspecified.
Normalized contract therefore owns exact behavior and exposes deliberate limits
rather than claiming byte-for-byte harness emulation.

Independent review loop completed at maintainer-authorized instance 5 of 5.
Graph-to-run binding, relocation projection, unsupported-mode selection, and
diagnostic findings are incorporated above; no sixth review starts. Next gate is
maintainer acceptance, then Slice 1 implementation. Dependency versions remain
unselected until each implementation slice completes repository admission
checklist and fixture spike.
