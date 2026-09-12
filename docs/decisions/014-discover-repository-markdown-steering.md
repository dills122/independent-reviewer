# ADR-014: Discover repository Markdown as review guidance

## Status

Accepted

## Date

2026-09-11

## Context

Standards mode currently requires users to translate project guidance into a
structured JSON profile containing rule IDs, enforcement, paths, exceptions,
references, and bindings. Popular coding-agent harnesses already ask repository
owners to maintain persistent guidance as Markdown. Requiring a second semantic
copy creates setup friction and drift.

The common harness conventions are repository-wide guidance, nested or
path-scoped guidance, and readable source attribution:

- [OpenAI Codex](https://developers.openai.com/codex/guides/agents-md) uses
  `AGENTS.md` and `AGENTS.override.md` from repository root toward the working
  directory.
- [Claude Code](https://code.claude.com/docs/en/memory) uses `CLAUDE.md`,
  `.claude/CLAUDE.md`, and path-scoped `.claude/rules/**/*.md`.
- [Gemini CLI](https://google-gemini.github.io/gemini-cli/docs/cli/gemini-md.html)
  uses hierarchical `GEMINI.md` files.
- [Kiro](https://kiro.dev/docs/steering/) uses `.kiro/steering/**/*.md` with
  inclusion metadata and also recognizes repository `AGENTS.md` guidance.
- [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)
  uses `.github/copilot-instructions.md`, path-scoped instruction files,
  `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md`, and `GEMINI.md`.
- [Cursor](https://docs.cursor.com/context/rules) uses project and nested rules
  under `.cursor/rules`.

Repository guidance is still untrusted evidence. The proposed change must not
rewrite the authority used to judge itself, and personal home-directory guidance
would make a review private and irreproducible.

## Decision

Discover supported repository steering from the frozen BASE tree. Apply
documented family-specific directory, frontmatter, glob, ignore, and import
rules to the complete canonical guidance-target set projected from snapshot
entries. Normalize only the deterministic subset
defined in the
[steering contract research](../research/2026-09-11-steering-and-author-absence-contract.md);
do not claim complete harness emulation. Do not load global or home-directory
guidance by default. Added or changed steering remains a review target, but its
HEAD content does not govern that same review.

Initial discovery recognizes:

```text
AGENTS.md
AGENTS.override.md
CLAUDE.md
.claude/CLAUDE.md
.claude/rules/**/*.md
GEMINI.md
.kiro/steering/**/*.md
.github/copilot-instructions.md
.github/instructions/**/*.instructions.md
.cursor/rules/**/*.mdc
```

Only deterministic always-on and path-matched inclusion modes apply
automatically. Manual and model-selected modes remain visible but are
unconditionally excluded in v1. Explicit selection is deferred to a future
versioned canonical-input contract; no current setting or advanced-policy field
enables it. Machine-global files, model relevance, and external imports do not
affect default review identity.

Target projection is part of canonical identity. Added, untracked, modified, and
type-changed entries use destination `path`; deleted entries use BASE `path`;
renames use both BASE `previousPath` as `RELOCATION_SOURCE` and HEAD destination
`path` as `PRIMARY`; copies use only HEAD destination because retained source is
comparison context rather than a changed target. Exact target fields, ordering,
and validation are normative in linked research contract.

An optional repository file at `.independent-reviewer/rules.md` is the final and
highest-priority guidance source. Its content is not a special policy language.
Headings such as “Hard stops” express instructions to the reviewer but do not
create runner-enforced semantics. When guidance conflicts, the prompt tells the
reviewer to follow this file; otherwise different harness families are peer
sources and the reviewer must surface any apparent semantic ambiguity.

Semantic priority and presentation order are separate. Harness sources use
`REPOSITORY_PEER`; reviewer-specific rules use `REVIEWER_SPECIFIC`. Prompt
serialization and presentation are separate. One strict `GuidanceGraphV1`
artifact binds snapshot digest and BASE commit and stores sorted unique targets,
source nodes, syntax occurrences, expanded edges, and diagnostics. Its identifier
digests canonical JSON of the complete graph. Target, node, occurrence, and edge identifiers independently digest
their exact versioned identity inputs using existing RFC 8785/JCS and digest
primitives. Persisted arrays must already be in their declared canonical order;
validation rejects duplicates, dangling references, false derived fields,
missing or extra targets/closure edges, and identifier drift before prompt construction
or resume. Guidance identifiers extend the shared identifier primitive; contract
modules must not duplicate its validation.

Internal graph validity does not substitute for cross-artifact binding. Packet
metadata stores `guidanceGraphDigest`; neutral brief identity includes graph ID,
digest, and exact prompt presentation; `RUN_STARTED`, provider input digests, and
runner-owned final report metadata bind same digest. Resume rebuilds graph,
brief, plan, and messages from verified packet and requires exact equality with
packet metadata, run ledger, prompt/result versions, and prior call identity.
Self-consistent graph or blob replacement fails before provider access.

Source kind belongs to each direct recognition rather than one mutable node
field. Direct and imported discovery of one resolved BASE path and digest merges
into one node and blob while preserving every sorted recognition, occurrence,
edge, and applicable target. One syntactic occurrence expands to exactly one edge
per family-specific applicable target. Multi-family recognition creates
separate family occurrences and edges. Graph closure, edge multiplicity, kind
merging, cap counting, cycle identity, and every array comparison are normative
in the linked research contract.

Prompt presentation sorts by semantic tier, direct/import-only origin rank,
complete canonical direct-recognition vector, resolved path, then source
identity. Direct peer nodes render first, import-only peer nodes render next,
and reviewer-specific rules render last. Stable peer order never grants semantic
priority. This prevents filesystem, adapter, or graph traversal order from
changing provenance, prompt bytes, artifact digests, or resume identity.

Markdown documents remain opaque guidance. The runner records source path,
BASE digest, applicable target roles/sides, source family, and prompt precedence. It
may record source positions for citations, but it does not infer enforcement,
exceptions, or rule meaning from prose. A future Markdown-guidance contract must
be versioned separately from the existing structured standards profile rather
than weakening that profile in place.

Format linting is deliberately narrow: readable UTF-8, non-empty documents,
parseable supported frontmatter, valid bounded declared globs, supported
inclusion modes, and resolvable supported local imports. Style findings such as
heading structure are warnings. Lint never judges whether a policy is good,
complete, or internally correct.

Every applicable root and imported/reference file passes the existing snapshot
secret filename and content policy before artifact creation. Secret-bearing,
unresolved, cyclic, over-depth, out-of-repository, or external-symlink content
needed by applicable guidance stops preflight. Diagnostics retain only path and
policy/marker class; rejected bytes never enter a blob, packet, prompt, log, or
provider request. Unsupported dynamic modes are visible exclusions, not errors.

Discovery and parsing use exact non-configurable first-version resource caps for
snapshot entries, canonical targets, unique applicability/candidate paths,
canonical recognition/node/applicability
identities, raw syntax occurrences, expanded edges, path/specifier length,
file/settings/frontmatter size and depth, pattern count and expansion, symlink
depth, and diagnostics. Overlapping adapters count once at unique-path/node
caps but separately at recognition, occurrence, and expanded-edge caps.
Exceeding an authority or work cap fails preflight rather than silently
truncating authority. Diagnostic retention alone compacts excess warnings and
exclusions into a deterministic summary because it does not alter included
guidance. Exact values and boundary outcomes are normative in linked research
contract.

Steering has a separate aggregate budget after applicability filtering and
within-payload deduplication. `contentBytes` is exact included UTF-8 content.
`wireBytes(stage)` is serialized provider-message byte delta between same stage
with and without guidance, including wrappers, provenance, and JSON escaping.
`capacityBytes` is resolved `budgets.maxConversationBytes`, which one simple
profile must make safe for primary and all fallbacks.

Initial defaults warn at or above 32 KiB `contentBytes` or when any stage meets
`10 * wireBytes(stage) >= capacityBytes`. They stop before provider access at or
above 64 KiB or when any stage meets
`5 * wireBytes(stage) >= capacityBytes`. Integer comparisons avoid rounding;
stop wins over warning.

Initial preflight token and cost reservation uses the existing conservative
input upper-bound delta with/without guidance for preliminary, possible
verification, final, and one largest permitted provider retry. Repair calls are
not included in that initial reservation. Inspection separately displays the
maximum configured repair exposure. Immediately before each repair, admission
recomputes the actual repair messages and schema against remaining conversation,
token, and cost capacity; no repair request is sent without capacity. Sources
deduplicate only within one payload, never across requests. Minimum secret,
byte, ratio, conversation, token, and cost admission ships before the first live
Markdown guidance path; richer discovery cannot be merged ahead of that gate.
Normal cost/context admission remains an independent hard backstop. Inspection
shows included and skipped sources, precedence, exact byte counts, conservative
token units, reserved transmissions, and on-demand repair exposure. Threshold
overrides are advanced policy, not normal setup.

## Library boundary

Use established, exact-pinned libraries behind product-owned adapters for
commodity mechanics. This is a requirement, not an optional refactor:
unified/remark owns Markdown parsing/lint traversal, `yaml` owns YAML parsing,
`jsonc-parser` owns Gemini settings tokenization/AST, `picomatch` owns glob
matching, `braces` owns bounded brace parsing/compilation, `ignore` owns
Gitignore grammar, existing Zod owns runtime schemas, `commander` owns CLI
grammar/help, and `@inquirer/prompts` owns TTY prompts/editor integration.
Affected picomatch releases identified by GHSA-3v7f-55p6-f55p cannot be admitted.

No package defines cross-family semantics: each adapter translates native fields
and base path into product contract, with fixtures as normative oracle. Product
code owns snapshot trust, target projection, identity, limits, secret admission,
and bounded vendor-specific import scanners. Hand-writing one of listed commodity
mechanics requires dependency evidence showing no qualified package fits and an
ADR approving exception. Each dependency must pass maintenance, adoption,
license, security, transitive-size, Node.js 24, TypeScript, and ESM checks before
adoption.

Known compatible tokenizers may provide measured steering estimates. Unknown
OpenRouter model families retain conservative byte-based admission because no one
tokenizer library is authoritative for every routed model. Product policy,
snapshot trust, precedence, budgeting, and artifact identity remain local code.

## Alternatives considered

### Continue requiring structured JSON rules

Retained only as the advanced precise path. It provides machine-enforced rule
identity and applicability but duplicates guidance most projects already own.

### Parse Markdown into mandatory semantic rules

Rejected for this milestone. Heading names and prose do not reliably encode
enforcement or exceptions, and project owners did not author these files for our
schema.

### Load every Markdown document

Rejected. It increases cost and noise while allowing irrelevant repository text
to influence review.

### Use HEAD steering for the current review

Rejected. A change could authorize itself or weaken the rules used to assess it.

## Consequences

- Most repositories can reuse guidance they already maintain.
- Reviewer-specific priorities have one obvious, optional home.
- Source provenance and budget impact remain inspectable before spending.
- Markdown cannot guarantee compliance or finding recall; machine-checkable
  requirements still belong in deterministic checks.
- Existing structured standards requests remain reproducible and supported while
  the new contract and migration path are introduced.
