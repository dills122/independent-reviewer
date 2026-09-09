# First useful review: product research and delivery proposal

Status: proposal for owner review; implementation not started. Research date: 2026-09-09. Baseline: `8322b9edad655f932352329e6db11bda43383ef8`, merged PR #66. Product decision owner: repository owner.

## Recommendation

Make one complete local workflow easy: supply existing intent, request a review, understand progress, and act on findings. Keep the current two-stage engine. Deliver simpler setup and visible results first, then use matched reviews to improve judgment. Do not equate successful delivery with useful advice.

Scope covers the three requested priorities: (1) simpler review entry, (2) trustworthy/actionable findings, (3) clear progress and recovery. The proposed first users are developers and coding-agent operators who already have requirements and an implementation plan. This audience is an assumption to confirm, not validated demand.

The product milestone is: a developer unfamiliar with this repository can review their own change without maintainer help and identify both the next action and any review limitation.

## Research method and limits

Decision question: which small additions most reduce setup, interpretation, and recovery work while preserving review independence and bounded spending?

Compared wrapper-only CLI improvements, a new guided CLI surface, broader protocol/model changes, and a web/PR interface. Criteria: direct user benefit, reuse of shipped behavior, integrity of evidence, reversibility, and measurable outcome. Primary practitioner guidance and provider documentation inform design; repository code and retained live results establish current capability. Research stopped once each priority had supporting guidance, a concrete gap, an alternative, and a verifiable delivery slice.

This work authorizes research and planning only beyond the CI fix/merge. No new provider requests, user outreach, model comparison, deployment, or product implementation occurred. External guidance supports design choices; it does not prove adoption, accuracy gains, or the numerical pilot targets below.

## Evidence and implications

| Type | Evidence | Product implication |
| --- | --- | --- |
| Documented fact | CLI Guidelines recommend examples, explicit configuration precedence, machine-readable output, and progress for long operations. [S1] | Offer a short happy path while retaining the existing script interface. |
| Documented fact | Nielsen Norman Group describes timely status feedback as a way for users to understand what happened and choose next actions. [S2] | Show real stages and waits before asking users to interpret errors. |
| Documented fact | Google's review guidance emphasizes explaining reasons and distinguishing required changes from optional advice. [S3] | Make impact and required action easy to scan. |
| Documented fact | Anthropic distinguishes outcome evaluation from transcript checks and recommends combining evaluation with human feedback. [S4] | Score correctness and usefulness separately from structural validity. |
| Documented fact | OpenRouter documents rate-limit/availability errors and Retry-After guidance. [S5] | Display the runner's recovery decision; the UI must not invent its own retry loop. |
| Observation | `src/cli.ts` requires request/config files; review prints packet, verdict, and report paths without stage progress. | Remove metadata preparation and ledger-reading from ordinary use. |
| Observation | `src/contracts/review-request.ts` requires requirements and a plan; the live orchestration also requires author input. | Simplification must preserve real inputs and their separation. |
| Observation | `src/contracts/review-results.ts` and `src/report/markdown.ts` already contain scenario, impact, correction, evidence, coverage, and uncertainty. | Improve presentation and quality before adding response fields. |
| Observation | Latest route assessment completed 4/4 reviews in 17–25 seconds with two calls each; one review included a false positive. [L1] | Delivery is promising; correctness still needs work. |
| Observation | Recovery batch completed 5/5 reviews, including two recovered failures; 4/5 matched expected findings. [L2] | Preserve successful stages and measure delivered quality independently. |
| Observation | Fixed-spacing comparison showed no clear benefit; duplicate preliminary IDs remain an observed failure. [L3] | Keep spacing disabled by default; give malformed outputs an honest failure state. |
| Inference | Setup friction and report interpretation can improve without changing the model conversation. | Ship these reversible improvements before introducing more calls. |
| Unknown | New-user setup time, real-change precision/recall, willingness to provide a plan, and provider stability over time. | Validate with a small pilot; do not claim production reliability. |

## Choices and trade-offs

| Decision | Recommended | Alternative and when to reconsider |
| --- | --- | --- |
| First-use surface | Guided local setup plus concise review command, compiling existing contracts | A copyable request template is cheaper but leaves bookkeeping burden. Web/PR UI becomes attractive if pilot users will not use a CLI. |
| Missing intent | Collect genuine requirements/plan; explain missing inputs before a paid call | A code-only mode would broaden the audience but needs an explicit protocol decision. Never synthesize a pretend plan from the patch. |
| Finding quality | Reuse existing fields; evaluate one prompt/default change at a time | Extra judging calls or model ensembles may help, but add cost and failure points. Consider only after a measured quality gap survives focused changes. |
| Recovery | Present existing bounded retry/resume decisions | Automatically starting another full review can duplicate cost and change the verdict. It is outside this milestone. |
| Context | Keep deterministic frozen input and visible omissions | On-demand evidence retrieval is justified later if adjudicated misses repeatedly trace to absent context. |
| Default model/route | Keep selection explicit; make the evaluated profile easy to select | Do not turn a four-run result into an invisible permanent default. Refresh routing/pricing evidence before release. |

## Proposed user experience

Command names below are proposals, not shipped syntax.

1. `independent-reviewer init` records explicit operational settings and paths to review inputs. It explains credential setup without reading a key into a flag or config file. It makes no provider call.
2. `independent-reviewer review --base main --dry-run` validates inputs and shows scope, exclusions, selected profile, and conservative reservation. It does not transmit source.
3. `independent-reviewer review --base main` generates IDs and request metadata, freezes evidence, and runs the existing two stages. Existing `--request ... --config ...` remains supported.
4. Completion presents the verdict, blockers, concise findings, material limitations, reported cost when available, and a link/path to the full report.

Example progress, reflecting actual events:

```text
Capturing current changes…
Reviewing code — 12s elapsed
Initial review saved. Checking author explanation…
Provider rate-limited this call. Retrying in 8s; initial review retained.
Review complete: Not ready — 1 blocking finding
```

No fabricated percentage or ETA. A stage's elapsed time is not a provider execution guarantee. An explicit retry wait comes from the runner's scheduled delay and may be extended by shared cooldowns.

### Input and policy boundaries

- Generate flow/config/input IDs and ledger metadata, not engineering intent or test claims. New invocations must not silently create fresh flows to evade the three-instance bound: require explicit new-flow intent or select the existing flow and enforce its count.
- Keep requirements, plan, guidance, and author explanation separately identified. A guided form/template maps user-authored fields deterministically to existing contracts. Missing mandatory content fails preflight; empty optional lists mean no supplied claims.
- Initially use selected files or guided text entry; no extra model call to package input. Do not ingest chat history, CCE memory, or old review verdicts into the blind stage.
- Save local operational policy outside reviewed content, using a Git-resolved local settings path or explicit external config. Repository files may supply guidance and input-path suggestions; they cannot silently change endpoint, budget, or privacy policy. Linked-worktree behavior needs a focused check before finalizing storage.
- Preserve explicit CLI overrides over saved local settings. Keep the API key environment-only for this milestone. Show effective settings and reject conflicting input modes before submission.
- Exclude generated control files and author input from general code capture; deliver author content only after the preliminary artifact is durable. Preserve packet tamper checks and visible omissions.
- Unchanged-target reruns must not overwrite packets or silently buy another review. Offer inspect or an eligible resume; changed targets require a new snapshot within the flow limit.

## Delivery slices

Order reflects dependencies rather than the earlier numerical priority labels. Every slice should leave the existing CLI usable. File lists are likely implementation touchpoints; generated schemas/exports accompany deliberate contract additions.

### 0. Establish a small product baseline — small

Responsibility: maintainer and product owner. Dependencies: none.

Retain a short scorecard for existing clean, planted-defect, misleading-author, and scope-boundary cases. Record current user journey and report screenshots/text examples. Reuse fixtures and logs; do not build an evaluation platform.

Acceptance: baseline names code/prompt/config versions; separately records completion, findings, false positives, omissions, time, and reported/unknown cost; all expected findings have human-reviewed rationale.

Verification: manually reconcile the scorecard with L1–L3, preserving failed runs. Likely files: `docs/validation/` scorecard and this plan. No paid run is needed for this preparation.

### 1. Save setup and expose preflight — medium

Responsibility: CLI/config boundary. Dependencies: 0.

Add a versioned local settings contract and `init`/dry-run flow. Reuse current capture, config validation, and admission functions; extract shared preflight only if necessary to avoid two disagreeing budget calculations.

Acceptance: setup and dry-run make zero provider submissions; repeat setup never overwrites existing settings silently; missing inputs, ambiguous base, and insufficient budget explain exactly what to change.

Verification: temp-repository CLI checks covering linked worktrees, effective configuration precedence, absent credential display, and no-submit admission. Likely files: new local-settings contract and CLI setup module, `src/cli.ts`, focused CLI tests, quickstart. Medium scope; split contract and UI wiring if it exceeds one focused change.

### 2. Review without hand-authored request JSON — medium

Responsibility: input assembly. Dependencies: 1.

Compile selected neutral documents and a separately collected author form into `ReviewRequestV1`; assign identifiers and resolve packet destinations internally. Support both noninteractive flags/files and optional terminal guidance. Never prompt indefinitely in a pipe or CI.

Acceptance: a user supplies meaningful content without IDs/schema metadata; legacy explicit request mode still works; repeated/changed targets enforce packet and flow rules without leaking author input.

Verification: end-to-end CLI checks with existing mock provider for equivalent inputs, first-stage author withholding, missing plan, and repeat invocation. Likely files: new request-builder module, `src/cli.ts`, focused CLI tests, quickstart. Any need to weaken required inputs returns to the owner as a protocol choice.

### 3. Show stage progress — medium

Responsibility: orchestration-to-CLI presentation. Dependencies: 0; integrate with 2 before pilot.

Expose bounded sanitized lifecycle notifications from existing transitions, with the durable run record authoritative. Present phase changes and elapsed waiting on stderr; keep primary/machine output on stdout. Add plain/no-animation behavior for non-TTY callers and quiet mode.

Acceptance: progress appears before the first network call; saved-preliminary, final, retry/repair, and terminal states match real transitions; output contains no credentials, source, author prose, or raw model responses.

Verification: injected clock/provider checks for long wait, retry, and output stream separation; a presentation callback failure cannot cause another provider submission. Likely files: small progress contract/module, `src/orchestrator/two-stage-review.ts`, `src/cli.ts`, targeted tests. Define exported event shape before consumers.

### 4. Explain failures and safe next actions — medium

Responsibility: CLI failure/status presentation. Dependencies: 3.

Map existing typed errors and durable state to a concise explanation, preserved-work status, cost certainty, and the next valid command. If an offline status command is needed, it validates ledger/config identity and does not infer resume eligibility merely from the last error text.

Acceptance: eligible final failures offer only the existing bounded resume; uncertain transport says outcome/cost unknown and never claims safe replay; missing input, budget rejection, malformed response, and exhausted retry remain distinguishable non-successes.

Verification: reuse deterministic recovery scenarios for final-stage retention, long Retry-After, exhausted allowance, malformed preliminary IDs, and timeout. Likely files: new diagnostic presenter, `src/cli.ts`, minimal orchestrator state projection, targeted tests. Keep established exit codes. Do not add retries to improve the UI's apparent success rate.

Checkpoint after 2–4: a person can start a review and understand success, waiting, and failure without reading JSONL. Use a mock provider for recovery demonstrations; do not wait for random provider failures.

### 5. Make findings immediately actionable — small/medium

Responsibility: report presentation. Dependencies: 0; integrate with 2–4.

Add a brief terminal summary; organize Markdown around blocking actions, findings, then material uncertainty, with complete reconciliation/coverage details retained. Present existing scenario/impact/correction fields and frozen BASE/HEAD locations. Escape untrusted text, including terminal control sequences. Any code excerpt comes from validated frozen blobs, never the current checkout.

Acceptance: required action and optional follow-ups are distinct; zero findings cannot conceal incomplete scope; summary and full report retain the same verdict/findings and expose unknown cost as unknown.

Verification: render existing clean/bug/limited reports; check terminal/Markdown injection and navigation on renamed/deleted files. Likely files: `src/report/markdown.ts`, new terminal presenter, `src/cli.ts`, report tests. Keep `FinalReviewReportV1`; no extra model fields or calls solely for presentation.

### 6. Improve judgment against matched cases — medium, bounded experiment

Responsibility: prompt owner with human adjudication. Dependencies: 0 and 5.

First candidate: tighten handling of assumptions about inputs using the observed whole-dollar false positive and a contrasting case where fractional inputs are allowed. Current prompt already forbids invented requirements; test a specific change rather than repeating that instruction more loudly. Keep one model/route/config fixed and change one factor at a time.

Acceptance: candidate removes the targeted false positive without losing the corresponding real bug or other known blockers; invalid reports count as delivery failures; every newly disputed finding is reviewed against code/requirements, not automatically classified wrong because the author dislikes it.

Verification: proposed 12 labeled cases (balanced clean/defective, including held-out boundary variants), baseline and candidate once each: 24 reviews, normally 48 mandatory calls. At a proposed $0.02 reservation per review, admit at most $0.48 total reserved budget; unknown usage consumes reservation. One confirmation pair on the targeted cases adds at most $0.04. These are proposed bounds, not billing guarantees or authorization to run now. Stop repeated same-cause failures and diagnose before more submissions.

Likely files: `src/orchestrator/two-stage-review.ts` prompt version only if evidence supports it, small fixture inputs, scorecard/evidence document. Use human grading initially. If preliminary IDs repeatedly block completion, isolate runner-owned preliminary bookkeeping as its own versioned contract change; do not silently rename IDs inside already-bound artifacts.

## Pilot and success criteria

All numerical targets are proposed product gates, not established benchmarks. Owner confirms them before implementation.

| Outcome | Proposed measure/gate |
| --- | --- |
| Easy first use | Three developers unfamiliar with internals complete setup and start a valid review in at most 10 minutes each, with credentials and intent documents available, no maintainer help and no request-JSON editing. Report installation time separately. |
| Understandable output | Each can identify blocking action, relevant location, uncertainty, and whether a retry is safe from the product output alone. |
| Reliable user journey | Record every start, preflight rejection, submitted run, terminal result, and manual intervention. Separate provider delivery failures from valid Not ready verdicts. Do not infer an uptime percentage from this pilot. |
| Useful findings | Record accepted, disputed, deferred, and not-actioned findings with reasons. Calculate correctness only after adjudication; acceptance rate is a usefulness signal, not truth. |
| Better judgment | In the matched 12-case comparison: targeted false positive removed, no lost known blocking defects, all failures visible. Publish counts/denominators; a small result does not establish general precision/recall. |
| Bounded overhead | Two mandatory model calls remain; presentation-only changes add none. Compare elapsed time, reported usage, and unknown reservations on identical inputs. |

Supplement fixtures with five voluntarily supplied real changes during pilot. Human reviewers establish expected behavior first where possible; unknown missed bugs remain unknown. Participation and paid-run budget need explicit scheduling at the sync. Keep source and feedback local; no analytics service by default.

Package is currently private (`package.json`, version 0.0.0). Pilot can use a pinned checkout/local install. A public npm release is a separate distribution decision; the onboarding target must not pretend publication has happened. If installation dominates the pilot, reprioritize packaging next.

## Risks and decisions for the sync

1. **Audience:** approve developers/agent operators with existing intent documents as the first segment, or prioritize a code-only mode that requires separate protocol work.
2. **Input burden:** confirm guided author fields plus selected requirements/plan files are acceptable. Do not promise “one command from nothing.”
3. **Delivery scope:** approve slices 1–5 as the first product increment, with slice 0 as a small baseline and slice 6 as a bounded quality comparison. No web UI, PR bot, model ensemble, autonomous fixes, or arbitrary test execution in this increment.
4. **Pilot:** agree on participants, representative change sizes/languages, and the proposed experiment cap. The current repository gives no reliable effort estimate in days; slices are small/medium dependency units, not delivery promises.

After agreement, update the canonical roadmap/spec for approved public behavior, then implement in small PRs. Run focused behavior checks plus `npm run check` and the separate repository-context gate for each implementation change. Reuse checks; do not grow tests merely to mirror rendering internals.

## Sources

Accessed 2026-09-09. Practitioner guidance is distinct from empirical proof of this product's value.

- **S1:** [Command Line Interface Guidelines](https://clig.dev/) — output, help, configuration, robustness. Supports CLI conventions; our exact commands and milestones are proposals.
- **S2:** [Nielsen Norman Group: Visibility of System Status](https://www.nngroup.com/articles/visibility-system-status/) — feedback and informed user action.
- **S3:** [Google Engineering Practices: How to write code review comments](https://google.github.io/eng-practices/review/reviewer/comments.html) — reasons, guidance, severity.
- **S4:** [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — outcomes, multiple grading methods, feedback, evaluation limits.
- **S5:** [OpenRouter: Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging) — provider failure categories and Retry-After. Provider behavior can change; verify again when changing transport policy.
- **L1:** [First-final concern scope and route assessment](../validation/2026-09-09-reference-scope-and-routes.md).
- **L2:** [Call recovery batch](../validation/2026-09-09-call-recovery-batch.md).
- **L3:** [Pacing comparison](../validation/2026-09-09-pacing.md).
- **Local contracts:** [Architecture and roadmap](../architecture-and-roadmap.md), [CLI](../../src/cli.ts), [request](../../src/contracts/review-request.ts), [results](../../src/contracts/review-results.ts), [Markdown renderer](../../src/report/markdown.ts), [orchestrator](../../src/orchestrator/two-stage-review.ts).
