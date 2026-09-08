# Independent Reviewer — architecture and project plan

Status: accepted architecture; implementation is in progress.

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
| Evidence service | Serve bounded file reads, searches, and diff context exclusively from the frozen snapshot. |
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
3. **Blind review.** Start an external conversation containing trusted review policy, neutral requirements, scope, diff, tests, and initial surrounding code. Withhold the author packet at the orchestrator boundary. The model can request bounded evidence reads.
4. **Persist preliminary assessment.** Require a structured preliminary findings and coverage ledger before unlocking the author packet. Persist the response and its input identity. This is a durable artifact; it cannot be overwritten by reconciliation.
5. **Reconcile author claims.** Continue the external review conversation with the author packet. Ask the reviewer to confirm, contradict, or mark claims unverified and explain any changes to preliminary findings. Record missing author explanation explicitly if absent.
6. **Validate and report.** Validate report shape, snapshot identity, path/line anchors, verification provenance, and required coverage fields. Preserve limitations; invalid output, incomplete scope, or exhausted context cannot become an empty successful review. An evidence anchor proves a location exists, not that a finding is true.
7. **Return control.** The implementation workflow accepts, disputes with evidence, or defers each finding. A materially changed target needs a new snapshot and review instance within the original flow limit. The reviewer cannot dispatch fixes or start new reviews.

Both model stages belong to one review instance. Transport retries do not create new review instances and must not be used to shop for a favorable verdict. A resumed run uses persisted stage state; it must not leak the author packet into a restarted blind stage.

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

Use an explicit configured model ID. Do not choose an automatic model router for the first release. Select supported models based on tool calling, structured output support, context capacity, and evaluation results. Model choice stays configurable; no named model is selected by this plan.

The initial adapter uses non-streaming Chat Completions with a local authoritative
message ledger. Prompts and response schemas are stage-specific and versioned.
The preliminary response also requests the author packet, avoiding an otherwise
empty model turn. See
[ADR-003](decisions/003-use-versioned-budgeted-model-call-protocol.md).

Use schema-constrained output when supported and validate responses locally
regardless.[^or-structured] Set `require_parameters: true` so routing does not
silently ignore requested capabilities. Prefer an explicit provider policy and
disable fallback for initial reproducibility; a later declared provider
allowlist must record the actual route.[^or-routing]

Explicitly disable provider context compression because it can remove or
truncate messages from the middle.[^or-transforms] Disable response caching for
live reviews because it stores and replays complete responses and is unavailable
with account-level ZDR. Prompt caching remains an opt-in optimization after data-
policy and measured-cost review.[^or-response-cache][^or-prompt-cache]

For source review, propose `data_collection: "deny"` and `zdr: true`, failing when no eligible route exists. OpenRouter describes ZDR as endpoint routing enforcement; this is not a blanket claim about all storage across the application and providers. Review account logging separately. See [provider data-policy and ZDR controls](https://openrouter.ai/docs/guides/routing/provider-selection).

Read the API key at runtime from environment or an external secret store. Keep it out of packets, model messages, tool results, and logs. Bound completion tokens, calls, retries, and time; use pricing estimates for preflight, record actual usage when returned, and never describe a local estimate as a guaranteed billing cap.

The orchestrator owns retries and reserves the maximum permitted cost of each
attempt plus enough capacity for a final non-ready or limitation report. A
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
brief from the packet, fails rather than clipping an oversized initial evidence
set, persists the raw and validated preliminary result before author delivery,
makes exactly one reconciliation call, validates identities and evidence paths,
and renders the final JSON report to Markdown. The OpenRouter adapter uses
strict structured output, an explicit model, no fallback or retry, ZDR-only
routing, data-collection denial, disabled response caching, and disabled context
compression.[^or-structured][^or-routing][^or-transforms][^or-response-cache]
The metered live smoke remains explicitly opt-in until a model and API key are
supplied through the Slice 3 command.

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

- broad model comparisons or a large quality-evaluation framework;
- isolated or containerized execution of arbitrary repository tests;
- multiple providers, fallback routing, or distributed resumability; and
- any GitHub/GitLab bot, webhook service, database, daemon, or web UI.

A few focused known-defect and clean fixtures remain part of Slice 2; they are
not a separate product milestone.[^openai-evals][^anthropic-evals]

## Initial product scope

First useful release: local CLI, one external reviewer, two enforced stages, bounded snapshot reads, static inspection, structured findings, local audit artifacts, and AI Central invocation. Preserve module boundaries for a bot while keeping hosting-specific APIs outside the core.

Proposed future command surface:

```text
independent-reviewer prepare --repo <path> --base <ref> --head <ref>
independent-reviewer inspect --packet <path>
independent-reviewer review --packet <path> --config <path>
independent-reviewer report --run <id> --format markdown
```

Exact working-tree and author-packet options follow the capture contract. A failed or incomplete review must produce a distinct non-success exit status and a readable diagnostic artifact.

## Decisions to settle before implementation

Exact dependency versions; first model and provider policy; concrete token,
cost, evidence, verification, and duration budgets; repository configuration;
and the private run-directory default remain open.

The initial scope now includes cumulative working-tree snapshots. The base
resolves from an explicit value, repository configuration, branch upstream, or
remote default branch in that order and fails when still ambiguous. The shipped
local engine uses one external reviewer conversation, an immutable blind
assessment, a separately delivered author packet, and exactly two calls.
Interactive author ask-backs and a named-check executor remain protocol
extensions rather than first-release requirements. Token efficiency is a
first-class correctness constraint; required evidence cannot be silently
omitted to fit a budget.

No metered external review or bot publication was performed during planning or
implementation; a live smoke review remains explicit and operator-authorized.

[^or-structured]: OpenRouter, [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
[^or-routing]: OpenRouter, [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection).
[^or-transforms]: OpenRouter, [Message Transforms](https://openrouter.ai/docs/guides/features/message-transforms).
[^or-response-cache]: OpenRouter, [Response Caching](https://openrouter.ai/docs/guides/features/response-caching).
[^or-prompt-cache]: OpenRouter, [Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
[^or-errors]: OpenRouter, [Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging).
[^openai-evals]: OpenAI, [Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
[^anthropic-evals]: Anthropic, [Define Success Criteria and Build Evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests).
