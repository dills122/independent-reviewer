# Standards-based code review: implementation plan

Status: slices 1–5 implemented and verified offline; eight live cases executed, exposing delivery and semantic acceptance gaps. See [live results](../validation/2026-09-09-standards-live.md). Updated 2026-09-09. Baseline: `8322b9edad655f932352329e6db11bda43383ef8` (PR #66). This revision supersedes the earlier requirements/plan-driven product proposal in this file. Its structured-profile onboarding is now the legacy/advanced path; the accepted next user-facing layer is tracked in the [friendly operations plan](../plans/2026-09-11-friendly-reviewer-operations-plan.md).

## Agreed outcome

Review changed code against applicable standards and return useful, concrete feedback on readability, complexity, duplication, module boundaries, maintainability, and project conventions. Keep the existing author/agent overview and explanation. Business requirements and a separate implementation plan are not prerequisites for this mode.

The first release combines three benefits: simple invocation, actionable standards findings, and clear progress/recovery. Bug hunting, fuzzing, runtime verification, autonomous fixes, and PR hosting integration remain later phases. Reviewing the reviewer's own implementation still includes correctness tests: product scope does not restrict our engineering checks.

Owner lifted the earlier no-TDD/testing-work restriction. Use focused test-first work where it clarifies new behavior or a failure; run normal required checks. Other limits are not implicitly lifted: no extra paid runs, publication, wider provider routing, or destructive actions solely because testing is now allowed.

## Data flow

Collect code target, standards, and author overview before submission; freeze each input and record its provenance. No mid-review request for author input is necessary.

| Point | Data available to model | Runner obligation |
| --- | --- | --- |
| Call 1: independent assessment | Frozen diff, captured surrounding code, selected standards and applicable project guidance | Withhold author overview, implementation chat/memory, and prior review verdicts. |
| Between calls | No new model call | Validate and persist preliminary assessment before allowing author delivery. |
| Call 2: reconciliation | Original evidence, saved preliminary assessment, separately labeled author overview/explanation | Retain, revise, combine, or withdraw findings with evidence-based reasons. Author disagreement alone does not invalidate a finding. |
| Completion | Validated report | Render findings and limitations; retain both assessments and provenance. |

Established project rules belong in call 1. “I chose this approach because…” belongs in call 2. User/agent rationale may explain a valid exception; it cannot change operational permissions, rewrite frozen standards, or silently remove a rule. If a rule explicitly permits exceptions, the report must explain why the supplied evidence satisfies that exception.

Keep two mandatory calls and the shipped bounded retry/repair policy. No additional model is needed for packaging, report rendering, or ordinary quality checking.

## What counts as a finding

Every finding identifies a selected rule, its source, affected frozen code, the concrete maintenance/readability problem, and a proportionate correction. A runtime failing scenario is not required for a standards finding; never invent one to satisfy today's defect-oriented response schema.

Examples of useful review: an explicit layer boundary violated by an import; duplicated policy logic that the selected standard requires centralizing; needless indirection that obscures a named operation. “I prefer this name,” “this function is long,” or “add an abstraction” is insufficient without applicable guidance and a concrete explanation.

Proposed rule record: stable ID, source/version or digest, applicable language/path, requirement versus recommendation, and exception policy. Explicit project rules take precedence over the selected baseline for the same issue. Conflicting mandatory project rules become a visible unresolved standard, not an arbitrary reviewer choice. Surrounding conventions are evidence, not automatically mandatory rules. No automatic blocking severity for a subjective preference.

Initial implementation target: JavaScript/TypeScript pilot, using a small documented profile and supplied project rules. This is an implementation default based on the existing stack, not a claim that one profile fits every language. Unsupported language/profile combinations must be visible. Formatting already covered by a configured formatter should not dominate model feedback; this phase does not execute repository lint/test commands.

## Existing capability and required changes

| Reuse | Update |
| --- | --- |
| Frozen Git capture, exclusions, hashes and packet inspection | Versioned standards-mode input and identity propagation without fake requirements/plan placeholders. |
| Separate author packet and persisted preliminary assessment | Standards-specific prompt, evidence references, and reconciliation policy. |
| Provider routing, budgets, retry/resume and audit ledger | Progress and actionable error presentation around existing decisions. |
| Candidate assembly, validated coordinates, Markdown rendering | Standards finding semantics and a clear “standards review” outcome label. |

Legacy request/brief contracts require requirements and an implementation plan. Legacy prompt/finding severity semantics center on defects. This is a bounded contract and policy change, not just a renamed command. Preserve legacy contracts and behavior; add explicit versioned mode-specific contracts before wiring consumers. Do not weaken existing v1 artifacts or permit resuming across changed protocols.

Standards-mode report outcomes should be explicit: standards satisfied, changes requested, non-blocking recommendations, or unable to assess. They describe only the selected standards and captured scope; none means bug-free or safe to deploy. Existing mode keeps its current verdict mapping. New standards severity describes rule enforcement, not invented outage/security severity.

## Implementation sequence

Each numbered item is a small PR or a pair of narrowly dependent PRs. Contracts and generated schemas are committed with their consumers. File lists are likely touchpoints; keep shared primitives rather than copying their validators.

### 1. Define standards-mode contracts and examples

Dependencies: none. Scope: two small increments, input then result contracts.

- Add explicit mode/version, selected standard identities and applicability, and required separate author overview. Reuse the author-packet structure where it fits; generate administrative IDs in the runner. A concise overview does not require a new planning interview.
- Define standards findings with rule reference, code evidence, problem/impact, correction, and requirement/recommendation classification. Define unresolved standards and mode-scoped outcomes without reusing defect severity misleadingly.
- Version the corresponding brief/packet identity surfaces. Define legacy parsing and resume compatibility up front.

Acceptance: standards mode validates without requirements or implementation plan; absent standards or author overview is a precise preflight failure; existing v1 examples retain their behavior.

Verification: focused contract tests for missing inputs, duplicate/unknown rule IDs, conflicts, and legacy acceptance; regenerate schemas. Touchpoints: `src/contracts/review-request.ts`, `neutral-review-brief.ts`, `review-results.ts`, shared identity contracts, `schemas/`, contract tests. Split identity propagation from schema definition if needed.

### 2. Freeze standards and author input through capture

Dependencies: 1. Scope: medium.

- Resolve selected standards and code scope deterministically. Save rule text/source/digest, including which versions apply to the target. Report unsupported/omitted scope instead of silently clipping it.
- Preserve the separately stored author overview; exclude author/control files from ordinary code capture so they cannot leak into call 1.
- Build the standards brief from real selected rules. A patched rule file cannot silently change trusted operational policy; show standards changes and require explicit selection of the intended standard revision.

Acceptance: both calls use the same frozen code/rules; changing live files after capture does not change review evidence; author content is absent from the blind payload.

Verification: temp-repository integration tests for changed standards, exclusions, tampering, and author-withholding. Touchpoints: `src/snapshot/snapshot-packet.ts`, `git-capture.ts`, `src/transmission/neutral-brief-builder.ts`, focused tests.

### 3. Apply standards review in both model stages

Dependencies: 2. Scope: medium, split prompt/schema wiring from reconciliation if needed.

- Select the versioned standards policy and response schemas by mode. Keep call 1 independent, persist its result, then expose the existing overview to call 2.
- Bind findings to selected rule IDs and valid frozen code anchors. Require reasons for retained, revised, merged, withdrawn, and final-only findings; preserve source text and IDs through runner assembly.
- Keep operational budgets, route allowlists, privacy controls, and retry/repair counts. Reject incompatible resume versions before submission.

Acceptance: explicit standards violations survive an unsupported author defense; an evidenced permitted exception can change a finding; complexity/maintainability findings do not need fabricated runtime bugs. Invalid references and incomplete assessments cannot produce a passing outcome.

Verification: mock-provider E2E for both stages and each disposition, cross-mode resume rejection, and failures preserving preliminary work. Touchpoints: `src/orchestrator/two-stage-review.ts`, `response-schema.ts`, `src/report/final-review-candidate.ts`, targeted tests.

Checkpoint: a standards review completes through the existing explicit request/config entry point before adding convenience commands.

### 4. Simplify invocation and preflight

Dependencies: 3. Scope: two small increments, request assembly then saved settings.

Implemented syntax: `independent-reviewer review --base main --standards <profile-or-file> --author <overview-file>`. Saved settings can make the last two flags optional on repeated use. Support the current structured author packet first; any concise text adapter must preserve user-supplied meaning and mark absent optional claims, never invent tests or rationale.

- Generate request metadata and IDs; keep the existing explicit request/config mode available. Show effective configuration and scope in a provider-free dry-run.
- Keep operational settings in an explicit external config or Git-resolved local settings location. Store credentials only through the existing environment mechanism.
- Preserve flow/instance limits, immutable packets, and explicit new-review intent. An unchanged-target invocation must offer inspect/eligible resume rather than silently buying another review.

Acceptance: ordinary user supplies code target, standards, and author overview without request JSON bookkeeping; dry-run submits zero calls; missing/ambiguous input fails clearly before spending.

Verification: CLI integration for initial/repeated runs, legacy mode, no-TTY behavior, linked worktrees, and budget preflight. Touchpoints: `src/cli.ts`, small input/settings modules, CLI tests, quickstart. No separate GUI or mandatory interactive wizard.

### 5. Present progress, recovery, and findings

Dependencies: 3; integrate with 4. Scope: three small increments: progress, diagnostics, report.

- Emit actual stage transitions and elapsed waits on stderr; preserve clean machine output on stdout and quiet/non-TTY behavior. No fabricated progress percentage or ETA.
- Explain errors in terms of what failed, what is saved, whether cost is known, and the valid next action. Display existing scheduled retry delays; long Retry-After, exhausted allowance, and uncertain transport remain distinct. The UI never adds a retry loop.
- Lead reports with standards outcome and requested changes. Each finding shows rule/source, code location, problem, and correction; optional advice and incomplete scope are explicit. Retain detailed reconciliation and coverage artifacts.

Acceptance: output exposes no secrets/author text in progress; summary agrees with validated report; uncertain submission never claims safe replay or zero cost; zero findings does not imply full assessment when coverage is missing.

Verification: deterministic clock/provider tests for waits, output streams, and callback failures; terminal/Markdown escaping; report cases for required/recommended rules and unassessed paths. A presentation failure must not trigger a duplicate provider request. Touchpoints: CLI, small progress/diagnostic/presentation modules, existing orchestration events and report renderer.

### 6. Check useful standards feedback end to end

Dependencies: 4–5. Scope: bounded evaluation, not a new evaluation platform.

Use eight human-labeled cases: clear mandatory violation; compliant counterpart; permitted exception; unsupported author defense; advisory-only rule; conflicting rules; unavailable context; unchanged clean refactor. Include naming/complexity/boundary examples with concrete local standards. Preserve failed completions in results and separate semantic quality from delivery.

Acceptance: expected violations and justified exceptions are handled; clean/advisory cases do not receive invented blockers; every finding has valid rule/code evidence and actionable correction. Test interpretation against a few real changes rather than relying solely on synthetic labels.

Verification: deterministic integration cases first. Proposed live confirmation: eight runs using one fixed approved model/route, normally 16 mandatory calls; at $0.02 reservation per run, reserve no more than $0.16 aggregate. Retry/repair stays inside admitted per-run bounds, unknown usage retains reservation. This is a proposed experiment cap, not a billing guarantee or a request to run now. Stop repeated same-cause failures and diagnose before more submissions.

Success measures: starts completed without intervention; correctly applied standards; false positives on compliant code; human usefulness/adjudication; elapsed time; reported and unknown cost. No bug-recall/fuzzing benchmark in this milestone. Old bug fixtures still protect legacy behavior but do not define the new product's success.

## Verification and release discipline

TDD is available for contract/trust-boundary and orchestration behavior. Favor observable behavior checks; do not write tests simply duplicating code or expand the suite for a formatting-only change. Run focused checks during development and `npm run check` plus `python3 -B scripts/check-ai-context.py --ci` before each implementation PR. Run additional context checks when integration metadata changes.

Document the approved mode in the canonical roadmap/spec alongside contract work. Preserve legacy artifacts, blind-stage independence, known failure states, and incomplete scope. No model-backed review can promise zero false positives; human disagreement needs adjudication, not automatic suppression.

Release checkpoint: a developer can supply a change, standards and overview; obtain a two-stage review; identify the applicable rule and correction; and understand failures without reading a JSONL ledger. Pilot can use a pinned local checkout; npm publication is separate because the package remains private.

## Research basis and remaining uncertainty

These sources inform design, not proven demand or product accuracy:

- [CLI Guidelines](https://clig.dev/): simple invocation, visible progress, composable output, recoverability.
- [NN/g: Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/): feedback that supports the next user action.
- [Google: What to look for in code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html): complexity, design, naming, comments and conventions are review topics. This product intentionally selects a narrower scope than Google's full guidance.
- [Google: The standard of code review](https://google.github.io/eng-practices/review/reviewer/standard.html): code health and evidence over personal preference; avoid requiring perfection.
- [Google: Writing review comments](https://google.github.io/eng-practices/review/reviewer/comments.html): reasons, useful corrections and explicit severity.
- [Anthropic: Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): evaluate outcomes with appropriate human judgment, not only valid response shape.
- [OpenRouter: Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging): error categories and Retry-After.
- Local observations: [route assessment](../validation/2026-09-09-reference-scope-and-routes.md), [recovery batch](../validation/2026-09-09-call-recovery-batch.md), [pacing](../validation/2026-09-09-pacing.md). Successful transport with occasional false positives motivates separate delivery and quality measures; these were not standards-mode evaluations.

Still unmeasured: first-use friction, standards-profile precision across projects, and provider reliability over time. Initial profile and CLI/schema names are now implemented; profile effectiveness still needs live evaluation. Scope and author-data timing are already agreed; they do not need reopening.

## Implementation evidence — 2026-09-09

Implemented on `codex/standards-review`; engine checkpoint `beed62e`. Added versioned standards contracts, frozen author identity, separate two-stage policy, rule/path/enforcement validation, source-bearing Markdown, convenience CLI, Git-local settings, provider-free admission preview, progress, and recovery/cost presentation. Legacy explicit requests remain supported. JavaScript/TypeScript example profile deliberately uses recommendations; users explicitly select mandatory project rules.

`npm run check`: 207 tests passed, including eight deterministic standards protocol cases and an actual convenience-CLI invocation against a mock provider. `python3 -B scripts/check-ai-context.py --ci`: passed. Tests verify author withholding until persisted preliminary assessment, rule applicability/identity, advisory versus mandatory outcomes, missing context, author digest tampering, dry-run without credentials, exclusive instance claims, and terminal/progress safety. Conflict fixture checks duplicate rule identity rejection; it does not prove semantic detection of contradictory rules with distinct IDs.

No paid standards-mode calls made. Eight human-labeled live evaluations, real-change adjudication, false-positive measurement, and first-use usability assessment remain pending. Mock responses establish protocol behavior, not model judgment. Contradictory prose and whether evidence actually supports an exception still require model judgment and human evaluation. No bug hunting, fuzzing, test execution, or automatic fixing added.

Live follow-up: eight starts produced four final reports, with two full semantic passes. Added bounded 529 recovery (208 tests pass); unresolved conflict handling and uncertainty-as-violation remain quality issues. Live acceptance is not complete. See linked evaluation for costs, failures, configuration changes, and next fixes.
