# Independent Reviewer — architecture and project plan

Status: first local release implemented and exercised with controlled live smoke fixtures.

Next milestone: friendly reviewer operations using simple local settings,
repository Markdown steering, steering-budget admission, and first-class author
explanations. Design is accepted in
[ADR-013](decisions/013-separate-simple-settings-from-resolved-review-policy.md)
and [ADR-014](decisions/014-discover-repository-markdown-steering.md); execution
is tracked in the
[friendly operations plan](plans/2026-09-11-friendly-reviewer-operations-plan.md).
Normative discovery, secret, ordering, budget, and author-absence decisions are
grounded in the
[steering contract research](research/2026-09-11-steering-and-author-absence-contract.md).

The staged lifecycle, evidence surface, verification boundary, and efficiency
requirements are refined in the
[review protocol technical specification](review-protocol-spec.md). The
orchestrator decision is recorded in
[ADR-001](decisions/001-orchestrator-mediated-staged-review.md). The initial
TypeScript and Node.js runtime is recorded in
[ADR-002](decisions/002-use-typescript-node-runtime.md). The prompt, call,
budget, and failure protocol is recorded in
[ADR-003](decisions/003-use-versioned-budgeted-model-call-protocol.md).
The deterministic artifact identity profile is recorded in
[ADR-004](decisions/004-use-jcs-sha256-artifact-identities.md).
Runner-owned final bookkeeping is recorded in
[ADR-010](decisions/010-derive-final-bookkeeping-in-runner.md).
Explicit standards evidence selection is recorded in
[ADR-011](decisions/011-separate-reference-selection-from-file-classification.md).
Fresh blind finding verification is recorded in
[ADR-012](decisions/012-adversarially-verify-preliminary-findings.md).

## Planned operator experience

Current standards mode remains implemented as validated profile JSON. The next
milestone adds a normal-user layer without weakening or silently changing that
contract. A user selects a supported model and maximum review cost, reuses
applicable repository Markdown guidance, and supplies an author explanation.
The runner resolves those inputs into strict versioned runtime artifacts.

Repository guidance is discovered from common coding-agent locations in the
frozen BASE tree. `.independent-reviewer/rules.md`, when present, is highest-
priority review guidance. Markdown remains untrusted, opaque model context: it
cannot change execution policy and is not parsed into mandatory semantic rules.
Only deterministic scope metadata, source provenance, format diagnostics, and
budget accounting belong to the runner.

Snapshot entries project into canonical guidance targets before discovery:
renames carry BASE source and HEAD destination scope, copies carry only changed
destination scope, and other change types use their sole review-relevant path.
One JCS/SHA-256 graph identity is cross-bound through packet metadata, neutral
brief, run ledger, provider-request digest, runner-owned report, and final-stage
resume. An internally valid replacement graph is not an acceptable resume input.

Applicable steering receives explicit byte and conservative-token limits before
provider access. Inspection shows included and skipped sources, precedence, and
repeated-call cost impact. Author explanation remains required by default and is
still withheld until reconciliation; an explicit opt-out warns before spending
and becomes a digest-bound `DECLINED` state visible only after blind and
verification stages. Applicable guidance and imports pass snapshot secret policy
before any artifact or provider request.

Milestone gate: from a clean checkout, a developer can choose a supported model
and maximum cost, inspect BASE-owned steering and its budget impact, provide an
author explanation, complete a provider-free dry-run, and start the same review
without authoring protocol JSON. Oversized steering makes no provider call;
legacy structured automation remains compatible; TypeScript, Python, Go, Java,
documentation-only, and mixed-language fixtures pass the same policy.

Commodity mechanics use qualified, exact-pinned libraries behind bounded
product adapters: Commander and Inquirer for CLI interaction; remark, `yaml`,
and `jsonc-parser` for document grammars; `picomatch`, `braces`, and `ignore` for
matching grammars; existing Zod and Node.js primitives for contracts, hashing,
and paths. Product code remains responsible for snapshot trust, family semantics,
resource caps, secret admission, and artifact identity. Hand-written replacement
of listed library responsibilities requires an explicit ADR with evidence.


## Standards review mode (v2)

Standards mode implements the agreed [product plan](research/2026-09-09-first-use-product-plan.md).
It accepts selected standards and a separate author overview without business
requirements or an implementation plan. The existing v1 mode remains available.
The blind call sees frozen code and standards only; final reconciliation receives
the persisted assessment plus the overview collected upfront. When preliminary
findings exist, a fresh verifier challenges them before final reconciliation and
without seeing the overview. Standards inputs are validated
profile JSON in digest-bound PROJECT_GUIDANCE documents; no placeholder plan or
requirements are synthesized. Brief v2 binds the mode and selected inputs under
a separate identity profile. Packet metadata v2 binds the author digest before
submission; inspection exposes only its presence.

Standards findings cite selected rule IDs, applicability, a concrete code-quality
problem, evidence and correction. REQUIRED and RECOMMENDED classifications replace
defect severity in this mode. Existing verdict codes retain exit compatibility,
but labels explicitly describe standards satisfaction/changes/recommendations or
inability to assess, never deployment readiness. Unknown or inapplicable rule
references fail validation. Conflicting rule IDs require explicit selection of
one definition. Subjective disagreement with a standard is not an exception.
Bug hunting, fuzzing and runtime verification are outside this mode. Transport,
privacy and spending bounds remain; protocols cannot be mixed during resume.

Standards profile v2 can declare normalized repository references and bind each
to selected rules with an explicit required flag. File classification remains a
content-kind signal, not the sole eligibility decision. Unchanged applicable
references are frozen as supporting context; changed references retain their
classification, enter target scope, and use BASE as authority so a patch cannot
authorize itself. Standards brief v2 records independent artifact roles and
capture status. Findings remain anchored to transmitted changed evidence.

## Objective

Build a standalone review engine that takes a frozen implementation target and canonical requirements, conducts an engineering review through an external model on OpenRouter, and returns an evidence-backed report to the implementation workflow. Start with a local CLI; add an MR/PR bot using the same engine later.

The external reviewer receives no implementation conversation, agent memory, or inherited session. Its initial assessment precedes exposure to the author's explanation. Choosing a different model family can add diversity, but independence principally comes from controlled inputs and enforced review stages; an external endpoint alone does not establish independence or correctness.

## Existing foundation

The inspected AI Central source is `templates/skills/first-party/independent-review/SKILL.md`. It matches the installed local skill. Preserve:

- Separate neutral bootstrap and author explanation.
- Review of both implementation and plan against canonical requirements.
- Preliminary findings before author-claim reconciliation.
- Evidence, failing scenarios, impact, and credible corrections for findings.
- Four verdicts: Ready, Ready with non-blocking follow-ups, Not ready, Unable to verify.
- At most three review instances by default, with the initiating workflow controlling any new instance.
- Explicit human decision for a material architecture or scope pivot.
- Read-only review and finding-by-finding author response.

The expansion moves enforceable rules into software. The skill remains the author-facing workflow and invokes that software. Prompts and schemas are versioned with the engine so the CLI and future bot cannot silently diverge.

## Component boundaries

```text
Implementation task                    Future MR/PR event
       |                                      |
AI Central skill                       Hosting adapter
       |                                      |
       +------------ Review input ------------+
                            |
                  Snapshot / packet builder
                            |
                  Local review orchestrator
                   /                    \
       Snapshot evidence tools      OpenRouter adapter
                   \                    /
                    External reviewer
                            |
              Validated JSON + Markdown report
                            |
                CLI output / bot publisher
```

| Component | Responsibility |
| --- | --- |
| AI Central skill | Capture intent, requirements, plan, and author explanation; invoke runner; reconcile returned findings. |
| Snapshot builder | Resolve actual Git scope independently, freeze content, enumerate omissions, produce hashes and manifest. |
| Review core | Enforce stage transitions, tool permissions, review limits, budgets, and report validation. |
| OpenRouter adapter | Send explicit messages, select configured model/provider policy, handle bounded transport failures, record usage. |
| Report layer | Preserve preliminary assessment and final report, validate evidence anchors, render Markdown. |
| Hosting adapter | Translate MR/PR state into review input and later publish results without changing review semantics. |

The accepted initial runtime is TypeScript 6 on Node.js 24 LTS in a single ESM
package with explicit modules. No daemon, database server, or web UI is needed
for the first version. The runtime is not a dependency on Codex or an OpenAI
SDK. See [ADR-002](decisions/002-use-typescript-node-runtime.md).

## Review lifecycle

1. **Prepare.** Resolve base and head, requirements, plan, exclusions, and verification evidence. Capture staged, unstaged, and selected untracked changes for working-tree reviews. Do not stage or commit to simplify capture. Detect changes during capture and retry or fail; later review reads use the snapshot only.
2. **Validate.** Hash captured content and write the manifest. Check scope, file policy, size limits, and model capabilities. Produce a local dry-run packet showing exactly what will be sent. Never silently truncate a diff or silently exclude relevant files.
3. **Blind review.** Start an external conversation containing trusted review policy, neutral requirements, scope, diff, tests, and initial surrounding code. Withhold the author packet at the orchestrator boundary. The shipped model receives one fixed payload; on-demand evidence reads remain deferred under ADR-005.
4. **Persist preliminary assessment.** Require a structured preliminary findings and coverage ledger before unlocking the author packet. Persist the response and its input identity. This is a durable artifact; it cannot be overwritten by reconciliation.
5. **Challenge findings.** When the preliminary contains findings, send the frozen blind evidence and persisted assessment to a fresh verifier with no author context. Persist exactly one confirmed, rejected, or inconclusive assessment per preliminary finding. For an empty finding set, persist an empty local ledger without a provider call.
6. **Reconcile author claims.** Continue the original external review conversation with the verification ledger and author packet. Ask the reviewer to confirm, contradict, or mark claims unverified and explain any changes to preliminary findings. Every verifier-rejected finding must be withdrawn. Record missing author explanation explicitly if absent.
7. **Validate and report.** Validate report shape, snapshot identity, path/line anchors, verification provenance, and required coverage fields. Preserve limitations; invalid output, incomplete scope, or exhausted context cannot become an empty successful review. An evidence anchor proves a location exists, not that a finding is true.
8. **Return control.** The implementation workflow accepts, disputes with evidence, or defers each finding. A materially changed target needs a new snapshot and review instance within the original flow limit. The reviewer cannot dispatch fixes or start new reviews.

Both author-visibility stages and the selective verifier call belong to one review instance. Transport retries do not create new review instances and must not be used to shop for a favorable verdict. A resumed run uses persisted stage state; it must not leak the author packet into a restarted blind stage or verifier.

## Context and trust model

Use a fresh message list per review instance. Do not import implementation transcripts, previous reviewer verdicts, or unrelated workspace memory into the blind stage. Canonical requirements necessarily convey intent; record their provenance and distinguish author-written retrospective summaries from prior acceptance criteria.

Repository text, code comments, diffs, MR descriptions, and author explanation are evidence, not trusted instructions. Repository conventions may inform judgment but cannot grant permissions, modify runner policy, select an endpoint, or trigger publication. Load operational policy outside the reviewed patch, particularly in CI.

Context selection can bias a review even without chat history. Mitigate this with deterministic initial collection, a complete path/change manifest, read/search tools over the permitted snapshot, and explicit coverage gaps. Bound tool calls and returned bytes. Reject traversal, symlink escapes, and reads outside the snapshot. Include deletion/rename evidence, and identify unsupported binaries and submodules.

Begin with static inspection and supplied verification logs. Logs must be labeled as author-provided or runner-observed. An API model has no local filesystem or test runner by itself. Later add isolated verification workers with no API secrets, restricted network, temporary writable storage, timeouts, and recorded commands. Do not label arbitrary project test commands non-mutating or execute them in the user's working checkout.

## Contracts and artifacts

Version the following contracts before implementing orchestration:

- **Review manifest:** schema version, flow/instance IDs and maximum, source identity, base/head, dirty-state boundary, snapshot digest, paths and content hashes, exclusions and omissions, canonical inputs and provenance, collection policy version.
- **Author packet:** intent, plan traceability, approach, alternatives, invariants, claimed verification, costs, gaps, challenge points.
- **Review configuration:** model ID, permitted provider routing, capability requirements, input/output budgets, tool limits, timeout, retry limits, and data policy.
- **Evidence record:** snapshot path, base/head side, line range or symbol, optional excerpt digest; verification command, executor, result and output reference when applicable.
- **Review report:** preliminary/final stage, snapshot digest, findings with stable IDs and P0–P3 severity, scenario and impact, evidence, smallest credible correction, plan coverage, author-claim ledger, verification, residual risks, verdict, and any pivot decision gate.
- **Run record:** prompt/schema versions, requested and returned model/provider metadata when available, request identifiers, timings, token usage/cost when available, tool requests and responses, failures, and stage transitions. Never persist credentials or claim unavailable metadata.

Persist artifacts locally under a configured private run directory, excluded from Git by default. Reports and packets may contain proprietary source. Keep preliminary output, final output, and validation errors separate. Content hashes allow identity checks; deterministic packaging does not imply deterministic model output.

## OpenRouter integration

Use an explicit configured model ID. Do not choose an automatic model router for
the first release. Select supported and preferred models separately, based on
structured-output support, context and output capacity, privacy-compatible
endpoint diversity, conservative cost admission, coding-review quality, and live
protocol evaluation. Support means that the protocol accepts a configuration;
it is not a reliability or quality recommendation. Model choice stays
configurable. Current evaluation tiers and promotion gates are recorded in the
[model-selection review](research/2026-09-10-review-model-selection.md).

The adapter uses non-streaming Chat Completions for every stage, with a local
authoritative message ledger. A review response is structured JSON with no
interactive consumer, so streaming added SSE framing, partial-JSON and UTF-8
boundary failure modes without a reader to serve; see
[ADR-006](decisions/006-route-for-availability-not-pinning.md). Prompts,
response schemas, and provider wire policy are versioned. The preliminary
response also requests the author packet, avoiding an otherwise empty model turn. See
[ADR-003](decisions/003-use-versioned-budgeted-model-call-protocol.md).

Use schema-constrained output when supported and validate responses locally
regardless.[^or-structured] Set `require_parameters: true` so routing does not
silently ignore requested capabilities. Keep a hard provider price ceiling, which
is also the rate the local reservation arithmetic assumes.

Route for availability. Configured endpoints are a preference rather than an
allowlist, provider failover stays enabled, and a configured model fallback chain
covers rate limiting, downtime, context-length and moderation refusals. Narrowing
the eligible pool — pinning to the configured order, requiring zero data
retention, denying data collection, or setting the price ceiling at the cheapest
available rate — is opt-in, because each removes recovery paths and a single
degraded endpoint then fails the run. Record the preferred and excluded endpoints
before submission and the returned model and route when available.[^or-routing]

Explicitly disable provider context compression because it can remove or
truncate messages from the middle.[^or-transforms] Disable response caching for
live reviews because it stores and replays complete responses and is unavailable
with account-level ZDR. Prompt caching remains an opt-in optimization after data-
policy and measured-cost review.[^or-response-cache][^or-prompt-cache]

For source review that carries a data-handling requirement, opt into `data_collection: "deny"` and `zdr: true`, accepting the smaller eligible pool and failing when no eligible route exists. Neither is on by default. OpenRouter describes ZDR as endpoint routing enforcement; this is not a blanket claim about all storage across the application and providers. Review account logging separately. See [provider data-policy and ZDR controls](https://openrouter.ai/docs/guides/routing/provider-selection).

Read the API key at runtime from environment or an external secret store. Keep it out of packets, model messages, tool results, and logs. Bound completion tokens, calls, retries, and time; use pricing estimates for preflight, record actual usage when returned, and never describe a local estimate as a guaranteed billing cap.

The orchestrator owns retries. Before the first call it reserves the preliminary,
possible finding-verification, and final calls plus one provider retry at the
largest call reservation. The example
120B configuration permits 240,000 conservatively counted tokens under a $0.20
cost ceiling. Definite 408/409/429/500/502/503/504/524/529 responses (including
non-JSON HTTP errors), normally terminated empty completions, and uncertain
transports may retry, bounded by `budgets.maxAttemptsPerCall` for each logical
call, with exponential backoff over the jittered base delay. The budget is
per-call so that a preliminary retry cannot starve the final stage; the run-wide
token and cost ledgers still bound total spend. An uncertain transport is
retried because an inference call is idempotent here, and it is charged the full
conservative reservation first so a possible double submission is never free. A
provider error carrying no usage never reached a model and is charged nothing,
which is what previously made a 429 exhaust the reservation that paid for its own
retry. A retry excludes the endpoint that just failed and lets routing re-select.
A 429 or 529 without a usable Retry-After hint uses a randomized 5–10 second cooldown.
OpenRouter clients sharing one in-process pacing coordinator pause new requests
for that model together, including after retry exhaustion. Separate CLI processes
do not share this coordinator. `budgets.minimumCallIntervalMs` spaces request
starts for one model and defaults to 1,500 milliseconds, because this account's
burst limit returns 429 for back-to-back requests regardless of routing.
Cost admission prices reserved input and output tokens at their respective
provider ceilings, including each request fee, instead of pricing all tokens
at the higher output rate.
The retry preserves stage messages. A final retry excludes the pinned failed
endpoint and uses the next endpoint already present in the allowlist; model,
provider allowlist, price and privacy controls remain unchanged. Successful
preliminary work is retained when the final call needs recovery. A
possibly submitted timeout remains `TRANSPORT_UNCERTAIN`; it is not retried
automatically. OpenRouter can return typed errors inside an HTTP `200`, so the
adapter validates the body and finish reason rather than trusting status
alone.[^or-errors]

## Lean delivery plan and acceptance gates

### Slice 1 — snapshot preparation

Create the standalone repository, schemas, capture policy, CLI `prepare` and `inspect` commands, and fixtures. Gate: reproducible packet identity for unchanged input; correct staged/unstaged/untracked and rename/delete handling; visible exclusions; detected capture races; no author content in the blind payload; no escaping snapshot reads.

Progress: complete. The TypeScript/Node runtime has strict request, snapshot,
and neutral-brief contracts with deterministic JCS/SHA-256 identities. Git
capture freezes committed and cumulative working-tree changes into
content-addressed blobs, detects capture races, records exclusions, and exposes
`prepare` and `inspect` without making a provider call.

### Slice 2 — two-stage external review

Build the neutral brief from the snapshot packet, add one configurable OpenRouter
adapter, and enforce blind assessment followed by separately delivered author
explanation. Persist the preliminary and final JSON responses and render the
final report as Markdown. Gate: a mock-provider end-to-end run proves author
withholding; malformed output cannot report Ready; basic call/token/time limits
stop the run; one explicitly enabled live smoke review succeeds.

Progress: the offline engine is complete. It builds a digest-bound neutral
brief from the packet, classifies changed paths, sends bounded unified hunks or
justified whole-file diffs, distinguishes visible out-of-scope paths from
blocking missing coverage, and fails rather than clipping an oversized initial
evidence set. It persists the raw and validated preliminary result, then persists
a fresh author-blind assessment of every preliminary finding before author
delivery. Finding-free reviews create the empty verification ledger locally;
finding-bearing reviews make one schema-constrained verifier call. Final
reconciliation must withdraw every verifier-rejected finding. It permits at most
one separately recorded same-model repair when a complete final candidate fails local validation,
assembles `final-review-candidate-v3` judgments into the unchanged final report,
projects exact final path and canonical-input coverage from the frozen manifest and persisted
blind assessment instead of asking the model to repeat those ledgers,
derives blockers from blocking finding corrections, derives fast follows from
non-blocking corrections and reviewer suggestions, and assigns the final verdict from
those actions plus runner-owned coverage and unresolved limitations. Candidate-v3
verdict and blocker fields remain wire-compatible but have no authority. This prevents
bookkeeping contradictions from buying a repair call or inventing work,
using exact original author-claim and preliminary-concern text, validates
identities and evidence paths, rejects citations outside transmitted hunks even when the line exists
elsewhere in the frozen file,
requires exact changed-path/canonical-input coverage and preliminary-concern
dispositions, narrows the first final-call concern schema to the persisted
preliminary scope (zero concerns permits only an empty ledger), validates line/symbol anchors against frozen blobs, and renders
the complete, presentation-safe reconciliation ledger to Markdown. Final-only
findings require a non-empty emergence rationale while preliminary-origin
findings structurally require a null rationale, and author-reported commands
cannot be promoted to runner-confirmed evidence. Each stage specializes its provider-facing
schema with the frozen snapshot's permitted evidence paths, exact identities,
coverage sizes, and author-verification indices, while retaining
local semantic and anchor validation. Compact project guidance preserves every
non-empty heading/list/prose block and fails before a provider call if the full
digest cannot fit. It conservatively reserves preliminary, possible verifier,
and final message/schema inputs and outputs before the first submission, uses that same
token-unit reservation when retransmitting the preliminary result, and retains
reservations when usage is missing or malformed. It also rejects a known
author-inclusive final conversation skeleton that exceeds the byte cap before
making call one, then rechecks actual generated content before each later call.
Its private run record binds each attempt to the provider-policy version and
credential-free wire/body digests and records stage, identity, timing, route,
valid usage, errors, and lifecycle-terminal events. The OpenRouter adapter uses
strict structured output, an explicit model, same-model fallback inside a
configured provider allowlist, hard price ceilings, ZDR-only routing,
data-collection denial, disabled response caching, and disabled context
compression. A definite final-stage provider 429 may be resumed once explicitly
from the persisted preliminary assessment and exact original run configuration;
uncertain transport and model changes are rejected. Provider attempts retain a
private, API-key-redacted raw response artifact before validation. Guarded final
attempts retain a bounded redacted SSE transcript and progress metrics after
terminal handling; the artifact is intentionally not described as byte-exact or
crash-durable. The append-only ledger retains only bounded diagnostics for the
typed error, requested/returned route identifiers, and retry guidance.[^or-structured][^or-routing][^or-transforms][^or-response-cache][^or-errors]

New packets also persist a digest-bound, language-neutral context map. A pinned
Tree-sitter WASM registry adds declaration regions for JavaScript,
TypeScript/TSX, Python, Go, and Java while every other language retains the
universal file fallback. Before provider admission, orchestration persists a
deterministic review-unit plan and sends its compact changed-path, enclosing
declaration, transmitted supporting-context mapping, and bounded producer
diagnostics with blind evidence. Exact blob-backed range checks and per-file and
packet-wide syntax limits keep these artifacts trustworthy and bounded. These
artifacts separate coverage bookkeeping from reviewer judgment; semantic symbol mapping
and per-unit provider batching remain follow-up work under ADR-009.

Metered live review remains explicitly opt-in and requires a model, bounded
configuration, operator authorization, and API key supplied through the Slice 3 command.

### Slice 3 — usable command and AI Central integration

Compose preparation and review behind one practical `review` command, keep
failure diagnostics readable, and update the existing skill to invoke it while
preserving the loop and pivot rules. Gate: one implementation flow can review
externally and consume its findings. Run AI Central's required
`./scripts/check.sh` for its changes.

Progress: complete. `review --request <path> --config <path>` composes frozen
capture with the two-stage OpenRouter run, reads the API key only from
`OPENROUTER_API_KEY`, prints the local Markdown report path, and distinguishes
review outcomes and uncertain transport with stable exit codes. Runner request
and config files are visibly excluded from review evidence so an author packet
stored inside the worktree cannot leak into the blind stage. The AI Central
skill now routes explicitly authorized external reviews through this command
while retaining its original fresh-task workflow as a fallback.

### Deferred until requested

- an evidence service serving bounded file reads, searches, and diff context from the
  frozen snapshot on request (see ADR-005: the brief carries no capability
  declaration, so a reviewer receives one fixed payload and can request nothing);
- broad model comparisons or a large quality-evaluation framework;
- isolated or containerized execution of arbitrary repository tests;
- broader provider pools, model fallback, or distributed resumability; and
- any GitHub/GitLab bot, webhook service, database, daemon, or web UI.

A few focused known-defect and clean fixtures remain part of Slice 2; they are
not a separate product milestone.[^openai-evals][^anthropic-evals]

## Initial product scope

First useful release: local CLI, one primary reviewer conversation, selective fresh-context finding verification, enforced author withholding, bounded snapshot reads, static inspection, structured findings, local audit artifacts, and AI Central invocation. Preserve module boundaries for a bot while keeping hosting-specific APIs outside the core.

Proposed future command surface:

```text
independent-reviewer prepare --repo <path> --base <ref> --head <ref>
independent-reviewer inspect --packet <path>
independent-reviewer review --packet <path> --config <path>
independent-reviewer report --run <id> --format markdown
```

Exact working-tree and author-packet options follow the capture contract. A failed or incomplete review must produce a distinct non-success exit status and a readable diagnostic artifact.

## Decisions to settle before live use

Production model/provider selection, representative numerical token and cost
budgets, repository configuration, and the private run-directory default remain
open. The first smoke uses the accepted bounded policy from the
[provider failover research spike](research/2026-09-08-openrouter-provider-failover-and-cost-spike.md).
Runtime and development dependencies are exact-pinned.

The initial scope now includes cumulative working-tree snapshots. The base
resolves from an explicit value, repository configuration, branch upstream, or
remote default branch in that order and fails when still ambiguous. The shipped
local engine uses one external reviewer conversation, an immutable blind
assessment, a selective fresh-context finding verifier, and a separately delivered
author packet. Clean reviews use two provider calls; finding-bearing reviews use
three. At most one same-model output repair remains available for preliminary and
final stages; verification output fails closed without repair. Preliminary repair
remains blind, persists both candidates, and must reserve its own call plus the
still-possible verifier and mandatory final call before spending.
Interactive author ask-backs and a named-check executor remain protocol
extensions rather than first-release requirements. Token efficiency is a
first-class correctness constraint; required evidence cannot be silently
omitted to fit a budget.

Controlled metered smoke fixtures exercised known-bad, clean, and steering-rule
changes with the normal output cap. They validate transport and orchestration,
not general review accuracy. Bot publication remains deferred.

[^or-structured]: OpenRouter, [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
[^or-routing]: OpenRouter, [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection).
[^or-transforms]: OpenRouter, [Message Transforms](https://openrouter.ai/docs/guides/features/message-transforms).
[^or-response-cache]: OpenRouter, [Response Caching](https://openrouter.ai/docs/guides/features/response-caching).
[^or-prompt-cache]: OpenRouter, [Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
[^or-errors]: OpenRouter, [Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging).
[^openai-evals]: OpenAI, [Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
[^anthropic-evals]: Anthropic, [Define Success Criteria and Build Evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests).
