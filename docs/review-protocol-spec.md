# Review protocol technical specification

Status: accepted protocol; implementation is in progress.

This specification turns the independent-review workflow in
[`docs/architecture-and-roadmap.md`](architecture-and-roadmap.md) into an
enforceable local protocol. It defines the first implementation slice; it does
not select a default model. The TypeScript and Node.js runtime is adopted in
[ADR-002](decisions/002-use-typescript-node-runtime.md). The model-call and
budget protocol is adopted in
[ADR-003](decisions/003-use-versioned-budgeted-model-call-protocol.md).

## Objective

Build a local review engine that lets an implementation agent submit a frozen
repository target, neutral task context, and a separate author explanation in
one invocation. The engine must give a fresh external reviewer the neutral
material first, durably record its preliminary assessment, and only then expose
the author explanation. The same reviewer may inspect bounded evidence, request
configured local verification, ask the author at most three follow-up rounds,
and return a validated readiness report.

The primary initial user is an engineer or implementation agent requesting a
senior-maintainer-style review before merging work. The first adapter is a local
CLI using OpenRouter. Hosting-provider automation is out of scope.

## Agreed decisions

1. A dirty branch is reviewed cumulatively from its resolved base through the
   current working-tree state by default. This includes committed, staged,
   unstaged, deleted, renamed, and eligible untracked content.
2. The implementation side may submit neutral context and the author
   explanation together, but the engine stores and delivers them separately.
3. Canonical requirements, the implementation plan, applicable project-owned
   steering, and the frozen changeset are available during the blind stage.
   Author rationale and implementation-story content are not.
4. The preliminary assessment is durable and immutable before the author
   explanation is unlocked.
5. Reconciliation continues in the same external reviewer conversation.
6. After author delivery, the reviewer may make at most three author ask-backs.
   Each ask-back may contain multiple related questions.
7. Evidence reads and verification requests have independent limits; they do
   not consume author ask-backs.
8. Verification is performed by a bounded local executor, not another agent.
   The reviewer selects only configured named checks.
9. Token efficiency is a product invariant. Limits are explicit, measurable,
   and failure-producing; the engine must not silently truncate evidence or
   convert budget exhaustion into a successful review.
10. The initial provider adapter uses non-streaming Chat Completions with a
    locally persisted authoritative message ledger.
11. Trusted policy, tool schemas, stage instructions, and response schemas are
    versioned independently. Stable trusted content precedes dynamic untrusted
    evidence.
12. The preliminary assessment also requests the author packet. The engine does
    not spend a separate model call merely asking for material it already holds.
13. Independent evidence requests are batched where possible. The engine
    reserves capacity for a final non-ready or limitation report before
    optional evidence, verification, repair, or author turns.
14. Provider context compression, live-review response caching, automatic model
    fallback, and undeclared provider fallback are disabled.
15. The orchestrator owns retries. Potentially submitted transport failures are
    not blindly retried, and complete invalid model output permits at most one
    explicitly budgeted repair attempt.
16. Exact model, reasoning, prompt, and numerical budget defaults require a
    small task-specific evaluation; choose the least costly configuration that
    meets recorded quality thresholds.

## Success criteria

The first offline end-to-end implementation is complete when fixtures prove
all of the following without a live model call:

- An unchanged repository target and canonical input set produce the same
  snapshot and packet identities.
- A default dirty-tree capture contains all cumulative branch and working-tree
  changes and makes every exclusion or unsupported item visible.
- The mock provider cannot observe author content before the preliminary
  assessment is validated and persisted.
- A resumed run cannot leak the author packet into a restarted blind stage.
- The final report retains the preliminary assessment and accounts for changed,
  withdrawn, and newly added findings.
- Author ask-backs stop after three rounds even when a round contains several
  questions.
- Evidence and named verification calls obey separate count, byte, time, and
  token budgets.
- Verification records distinguish author claims, runner-observed results, and
  checks that were requested but unavailable.
- Malformed model output, invalid evidence anchors, incomplete scope, transport
  uncertainty, and exhausted budgets cannot result in `Ready`.
- All model-bound content can be inspected locally before transmission.

One or two explicitly enabled OpenRouter smoke runs may follow the offline gate.
They validate transport and provider behavior, not review quality in general.

## Non-goals for the first implementation

- Multiple reviewers, debate, voting, or model ensembles.
- A general-purpose shell tool controlled by the external reviewer.
- Universal dependency installation or hermetic execution for every repository.
- Autonomous fixes, commits, new review instances, or publication.
- A daemon, web UI, database server, or GitHub/GitLab adapter.
- Recreating the existing independent-review skill as a runtime prompt file.
- Large evaluation suites intended to re-prove the already established human
  workflow before an initial usable release exists.

## Protocol overview

```text
Implementation side
  |
  | review request: neutral inputs + separately labeled author packet
  v
Prepare and validate frozen target
  |
  | blind brief + bounded initial evidence
  v
Fresh external reviewer
  |
  | preliminary assessment
  v
Validate and persist immutable preliminary record
  |
  | author packet
  v
Same reviewer conversation
  |\
  | +-- bounded snapshot evidence calls
  | +-- bounded named verification calls
  | +-- at most three author ask-backs
  v
Validate final report
  |
  v
Implementation side: accept, dispute with evidence, or defer findings
```

The engine, rather than prompt text or reviewer cooperation, enforces every
visibility transition.

## Trust and data boundaries

### Trusted local policy

Runner configuration supplied outside the reviewed change controls provider
routing, data policy, budgets, snapshot policy, permitted evidence operations,
verification catalog, persistence, and publication. Reviewed repository content
cannot grant permissions or modify these controls.

### Untrusted evidence

Repository files, diffs, comments, requirements, plans, author claims, tool
arguments from the model, and provider responses are untrusted. They are parsed
and validated at their boundaries. Instruction-like repository text remains
evidence and is never executed as runner policy.

### Secret boundary

Provider credentials are read at runtime and never enter packets, messages,
tool results, reports, or persisted run records. Files matching the configured
secret and exclusion policy are not transmitted merely because the reviewer
requests them.

### Remote disclosure boundary

The local packet may contain the complete permitted review target. The remote
reviewer initially receives only the declared transmission plan. Every later
excerpt, search result, diff hunk, and verification output returned through a
tool becomes model-transmitted content and is appended to the audit ledger.

## Inputs and persisted artifacts

Every artifact carries a `schemaVersion`. Identifiers are opaque strings with a
type prefix; content identities use a declared digest algorithm and canonical
serialization.

Committed JSON Schema artifacts define the portable structural layer and are
useful for callers and provider-constrained output. JSON Schema cannot portably
express every relational invariant in these contracts, including equality and
set correspondence across fields. Each artifact therefore declares this limit
in `$comment`. Schema-only success is never contract acceptance: consumers must
also run the versioned runtime semantic validator or an equivalent
implementation with parity fixtures. The TypeScript runtime's Zod schemas are
the authoritative validator for the initial release.

### Review request

The caller supplies:

- repository path;
- optional explicit base and head;
- working-tree inclusion policy, cumulative by default;
- canonical requirements and their provenance;
- implementation plan and its provenance;
- optional additional neutral project guidance;
- author packet as a separately typed input;
- review configuration reference; and
- flow identity, review-instance number, and maximum instances.

The author packet may be absent at preparation time. A run then enters
`AWAITING_AUTHOR` after preliminary persistence.

Implementation status: `ReviewRequestV1Schema` currently enforces this request
boundary, including a separately typed optional author packet, cumulative
working-tree defaults, contextual canonical-input kinds, and review-instance
bounds. The snapshot and orchestration layers do not exist yet, so structural
separation is not yet a claim that runtime author withholding has been proven.
Its committed structural JSON Schema describes caller input; defaulted fields
remain optional at the serialized boundary and are materialized during local
semantic validation.

### Snapshot manifest

The snapshot manifest records:

- source repository identity and resolved Git base/head;
- branch, staged/unstaged state, and capture boundary;
- snapshot digest and per-path content digests;
- change classification, including additions, deletions, renames, and modes;
- included untracked paths;
- submodules, symlinks, binaries, generated files, and unsupported content;
- explicit exclusions and omissions with reasons;
- canonical input identities and provenance;
- capture and transmission policy versions; and
- capture race checks.

Snapshot identity excludes wall-clock timestamps and local storage paths so
unchanged logical inputs remain reproducible.

Implementation status: `SnapshotManifestV1Schema` now defines the strict
persisted boundary for source commits, dirty-state evidence, typed path changes,
content digests, exclusions, omissions, canonical-input identities, policy
versions, and stable capture-race evidence. It validates normalized relative
paths, exact untracked-path accounting, Git kind/mode compatibility, and
meaningful relocation paths. Git capture and per-content digest construction
remain separate follow-on work. The identity finalizer now
validates digest-free manifest material, normalizes set-like ledgers, and
computes a reproducible JCS/SHA-256 logical digest. Opaque run metadata and
capture-attempt count do not alter that digest; changes to captured source or
content identity do. Canonical-input digests bind the complete validated input,
and neutral-brief validation reconciles those digests with its embedded
canonical content. Raw captured-file digest construction remains deferred.

### Neutral review brief

The brief contains only information permitted before preliminary persistence:

- objective and observable success criteria;
- canonical requirements and plan;
- applicable project-owned steering;
- resolved target identity and complete path/change manifest;
- deterministic initial diff and source context;
- known exclusions and coverage constraints; and
- available evidence and verification capabilities.

It must not contain author rationale, retrospective implementation narration,
claimed design intent that is not canonical, prior reviewer verdicts, or the
implementation conversation.

Implementation status: `NeutralReviewBriefV1Schema` now provides a strict
blind-stage boundary containing canonical-source-attributed objectives and
criteria, canonical inputs, one complete snapshot manifest, bounded initial
evidence, visible coverage constraints, and capability identifiers. Runtime
validation rejects undeclared author fields, canonical-input identity mismatch,
duplicate evidence identifiers, evidence outside the manifest, source context
for a path/side that does not exist, and invalid source ranges. Orchestration
must still prove that only this artifact is sent before preliminary persistence.
A required `briefDigest` now binds the exact ordered blind-stage content, and
its finalizer refuses an embedded manifest whose snapshot identity does not
verify.

The artifact identity profile uses RFC 8785 JCS over UTF-8 followed by SHA-256,
with versioned domain separation. The field projections, normalization rules,
failure behavior, and alternatives are recorded in
[ADR-004](decisions/004-use-jcs-sha256-artifact-identities.md).

### Author packet

The author packet is self-contained and contains:

- intent and success criteria;
- plan-to-implementation traceability;
- technical approach and control/data flow;
- changed-component walkthrough;
- important decisions and rejected alternatives;
- invariants and boundary conditions;
- verification claims with exact commands and reported outcomes;
- risks, tradeoffs, maintenance costs, deviations, and known gaps; and
- challenge points for the reviewer.

Its digest is fixed at review-request validation. If the packet changes after
the blind stage, it becomes a new artifact version and the change is recorded.

### Preliminary assessment

The preliminary assessment contains:

- snapshot and neutral-brief identities;
- inspected areas and an initial coverage ledger;
- preliminary findings with stable identifiers;
- suspected missing evidence and proposed evidence requests;
- plan or requirement coverage concerns;
- verification requests, if permitted during the blind stage; and
- limitations and current uncertainty.

It is append-only after persistence. Final reconciliation refers to preliminary
finding IDs rather than rewriting the record.

### Final review report

The final report contains:

- preliminary and final artifact identities;
- final P0-P3 findings with scenario, impact, evidence, and smallest credible
  correction;
- a disposition for every preliminary finding: retained, revised, withdrawn,
  or merged, with rationale;
- final-only findings and why they emerged later;
- plan and acceptance-criteria coverage;
- an author-claim ledger with confirmed, contradicted, or unverified status;
- verification records and their provenance;
- unanswered author questions, evidence gaps, and residual risks;
- any material-pivot decision gate;
- one verdict: `Ready`, `Ready with non-blocking follow-ups`, `Not ready`, or
  `Unable to verify`; and
- recommended next actions split into blockers and non-blocking fast follows.

Fast follows cannot contain work required to justify a `Ready` verdict.

## Lifecycle state machine

```text
PREPARING
  -> BLIND_REVIEW
  -> PRELIMINARY_VALIDATING
  -> PRELIMINARY_PERSISTED
  -> AWAITING_AUTHOR
  -> RECONCILING
  -> FINAL_VALIDATING
  -> COMPLETED

Any active state may enter FAILED.
Scope, evidence, or budget limits may enter UNABLE_TO_VERIFY.
Transport ambiguity enters TRANSPORT_UNCERTAIN until explicitly resolved.
```

| State | Durable entry condition | Allowed next actions |
| --- | --- | --- |
| `PREPARING` | Request accepted and run record created | Capture, validate, inspect, fail |
| `BLIND_REVIEW` | Snapshot and neutral brief persisted | Reviewer/evidence exchange only |
| `PRELIMINARY_VALIDATING` | Candidate preliminary output persisted separately | Validate or fail; author remains locked |
| `PRELIMINARY_PERSISTED` | Valid immutable preliminary record exists | Unlock author delivery |
| `AWAITING_AUTHOR` | Author input absent or a requested response is pending | Supply author content or end unable to verify |
| `RECONCILING` | Author packet delivery is recorded | Evidence, verification, up to three ask-backs, final response |
| `FINAL_VALIDATING` | Candidate final response persisted separately | Validate and complete or fail visibly |
| `COMPLETED` | Valid final report and rendered output persisted | Return control only |
| `TRANSPORT_UNCERTAIN` | Submission may have reached the provider without a reliable response | Operator decision; no blind retry |
| `FAILED` | Non-review failure record persisted | Diagnose or explicitly resume where safe |
| `UNABLE_TO_VERIFY` | A valid limitation report explains why review cannot complete | Return control only |

A resume loads the persisted state and may only perform actions allowed from
that state. It never reconstructs stage visibility from conversation history
alone.

## Reviewer interaction protocol

### Provider messages

The initial adapter uses non-streaming Chat Completions. The project's local
message ledger, not provider-managed state, is authoritative. OpenRouter's thin
client is intended for application-owned conversation and tool loops, while its
TypeScript Responses surface is currently beta.[^or-client][^or-responses]

1. Create a fresh local message ledger for the review instance.
2. Send a stable, versioned trusted policy message before the dynamic untrusted
   neutral brief. The policy defines outcome, success criteria, trust and
   permission boundaries, verdict constraints, efficiency rules, and stop
   conditions. Tool and response schemas use API fields instead of duplicated
   prose.[^openai-prompting]
3. Send the snapshot identity, canonical inputs with provenance, complete
   changed-path manifest, visible omissions, initial changed hunks, and current
   budget as the blind-stage message.
4. Broker zero or more bounded evidence requests. Execute independent requests
   as one batch where possible and append one deterministic ordered result.
5. Accept only a strict schema-valid preliminary assessment whose next action
   requests the author packet. Persist the candidate, validate it locally, and
   persist the immutable valid record before unlocking author content.
6. Append the separately typed author packet in the same conversation ledger.
7. Broker bounded evidence, named verification, and up to three grouped author
   ask-backs.
8. Accept and validate the strict final-report schema, then render human-readable
   Markdown locally.

Strict structured output is a transport aid, not a trust boundary. Syntax,
schema, lifecycle, semantic, and evidence-anchor validation still occur
locally.[^or-structured]

The provider adapter records requested and returned model/provider metadata,
request IDs, token usage, cost when available, timings, and transport failures.
It also records prompt, tool, and schema versions plus safe router metadata. It
does not claim metadata the provider did not return or enable request-body debug
echo in normal operation.[^or-metadata]

### Author ask-backs

An ask-back is one reviewer-to-author turn followed by one author response. A
round may contain multiple questions but must be represented as one structured
request. The orchestrator numbers rounds `1..3` and rejects a fourth.

An author response is appended as testimony. It cannot replace the original
author packet or preliminary assessment. If no response arrives, the reviewer
may finish with the question unresolved or return `Unable to verify` when the
missing information is essential.

## Evidence service

The provider receives a narrow tool surface backed only by the frozen snapshot:

| Operation | Purpose | Principal limits |
| --- | --- | --- |
| `read_snapshot_file` | Read exact line ranges from a permitted text file | Path, range, bytes, calls |
| `read_diff` | Read changed hunks for paths or stable hunk IDs | Paths, hunks, bytes, calls |
| `search_snapshot` | Literal or restricted-pattern search | Pattern length, result count, bytes, calls |
| `read_canonical_input` | Read a declared requirement, plan, or steering section | Declared artifact IDs only |
| `request_verification` | Run one configured named check | Check IDs, calls, time, output bytes |

All inputs are schema-validated. Paths are normalized and rejected on absolute
access, traversal, symlink escape, submodule escape, exclusion-policy conflict,
or snapshot mismatch. Responses contain stable evidence coordinates and content
digests so the report validator can confirm anchors.

One reviewer turn may request several independent evidence operations. The
orchestrator executes permitted operations concurrently when safe, charges each
against its own limits, and returns one result batch ordered by request ID. A
result contains coordinates, digest, content or status, and explicit clipping
and continuation markers. This reduces model round trips without hiding per-tool
accounting.

No generic filesystem, network, shell, write, Git mutation, or publication tool
is exposed to the reviewer.

## Local verification executor

Review configuration declares a catalog of named checks. A reviewer chooses an
ID, never a shell string. Each entry defines:

- human-readable purpose;
- exact command and arguments;
- working directory relative to the snapshot root;
- timeout and output-byte limit;
- network policy;
- required environment variable names, never their secret values;
- expected isolation level; and
- whether the check is enabled for external request.

The executor runs against a disposable reconstruction of the frozen target when
the configured repository environment supports it. It does not run a requested
check in the user's mutable checkout merely because the command appears
non-mutating.

If dependencies or the required isolation cannot be made available, it returns
a structured `UNAVAILABLE` result. The report distinguishes:

- `AUTHOR_CLAIMED`: described by the author but not observed by this runner;
- `RUNNER_OBSERVED`: command, environment, exit status, and output observed;
- `REQUESTED_UNAVAILABLE`: requested but not safely executable; and
- `NOT_REQUESTED`: relevant check not requested within the review.

Universal environment construction is deferred. Initial fixtures may use a
small repository whose named checks need no network or dependency installation.

## Token and cost efficiency

The
[prompt, call, and token-efficiency research spike](research/2026-09-07-prompt-call-and-token-efficiency-spike.md)
is accepted by
[ADR-003](decisions/003-use-versioned-budgeted-model-call-protocol.md). This
section defines its normative behavior.

Efficiency is part of review correctness because metered limits influence how
much evidence can be assessed. Every run has a declared budget envelope:

- maximum input, output, reasoning, cached, and total tokens per stage and run;
- maximum estimated and reserved dollars per call, stage, and run;
- maximum model calls and output-repair attempts;
- maximum evidence calls and returned bytes;
- maximum verification calls and returned bytes;
- maximum author ask-back rounds;
- maximum accumulated conversation bytes;
- maximum wall-clock time; and
- provider retry limits.

OpenRouter reports prompt, completion, reasoning, cache, and cost data, but
tokenizers differ between models.[^or-usage] The engine records four distinct
quantities and never substitutes one for another:

1. exact serialized wire bytes;
2. estimated tokens with estimator identity and uncertainty margin;
3. provider-reported usage; and
4. estimated, reserved, and actual dollars.

Missing provider usage remains unknown and reserved; it is never treated as
zero.

### Context strategy

1. Put stable trusted policy first and dynamic untrusted evidence last. This is
   easier to audit and preserves the common prefix used by provider prompt
   caching when that feature is later enabled.[^or-prompt-cache]
2. Keep the complete permitted snapshot locally.
3. Build a deterministic transmission plan from changed paths, requirements,
   plan, and policy—not from author emphasis.
4. Send compact manifests, stable IDs, changed hunks, and only the surrounding
   context needed to understand those hunks.
5. Let the reviewer pull additional frozen evidence through bounded tools and
   batch independent requests into one continuation.
6. Refer to prior artifacts and IDs instead of retransmitting large text in
   later messages when the provider conversation already contains it.
7. Cap tool output before provider transmission and make clipped results
   explicit with continuation coordinates.
8. Use concise schema fields and structured ledgers; generate human-readable
   Markdown locally from validated structured output.
9. Estimate tokens and cost before the first call. Estimates are advisory, not
   billing guarantees.
10. Reconcile each reservation against provider-reported usage and cost when
    available.

For small targets, the initial brief may contain the entire textual diff. For a
target that exceeds the initial-context budget, the engine must either use the
declared progressive transmission plan or fail preflight. It may not silently
drop files or hunks.

The admission check requires estimated accumulated input plus configured maximum
output plus an explicit uncertainty margin to fit within the selected provider
endpoint's context limit. The request records the model metadata and price basis
used for this decision.[^or-models]

Provider context compression is explicitly disabled because OpenRouter may
remove or truncate messages from the middle.[^or-transforms] Response caching is
disabled for live reviews because it stores and replays complete successful
responses and is unavailable with account-level ZDR.[^or-response-cache] Prompt
caching remains disabled by default until the selected privacy policy permits
it and an evaluation demonstrates net savings. Correctness never depends on a
cache hit.

### Reservation and backstops

Before every provider call, reserve its configured maximum output/reasoning cost
and any per-request charge. Before optional evidence, verification, repair, or
author turns, also reserve enough capacity for either a valid final non-ready
report or an `Unable to verify` limitation result.

Reject a call whose conservative upper bound exceeds the remaining run cap.
Reconcile the reservation after the response, retaining the full reservation
when usage is unknown. A dedicated OpenRouter key with an appropriate spending
limit provides an independent account-side backstop, but does not make an in-
flight request an exact hard cap.[^or-limits]

### Budget exhaustion

When a mandatory reservation cannot be made, the engine records the exhausted
dimension and requests a bounded limitation report only if that capacity was
already reserved. Otherwise it creates a local diagnostic. Budget exhaustion
cannot produce `Ready`; the normal result is `Unable to verify` unless a
complete valid non-ready report already exists.

## Base and scope resolution

The base resolves in this order:

1. explicit CLI value;
2. repository review configuration;
3. current branch upstream;
4. remote default branch; then
5. fail as ambiguous.

No branch name is guessed. The resolved base commit is persisted.

The default head is the current working-tree boundary, captured cumulatively.
Explicit scope modes may later support committed-only or uncommitted-only
reviews. Narrow modes must be named in the manifest and warn when related branch
changes are excluded.

Capture reads Git metadata and file content, validates the boundary afterward,
and retries a bounded number of times or fails on a race. Review-time evidence
always comes from the frozen snapshot, never the live checkout.

## Proposed CLI boundary

The initial command families remain:

```text
independent-reviewer prepare --request <path> [--base <ref>]
independent-reviewer inspect --packet <path>
independent-reviewer review --packet <path> --config <path>
independent-reviewer report --run <id> --format json|markdown
```

`prepare` performs no provider call. `inspect` shows the full local packet and
the exact initial transmission plan separately. `review` resumes or advances
the persisted state machine. `report` renders only validated persisted data.

Exact convenience flags can be added after the request, packet, and run-record
schemas are accepted. A single `review --repo .` workflow may compose these
commands later without weakening their boundaries.

## Logical module boundaries

The implementation should preserve these interfaces regardless of language:

```text
contracts       Versioned schemas and canonical serialization
snapshot        Git scope resolution, capture, hashing, and transmission plan
evidence        Read-only bounded access to captured evidence
verification    Named-check validation and local execution
provider        OpenRouter transport and response/tool-call parsing
orchestrator    State transitions, visibility, limits, resume, and audit ledger
report          Evidence validation and JSON-to-Markdown rendering
cli             Argument parsing, composition, exit codes, and user diagnostics
```

The snapshot module cannot call a model. The provider cannot read the
filesystem or run commands. The verification executor cannot see provider
credentials. The report renderer cannot invent missing evidence or mutate a
verdict.

## Error and exit semantics

Errors are structured with a stable code, safe message, stage, retryability,
and optional diagnostic artifact reference. At minimum, distinguish:

- invalid request or configuration;
- ambiguous or changed review scope;
- excluded, unsupported, or oversized required evidence;
- invalid model or tool output;
- author unavailable;
- verification unavailable or failed;
- budget exhausted;
- definite transport failure;
- uncertain transport after possible provider submission; and
- invalid final report.

### Provider retry and output repair

The adapter inspects typed error category, response body, and finish reason in
addition to HTTP status. OpenRouter may return an error inside HTTP `200` after
generation has begun and may transform token-limit failures into a `length`
finish reason.[^or-errors]

- Disable SDK retries or configure them to a verified minimal value. The
  orchestrator owns the effective retry limit, delay, cost reservation, and
  attempt ledger.
- Do not retry request, authentication, credit, permission, policy, payload, or
  schema errors automatically.
- A clear pre-generation transient rejection may receive a bounded identical
  retry. Honor `Retry-After` when provided and reserve the full possible cost of
  every attempt.
- A connection loss or client timeout after possible submission enters
  `TRANSPORT_UNCERTAIN`. Do not retry it automatically. When a generation ID is
  available, metadata lookup may recover accounting and route evidence, but is
  not treated as an idempotency or content-recovery guarantee.[^or-generation]
- Preserve an HTTP `200` body containing an error, an error finish reason, or
  partial content as a failed candidate. It cannot cross a stage boundary.
- Preserve a `length` result as truncated. A new attempt with changed context or
  output allowance is explicit, separately budgeted, and never validates the
  truncated candidate as complete.
- Preserve complete JSON that fails local syntax, schema, semantic, lifecycle,
  or evidence validation. Permit at most one separately recorded repair request
  containing the exact validation errors, then validate the entire replacement.
- Keep OpenRouter response healing disabled initially because it mutates JSON
  syntax, does not repair truncation or general semantic/schema errors, and
  would obscure the raw invalid candidate.[^or-healing]
- Refusal, content-policy failure, unresolved invalid output, and exhausted
  budget result in visible failure or `Unable to verify`; do not camouflage the
  input or switch models silently.

Provider fallback, model fallback, and prompt modification are policy changes,
not transport retries. Every attempt has a monotonic attempt number and the
digest of the exact stage input it used. No attempt erases earlier cost,
candidate, error, or uncertainty records.

The CLI uses different non-zero exits for invalid input, failed execution,
transport uncertainty, and completed `Not ready`/`Unable to verify` review
outcomes. Exact numeric values belong in the CLI contract.

## Persistence and privacy

Runs are stored under a configured private directory excluded from Git. Each run
keeps request, manifest, transmission ledger, preliminary candidate and valid
record, author packet versions, provider exchanges, verification records, final
candidate, validation errors, and validated report as separate artifacts.

Persistence is append-oriented. Sensitive proprietary content is not placed in
the repository by default. Retention and deletion policy remain configuration
decisions before live use.

## Implementation sequence

1. Define and fixture-test versioned request, manifest, packet, preliminary,
   author, report, run-record, and error schemas.
2. Implement canonical serialization, digesting, base resolution, and cumulative
   working-tree capture.
3. Implement inspection, transmission-plan generation, and bounded evidence
   reads against the frozen snapshot.
4. Implement the persisted orchestrator against a mock provider, including
   author withholding, preliminary validation, three ask-backs, budgets, and
   resume behavior.
5. Implement a fixture-only named verification executor and provenance records.
6. Add the OpenRouter adapter behind the same provider interface and run an
   explicitly enabled smoke review.
7. Add convenient CLI composition and update the AI Central workflow only after
   the protocol version is stable enough to consume.

## Boundaries

Always:

- validate external inputs and provider outputs;
- persist before crossing a visibility or stage boundary;
- identify all model-transmitted evidence;
- preserve omissions, uncertainty, and failed verification;
- keep author claims distinguishable from observed results; and
- fail closed on ambiguous scope, visibility, or budget state.

Ask first:

- expand the accepted runtime dependency set beyond the inspected scaffold;
- permit networked verification or dependency installation;
- add automatic retention/deletion behavior;
- enable prompt caching, response caching, provider context compression,
  provider/model fallback, or a broader provider data policy; or
- change the review-instance or author ask-back defaults.

Never:

- expose author content during the blind stage;
- execute model-provided shell commands;
- read evidence from the live checkout after capture;
- place credentials in an artifact or model message;
- hide required content to fit a budget; or
- let the reviewer fix code, publish output, or expand its own review limits.

## Open decisions before implementation

1. Inspect and pin exact schema, CLI, quality, and OpenRouter transport package
   versions for the accepted TypeScript 6 and Node.js 24 LTS runtime.
2. Choose the first explicit model, reasoning level, provider-routing/data-
   policy configuration, and numerical token, cost, evidence, verification,
   retry, and duration budgets using one representative repository change and
   the minimal evaluation categories in milestone 4.[^openai-evals][^anthropic-evals]
3. Decide whether measured prompt-cache savings justify enabling it under the
   selected privacy and provider-routing policy.
4. Define the first repository configuration format and private run-directory
   default.

[^or-client]: OpenRouter, [Client SDKs](https://openrouter.ai/docs/client-sdks/overview).
[^or-responses]: OpenRouter, [TypeScript Responses SDK reference](https://openrouter.ai/docs/client-sdks/typescript/api-reference/responses).
[^openai-prompting]: OpenAI, [model and prompting guidance](https://developers.openai.com/api/docs/guides/latest-model).
[^or-structured]: OpenRouter, [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
[^or-metadata]: OpenRouter, [Router Metadata](https://openrouter.ai/docs/guides/features/router-metadata).
[^or-usage]: OpenRouter, [Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).
[^or-prompt-cache]: OpenRouter, [Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
[^or-models]: OpenRouter, [Models and metadata](https://openrouter.ai/docs/guides/overview/models).
[^or-transforms]: OpenRouter, [Message Transforms](https://openrouter.ai/docs/guides/features/message-transforms).
[^or-response-cache]: OpenRouter, [Response Caching](https://openrouter.ai/docs/guides/features/response-caching).
[^or-limits]: OpenRouter, [API credit and rate limits](https://openrouter.ai/docs/api_reference/limits) and [API-key spending limits](https://openrouter.ai/docs/api/api-reference/api-keys/create-keys).
[^or-errors]: OpenRouter, [Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging).
[^or-generation]: OpenRouter, [Generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation).
[^or-healing]: OpenRouter, [Response Healing](https://openrouter.ai/docs/guides/features/plugins/response-healing).
[^openai-evals]: OpenAI, [Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
[^anthropic-evals]: Anthropic, [Define Success Criteria and Build Evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests).
