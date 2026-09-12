# Friendly reviewer operations implementation plan

Status: accepted by maintainer; implementation in progress. Slices 1 and 2 are
complete and verified; Slices 3–6 remain pending. Owner: project maintainer.
Decision records: [ADR-013](../decisions/013-separate-simple-settings-from-resolved-review-policy.md)
and [ADR-014](../decisions/014-discover-repository-markdown-steering.md).
Research basis:
[steering and author-absence contract](../research/2026-09-11-steering-and-author-absence-contract.md).

## Outcome

A developer can initialize Independent Reviewer by choosing a supported model
and maximum review cost, reuse repository Markdown guidance automatically, supply
an author explanation through an editor or file, inspect exactly what will be
sent, and run a review without authoring protocol JSON.

Strict JSON contracts remain the resolved runtime and automation boundary. The
existing explicit JSON/profile flow remains supported until a separately planned
deprecation, if any.

## Normal flow

```bash
independent-reviewer init
independent-reviewer steering inspect
independent-reviewer review --dry-run
independent-reviewer review
```

Non-interactive callers can provide the same small set explicitly:

```bash
independent-reviewer init \
  --model openai/gpt-oss-120b \
  --max-cost 0.05

independent-reviewer review --author-file author-context.md
```

Skipping author explanation remains explicit and discouraged:

```bash
independent-reviewer review --no-author
```

## Invariants

- Blind reviewer never receives author explanation before accepted preliminary
  assessment and finding verification.
- Repository guidance cannot change execution policy, credentials, spending,
  routing, permissions, publication, or review-instance limits.
- Steering authority comes from BASE; changed HEAD guidance remains a target.
- `.independent-reviewer/rules.md` is highest-priority prompt guidance, not a
  semantic policy language.
- Steering size, conservative token use, repeated-call cost, omissions, and
  malformed metadata are visible before any provider call.
- No silent truncation, semantic rule extraction, model-selected filesystem
  reads, or cross-protocol resume.
- Applicable steering and imports pass secret policy and minimum steering
  admission before artifact creation or provider access.
- Semantic priority is explicit; canonical presentation never depends on
  filesystem or adapter enumeration order.
- Behavior and fixtures remain language-neutral.

## Dependency admission policy

Library-backed commodity mechanics are the default, not an optional cleanup.
Do not add a dependency until its slice proves a concrete reduction in custom
code or failure modes. Before pinning it exactly, record:

1. official repository and package ownership;
2. current maintenance and release activity;
3. meaningful ecosystem adoption;
4. license and security-advisory status;
5. direct and transitive package cost;
6. Node.js 24, ESM, and TypeScript compatibility; and
7. behavior on malformed and adversarial fixtures.

A slice may hand-write a listed commodity mechanic only when its dependency
admission record shows no qualified package can satisfy the frozen contract and
an ADR records security, maintenance, and parity evidence for the exception.
Product adapters remain intentionally local for cross-family semantics,
snapshot trust, target projection, identity, caps, secret admission, and the
small vendor-specific import scanners for which no common trustworthy grammar
exists.

Initial candidates:

| Need | Candidate | Intended boundary |
| --- | --- | --- |
| CLI grammar and help | [`commander`](https://github.com/tj/commander.js) | Parse commands/options; product code owns precedence and policy |
| Interactive setup and author editor | [`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js) | TTY interaction only; non-TTY remains explicit |
| Markdown parsing and lint | [`remark-parse`](https://github.com/remarkjs/remark), `remark-frontmatter`, selected [`remark-lint`](https://github.com/remarkjs/remark-lint) rules | Syntax tree and diagnostics only; no semantic policy inference |
| YAML frontmatter/settings | [`yaml`](https://github.com/eemeli/yaml) | Parse one bounded document; Zod validates product data |
| Gemini JSON settings | [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser) | Bounded scanner/AST with positions and duplicate-key visibility; Zod validates recognized fields |
| Harness path applicability | [`picomatch`](https://github.com/micromatch/picomatch) | Commodity matching after family adapters normalize native fields and bases; admitted version must include current security fixes |
| Bounded brace processing | [`braces`](https://github.com/micromatch/braces) | Parse/compile supported brace syntax under product expansion caps; never expand before admission |
| Git/Gemini ignore semantics | [`ignore`](https://github.com/kaelzhang/node-ignore) | Interpret frozen BASE ignore files; native Git remains capture authority |
| Runtime contract validation | existing [`zod`](https://github.com/colinhacks/zod) | Strict schemas and discriminated unions; reuse repository dependency |
| Known-model token measurement | [`gpt-tokenizer`](https://github.com/niieani/gpt-tokenizer) spike | Display/packing telemetry only; conservative fallback still admits calls |

Standard-library operations such as UTF-8 byte length and SHA-256 remain on
Node.js APIs. A package is not justified when the platform already supplies the
complete required contract. Specifically, Slices 1 and 5 use `commander` and
`@inquirer/prompts`; Slices 2–4 use remark, `yaml`, `jsonc-parser`, `picomatch`,
`braces`, `ignore`, and existing Zod wherever their corresponding grammar is
present. `gpt-tokenizer` remains conditional because using an incorrect encoding
is worse than the conservative model-independent bound.

Library permissiveness never widens product grammar. Adapters inspect `yaml`
document errors before conversion, use `jsonc-parser` positions while rejecting
comments/trailing commas unless native contract explicitly permits them, set
`ignore` to case-sensitive normalized relative paths, precheck pattern/brace
limits before compilation, and expose no library callback or executable config
surface to repository content. Parity fixtures compare adapter outputs, not
library marketing claims.

## Dependency graph

```text
Simple settings contract and resolver
        |
        +--> CLI compatibility adapter
        |
Markdown guidance contract
        |
        +--> explicit reviewer rules --> harness discovery --> budget/lint inspection
                                                        |
Author input adapters ----------------------------------+
                                                        |
                                  simplified init/review flow
                                                        |
                                      multilingual E2E and docs
```

## Slice 1: Resolve simple settings through existing dry-run

**Description:** Add a versioned small settings contract, supported-model
profiles, provenance, and a deterministic adapter to the current resolved
review-run configuration. Preserve existing CLI behavior while introducing the
new non-interactive model/cost path.

**Acceptance criteria:**

- [x] Model plus maximum cost resolve to one valid existing review-run policy
      with a stable digest and visible field provenance.
- [x] Unknown models fail before credentials or provider access unless an
      advanced configuration supplies the missing policy.
- [x] Existing explicit JSON configuration and saved settings behave unchanged.

**Verification:**

- [x] Contract/default/precedence and equivalent-resolution tests pass.
- [x] `config show` and `config show --resolved` expose no credentials.
- [x] Provider-free dry-run submits zero calls through both simple and legacy
      paths.

**Dependencies:** None.

**Likely touchpoints:** `src/contracts/review-run-config.ts`, a new settings
contract/resolver, `src/cli.ts`, saved-settings module, schemas, contract and CLI
tests.

**Estimated scope:** Medium; split contract/resolver from CLI wiring if either
exceeds five files.

## Slice 2: Review one explicit Markdown guidance document

**Description:** Introduce core `GuidanceGraphV1` and carry zero or one opaque
`.independent-reviewer/rules.md` source from BASE through packet inspection,
blind review, finding citations, reconciliation, and final artifacts. Freeze
snapshot-target projection and complete packet/brief/run/call/report/resume
identity chain here; Slice 3 adds family adapters, imports, and multi-source
closure without replacing contract. Do not add automatic harness discovery yet.
Ship minimum secret, byte, wire-ratio, conversation, token, and cost admission
before guidance can enter any live provider request.

**Acceptance criteria:**

- [x] Whole Markdown content reaches blind stage with path, digest, priority,
      and source-position identity only after preflight admission; author stage
      timing remains unchanged.
- [x] Packet metadata, brief identity, `RUN_STARTED`, provider input digest, and
      runner-owned report bind `guidanceGraphDigest`; resume reconstructs and
      compares exact graph, source blob, rendered prompt, and protocol versions.
- [x] Head changes to the file are review targets but cannot govern their own
      review.
- [x] No heading or prose is converted into enforcement, exception, or runner
      policy.
- [x] Applicable reviewer-rules content uses existing path/content secret
      policy before artifact creation; detection fails preflight with metadata-
      only diagnostics and zero secret bytes persisted or transmitted.
- [x] Default 32/64 KiB content and 10/20 percent wire-ratio gates use ADR-014
      integer formulas. Richer lint and automatic discovery remain Slices 3–4.

**Verification:**

- [x] Contract and schema tests cover missing, added, changed, deleted, empty,
      exactly-at/around budget boundaries, and a secret-bearing reviewer-rules
      file. Reviewer-specific rules have no import syntax.
- [x] Graph/blob substitution, missing graph, stale metadata, and cross-version
      resume fail locally with zero subsequent provider calls.
- [x] Packet and mock-provider assertions prove detected secret bytes occur in
      neither persisted artifacts nor any request body.
- [x] Mock-provider E2E proves precedence labeling and author withholding.
- [x] Structured standards-profile fixtures and resumes remain compatible.

**Dependencies:** Slice 1 for simple invocation; contract work may begin after
the Slice 1 resolver shape freezes.

**Likely touchpoints:** shared identifier primitives, new guidance graph/identity
contracts, packet metadata/store, snapshot/brief assembly, run events and resume,
prompt/candidate/report versioning, schemas, focused tests.

**Estimated scope:** Medium in two commits: contract/capture, then orchestration.

## Slice 3: Discover and scope common harness steering

**Description:** Add BASE-tree discovery adapters for Codex, Claude, Gemini,
Kiro, Copilot, and Cursor conventions. Implement normative family table and
failure outcomes in research record; normalize only deterministic inclusion and
applicability metadata. Implement already-frozen source-node/import-edge and
resource-cap contracts before adapter groups split. Adopt qualified Markdown,
YAML, JSON, glob, brace, and Gitignore libraries behind small family adapters.

**Progress:** In progress. Canonical direct-source assembly and Codex ancestor
discovery are implemented: BASE `AGENTS.override.md` wins over `AGENTS.md` per
directory, selected files apply root-to-target-parent, and multi-source output
flows through the existing packet, prompt, admission, and resume chain. Claude
direct files and scoped rules now use strict library-backed YAML frontmatter,
bounded brace expansion, and patched glob matching. Relative BASE-only Claude
`@path` imports now preserve occurrence/edge provenance, recurse through four
hops, follow bounded repository-internal symlinks, and fail closed on invalid or
over-limit graphs. `mdast-util-from-markdown` is already supplied by
`remark-parse`; `agent-install/agents-md` was evaluated but reads and edits live
working-tree files and parses headings rather than supplying frozen Git
discovery/applicability semantics, so it remains a possible setup-UX dependency,
not a runtime capture dependency. Gemini, Kiro, Copilot, Cursor, and ignore
adapters remain pending.

**Acceptance criteria:**

- [ ] Root, nested, override, always-on, and path-matched sources select the
      correct guidance for every projected target.
- [ ] Manual/model-selected modes, global home files, ignored files, and HEAD-only
      guidance do not enter prompt context. Manual/model-selected sources are
      unconditionally excluded in v1; no implicit or advanced selection exists.
- [ ] `.independent-reviewer/rules.md` is always last among repository guidance;
      peer harness families retain equal semantic authority.
- [ ] Canonical presentation sorts by semantic tier, direct/import-only origin
      rank, complete canonical direct-recognition vector, resolved path, and
      source identity. Each direct recognition binds `familyId`, `sourceKind`,
      `nativeOrder`, `applicableTargetId`, and `discoveredPath`; records and
      vectors follow ADR-014's exact integer/UTF-16 comparison.
- [ ] Strict `GuidanceGraphV1` serialization binds snapshot digest and BASE,
      stores exact relocation-aware targets plus sorted unique
      nodes, occurrences, edges, diagnostics, and every sorted unique node-local
      vector. Validation recomputes all IDs and derived fields and rejects unknown
      fields, duplicates, bad order, dangling references, missing or extra closure
      edges, blob/digest mismatch, or drift before prompt construction and resume.
- [ ] Snapshot entries project exactly: add/untracked/modified/type-changed use
      destination, deletion uses BASE path, rename uses BASE source plus HEAD
      destination, and copy uses HEAD destination only. Target role/side is
      visible in prompt provenance and bound into graph identity.
- [ ] Packet metadata, neutral brief, `RUN_STARTED`, complete provider-request
      input digest, and runner-owned report bind exact `guidanceGraphDigest`.
      Resume rebuilds and compares graph, blobs, brief, plan, messages, ledger,
      and protocol versions before another provider call.
- [ ] `AGENTS.md` and `CLAUDE.md` sources recognized by multiple family adapters
      merge complete family/applicability provenance and render content once per
      payload. Applicability is the union of all recognitions.
- [ ] Copilot recognizes standard `GEMINI.md` locations without expanding their
      references; Gemini/Copilot overlap merges provenance and content.
- [ ] Canonical source nodes, family-specific syntax occurrences, and expanded
      import edges bind BASE identity, resolved paths, requested specifiers,
      source positions, family, and target applicability. One occurrence
      emits exactly one edge per applicable target; multi-family parsing
      emits separate occurrences. Direct-plus-import merging retains recognition
      kinds and provenance without a mutable node-level `sourceKind`.
- [ ] Every supported root, metadata shape, path base, ignore rule, import
      syntax/depth, dynamic-mode exclusion, and unsupported setting follows the
      normative family table rather than one shared parser assumption.
- [ ] Every normative snapshot-entry, target, applicability-path,
      unique-candidate, recognition, canonical-node, node/target-pair,
      raw/canonical-occurrence, expanded-edge, parser,
      pattern/expansion, symlink, and diagnostic cap uses its declared identity.
      Authority/work caps fail closed above exact limit without partial guidance
      or provider access; diagnostic overflow alone uses deterministic bounded
      compaction.
- [ ] Every applicable root and imported/reference file passes path/content
      secret policy before artifact creation; failure retains metadata-only
      diagnostics and sends zero provider calls.

**Verification:**

- [ ] Table-driven fixtures cover each harness convention and overlapping paths.
- [ ] Adapter-order and filesystem-order permutation tests produce byte-identical
      graph serialization, prompt input, and digest-bound artifacts.
- [ ] Added, deleted, modified, type-changed, rename-across-scope,
      copy-across-scope, same-directory relocation, and separately modified copy
      source fixtures prove exact target role/side, guidance selection, graph,
      prompt, and digest output.
- [ ] Multi-family fixtures give one shared source divergent native orders and
      adapter discovery orders; every permutation produces the same recognition
      vector, prompt bytes, and digest.
- [ ] Direct-only, import-only, repeated-edge, transitive, and
      direct-plus-import fixtures produce canonical node/edge identities,
      rendering order, prompt bytes, and digest across traversal permutations.
- [ ] Strict-schema, round-trip, and tamper fixtures cover every graph/member
      field, exact identifier prefix/digest, external content-blob verification,
      occurrence source spans, diagnostic canonicalization, unknown fields, and
      missing or invented derived records.
- [ ] One import occurrence propagated to N targets produces exactly N
      edges; recognition by F families produces F occurrences and expected
      per-family edges. Exact duplicates collapse, conflicting target resolution
      fails, and cycle identity is family/source/path specific.
- [ ] Multi-family source-kind fixtures retain every recognition kind, derive
      node semantic tier/applicability exactly, and reject recognition conflicts
      instead of using adapter arrival order.
- [ ] Traversal, symlink, invalid glob/frontmatter, duplicate discovery, case,
      slash, Unicode, imports, cycles, depth, ignores, and unsupported modes have
      explicit results.
- [ ] Secret-bearing imported/reference fixtures prove rejected bytes occur in
      neither persisted artifacts nor request bodies.
- [ ] Below, exactly-at, and above fixtures cover every resource cap, including
      expansion-product preflight before allocation and deterministic diagnostic
      overflow compaction. Overlap fixtures prove unique-path/node caps count once
      while recognition, occurrence, edge, and applicability-pair caps count their
      complete canonical identities.
- [ ] After preliminary persistence and a definite resumable final 429,
      self-consistent graph replacement, graph-plus-blob replacement, missing
      graph, stale packet binding, and mixed protocol versions all fail locally
      with zero additional provider calls.
- [ ] Manual/model-selected sources always produce typed exclusions in v1; no
      settings or CLI permutation causes their contents to enter graph or prompt.
- [ ] Dependency-parity fixtures exercise remark, `yaml`, `jsonc-parser`,
      patched `picomatch`, `braces`, and `ignore` through narrow adapters.
      No hand-written replacement for those grammars ships without approved ADR.
- [ ] TypeScript, Python, Go, Java, documentation-only, and mixed-language
      changes use identical discovery policy.

**Dependencies:** Slice 2.

**Likely touchpoints:** shared identifier primitives, new guidance contract and
identity modules, steering discovery and adapter modules, brief assembly,
inspection output, dependency manifest/lockfile, fixtures and tests.

**Estimated scope:** Medium per adapter group; merge only after shared normalized
contract is stable.

## Slice 4: Enforce steering budget and provide lint/inspection

**Description:** Extend Slice 2 minimum admission across discovered sources,
measure exact content and incremental serialized wire bytes, compute existing
conservative token deltas, account for repeated transmission across possible
calls, and add one provider-free inspection/lint surface. Known-tokenizer
measurement is optional telemetry and cannot weaken admission.

**Acceptance criteria:**

- [ ] Default warning and stop thresholds follow ADR-014 and can be overridden
      only through advanced policy.
- [ ] Inspection exposes exact `contentBytes`, per-stage `wireBytes`, resolved
      `capacityBytes`, integer threshold result, per-stage token-unit delta, and
      initial mandatory/conditional/retry reservations plus separately labeled
      on-demand repair exposure.
- [ ] Simple profiles resolve one `maxConversationBytes` safe for primary and
      fallbacks; advanced JSON retains its explicit common cap.
- [ ] Hard-limit, total-context, and total-cost failures occur before credentials
      or provider access and identify remediation without dumping guidance text.
- [ ] Lint validates format and supported metadata only; style diagnostics warn
      and semantic policy content is untouched.

**Verification:**

- [ ] Boundary tests cover exactly-below, exactly-at, and above each byte and
      ratio threshold.
- [ ] Initial preflight reservation covers preliminary, possible finding
      verifier, final, and one largest provider retry for clean and
      finding-bearing paths, deduplicating only within each payload and counting
      each separate provider transmission.
- [ ] Repair-time tests recompute actual messages and schema against remaining
      conversation, token, and cost capacity immediately before every repair;
      insufficient capacity produces no repair request.
- [ ] `steering inspect` output is stable in TTY, non-TTY, quiet, and JSON modes.

**Dependencies:** Slice 3.

**Likely touchpoints:** admission/budget module, steering inspector/linter, CLI,
optional tokenizer adapter, diagnostics and tests.

**Estimated scope:** Medium; budget enforcement and presentation are separate
commits.

## Slice 5: Make author explanation and initialization friendly

**Description:** Use a qualified prompt library to implement interactive `init`
and author explanation collection while keeping explicit file/stdin operation for
automation. Introduce ADR-013 versioned `PROVIDED`/`DECLINED` author-context
lifecycle. Migrate command parsing to a qualified CLI library only with complete
behavior-parity tests.

**Acceptance criteria:**

- [ ] `init` asks for supported model and maximum cost, previews discovered
      steering, detects credential presence without printing it, and stores only
      Git-local selections.
- [ ] `review` accepts `--author-file`, stdin, or interactive editor input and
      still collects the explanation before blind submission.
- [ ] Missing author context blocks by default; `--no-author` requires explicit
      intent and warns before spending.
- [ ] New request/packet metadata always binds author status and digest;
      `PROVIDED` requires a matching separate artifact and `DECLINED` forbids it.
- [ ] Blind and verification stages see neither author content nor presence;
      final reconciliation receives one versioned author-context release.
- [ ] Declined reports contain typed runner-owned `authorContext.status` set to
      `DECLINED` and `authorContext.noteCode` set to
      `AUTHOR_CONTEXT_DECLINED`, plus an empty author claim ledger. Renderer
      shows a non-blocking author-context note; it does not add a formal
      limitation or independently select a verdict.
- [ ] Resume rejects author status/digest or request/packet/prompt/result/event
      version mismatch; existing runs remain readable without silent upgrade.

**Verification:**

- [ ] TTY, cancellation, EOF, editor failure, non-TTY, malformed settings, linked
      worktree, and repeated-init tests pass.
- [ ] Existing command grammar, exit codes, stdout machine output, and stderr
      progress retain compatibility.
- [ ] Mock provider cannot observe author content during blind or verification
      stages for any input adapter.
- [ ] Contract tests allow `DECLINED` with `READY` or
      `READY_WITH_FOLLOW_UPS` when findings, coverage, unresolved concerns, and
      formal limitations otherwise permit that verdict; real limitations still
      block ready outcomes.
- [ ] Corrupt/missing provided artifacts, stray declined artifacts, status/digest
      mismatches, pre/post-release resume, and old/new protocol mixing fail with
      explicit local diagnostics and zero provider calls where preflight applies.

**Dependencies:** Slices 1 and 4.

**Likely touchpoints:** `src/cli.ts`, settings/input adapters, author contract,
dependency manifest/lockfile, CLI and orchestrator tests.

**Estimated scope:** Medium in separate CLI-parser and interaction commits.

## Slice 6: Complete migration, documentation, and E2E qualification

**Description:** Update normal-user documentation around the short flow, retain
an advanced reference for complete JSON configuration, and qualify the end-to-end
behavior across representative repositories.

**Acceptance criteria:**

- [ ] A clean checkout reaches provider-free dry-run using only model, maximum
      cost, discovered steering, and author explanation.
- [ ] User guide contains concise recommended Markdown examples without claiming
      semantic validation or enforcement.
- [ ] Legacy JSON/profile automation, resume, and artifact inspection remain
      documented and green.

**Verification:**

- [ ] `npm run schemas:write`, `npm run check`, and
      `python3 -B scripts/check-ai-context.py --ci` pass.
- [ ] Provider-free E2E matrix covers TypeScript, Python, Go, Java, docs-only,
      mixed-language, nested steering, oversized steering, no-author opt-out, and
      legacy configuration.
- [ ] One bounded live matrix runs only after explicit paid-test approval and a
      successful dry-run; reported and unknown costs remain separate.

**Dependencies:** Slices 1–5.

**Likely touchpoints:** `README.md`, `docs/user-guide.md`, architecture/protocol
docs, E2E fixtures, validation report.

**Estimated scope:** Medium; docs and qualification evidence remain separate
commits.

## Checkpoints

### After Slices 1–2: contract checkpoint

- [x] Simple settings resolve without weakening current policy.
- [x] One opaque Markdown source completes through mock-provider review.
- [x] Graph, packet, brief, call, report, and resume identities reject exact
      replacement/tamper corpus before automatic discovery begins.
- [x] Maintainer reviews new contract names and compatibility boundary.

### After Slices 3–4: trust and budget checkpoint

- [ ] Discovery corpus proves BASE authority and path applicability.
- [ ] Inspection explains every included and skipped source.
- [ ] Oversized steering cannot trigger a provider call.
- [ ] Dependency audit contains exact accepted versions and rationale.

### After Slices 5–6: release checkpoint

- [ ] First-time interactive and automation flows both work end to end.
- [ ] Author explanation remains default and blind-stage isolation is proven.
- [ ] Multilingual matrix and all repository gates pass.
- [ ] User guide no longer requires normal users to author protocol JSON.

## Parallelization after contracts freeze

Slice 2 freezes and implements complete graph, target, source-node, occurrence,
edge, ordering, cap, packet, and resume contracts while populating only zero or
one direct reviewer-rules node and leaving occurrence/edge arrays empty. Harness
adapter groups can then proceed independently by source family in Slice 3 without
changing that contract. CLI interaction work can proceed in parallel with
steering budget presentation after settings and diagnostic interfaces freeze.
Shared contract, resolver, prompt-order, and admission modules must retain one
owner during each integration window.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Too much discovered guidance reduces code-review signal | High | Applicability filtering, visible budgets, warnings, and pre-call stop |
| Conflicting harness files produce unstable interpretation | High | Separate semantic tiers from canonical presentation; `.independent-reviewer/rules.md` wins; require reviewer to surface peer conflict |
| Steering or import contains a secret | High | Reuse capture secret policy before artifacts; fail applicable-source preflight without retaining bytes |
| Changed guidance authorizes itself | High | BASE-only authority with HEAD retained as review target |
| Valid guidance graph is replaced between blind and resumed final stages | High | Cross-bind graph digest through packet, brief, run/call ledgers, report, and exact resume reconstruction |
| Rename/copy crosses nested guidance scopes | High | Typed snapshot projection with both rename scopes and copy destination only; canonical relocation fixtures |
| CLI library migration changes scripts or exit behavior | Medium | Behavior-parity corpus and isolated migration commit |
| Markdown parser becomes semantic policy engine | High | Opaque document contract and format-only lint boundary |
| Token estimate is wrong for routed model | High | Exact wire-byte ratios and conservative token deltas remain authoritative; tokenizer output is telemetry only |
| Dependencies add supply-chain or maintenance risk | Medium | Exact patched pins, advisory check, admission checklist, small adapters, audit, and easy replacement boundaries |
| Author opt-out becomes habitual | Medium | Required default, explicit flag, warning, and durable report marker |

## Deferred work

- Semantic contradiction detection across prose documents.
- Machine enforcement of Markdown statements.
- Global personal steering and organization-managed remote policy.
- Model-selected or relevance-selected steering inclusion.
- Automatic rewriting or generation of repository steering.
- Deprecation of structured standards profiles.
- PR/MR hosting adapters and autonomous publication.
