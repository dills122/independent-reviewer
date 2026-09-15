# Correctness and comprehensive engineering review

Status: proposal for discussion; no runtime or accepted-roadmap change.
Baseline inspected: `6073c2f`, 2026-09-14.

Follow-up: [delivery plan](../plans/2026-09-14-correctness-engineering-review-plan.md),
[evaluation protocol](../plans/2026-09-14-review-quality-evaluation-protocol.md),
and [deep research](2026-09-14-engineering-review-deep-research.md) refine this
assessment into [#159–#165](https://github.com/dills122/independent-reviewer/issues/159).
Evidence access and semantic indexing are separate increments; executing
indexers depend on isolated workers. Original observations below remain a
record of the assessed baseline.

## Checks performed for this assessment

- Node.js 24.19.0; exact dependencies installed from local npm cache.
- `npm run test:coverage`: 600 tests passed, none failed or skipped;
  93.67% line, 85.44% branch, and 95.60% function coverage.
- `npm run format:check`, `npm run lint`, and `npm run typecheck`: passed.
- `python3 -B scripts/check-ai-context.py --ci`: passed.
- Local context check without `--ci`: failed because shared skills are missing
  in this worktree. No integration repair performed for this analysis.
- No new paid provider calls or fresh network dependency audit performed.
  Historical live results below are documentary evidence, not reruns.
- Only this proposal added; application source unchanged.

## Assessment

Project has a substantial review runner and evidence-integrity foundation.
Next product milestone should establish useful, measurable review judgment:
catch real defects, reject unsupported claims, and explain what remains unknown.
More comprehensive engineering review then needs broader evidence, explicit
review obligations, and observed verification.

Three distinct properties need separate gates:

1. **Engine correctness:** capture, identity, isolation, budgeting, persistence,
   and report assembly obey their contracts.
2. **Finding correctness:** reported problem follows from an applicable
   obligation, reachable scenario, and available evidence.
3. **Review completeness:** review examines relevant behavior and interactions,
   including defects initial reviewer did not notice.

Current implementation is strongest on first property. Fresh verification helps
second property. Third property remains largely dependent on one model's static
assessment of a fixed payload. Valid JSON, valid citations, and recorded file
inspection do not prove a conclusion or demonstrate complete reasoning.

## Current capabilities

| Area | Implemented | Practical boundary |
| --- | --- | --- |
| Frozen evidence | Cumulative Git capture, native diffs, immutable blobs, identities, explicit omissions | Required evidence cannot be silently dropped; broader context still needs deliberate capture |
| Review context | Language-neutral units; declaration regions for JS/TS, Python, Go, Java; nearby source windows | Syntax regions identify enclosing declarations; do not establish semantic call or data flow |
| Supporting source | Direct relative JS/TS imports and explicitly selected standards references | No general reverse-caller, transitive-dependency, or multi-language semantic graph |
| Independence | Persisted blind assessment before author disclosure; fresh preliminary-claim verifier | Fresh context is valuable, but shared model and evidence can retain correlated mistakes |
| Report integrity | Runner derives verdict, coverage, actions, and formal limitations; validates citation coordinates | Model still supplies semantic judgments; inspected-path ledger is model-reported |
| Operation | Bounded provider policy, conservative admission, durable attempt ledger, constrained final resume | Provider availability remains variable; verification-stage restart/resume is limited |
| Review modes | Requirements/plan review and selected-standards review | Standards mode deliberately excludes broader system behavior and execution |
| Friendly operation | Simple settings and six harness discovery adapters | Guidance presentation/inspection and author lifecycle work remain in existing plan |

Sources: [architecture](../architecture-and-roadmap.md),
[ADR-009](../decisions/009-use-language-neutral-context-maps.md),
[execution index](../plans/2026-09-13-friendly-operations-execution-index.md),
[supporting-source resolver](../../src/snapshot/referenced-sources.ts), and
[standards policy](../../src/orchestrator/standards-policy.ts).

### Evidence of review quality

Latest committed [paid matrix report](../validation/2026-09-14-multi-harness-paid-e2e.md)
records all 14 human-labeled cases eventually matching expected verdicts after
targeted recovery. Across both waves, 63 calls started, 38 succeeded, and 25
failed. Successful calls reported $0.010213712; failed-call costs remain unknown.

This establishes useful protocol and small-fixture evidence. It does not
establish general accuracy, finding-level recall, or repeat stability. Verdict
agreement can conceal a missed second defect or an extra false finding. Latest
matrix also concerns an earlier tested commit, not a new paid run at this
assessment's HEAD.

Most live fixture artifacts described in validation reports live in private,
ignored run directories. Tracked tests primarily exercise deterministic runner
behavior. A small reproducible semantic evaluation corpus should become a
first-class project artifact, with labels withheld from reviewer input.

## Highest-priority gaps

### 1. Finish claim adjudication

[ADR-016](../decisions/016-verify-every-verdict-affecting-review-claim.md)
explicitly leaves final-only findings and deterministic handling of inconclusive
finding judgments as follow-up work.

Current [final semantics](../../src/orchestrator/two-stage-review.ts) enforce
withdrawal after `NO_VIOLATION` and fixed dispositions for verified preliminary
concerns. They do not require a fresh judgment for final-only findings.

Proposed invariant: every final adverse claim has a persisted judgment bound to
its actual content and evidence, or a runner-observed result. Binding only a
finding ID is insufficient if its premise changes during reconciliation.

- Demonstrated violation: eligible finding.
- Rejected violation: withdrawn finding with retained audit history.
- Inconclusive violation: explicit uncertainty, not a demonstrated defect.
  Block completion only when unresolved evidence is necessary for an in-scope
  obligation; record that necessity explicitly.
- New or materially changed post-author claim: selective fresh verification.
  Relevant author statements remain labeled claims in this later stage.

Audit all remaining verdict inputs, including standards conflict/unassessed
statuses and summaries. Avoid another field-specific fix that allows same
unsupported premise to move to a different output category.

Reserve additional worst-case call cost before first submission. Define versioned
artifacts, failure behavior, and resume identity before adding orchestration.

### 2. Measure missed defects as well as false positives

Verifier sees only claims already raised. Empty preliminary assessment gets an
empty local verification ledger. This can produce an orderly clean report while
missing a defect entirely.

Introduce a focused, fresh obligation-driven discovery pass for comprehensive
mode after evidence is sufficient. Give it relevant evidence and responsibilities,
without first review's conclusions or author rationale. Its purpose is to find
missed defects, not endorse an existing clean verdict. Enable by explicit depth
or risk policy; measure benefit against additional cost and disagreement.

### 3. Expand evidence along actual interactions

A changed helper may break an unchanged caller. Direct imports from changed
files cannot establish that reverse relationship. Nearby 12-line windows also
may omit an important branch or state transition inside a large function.

Suggested order:

1. Materialize relevant enclosing declarations under explicit budgets.
2. Resolve direct dependencies and reverse references, starting with a qualified
   language adapter and honest unsupported-language fallback.
3. Add relevant tests, schemas, configuration, migrations, and authoritative
   interface specifications.
4. Add bounded read/search/expand over authorized frozen evidence.

Tool access must use immutable captured material or an explicitly frozen source
inventory. It must not read current developer files opportunistically during a
review. Persist each request, response digest, scope, and omission; retain secret
admission and author separation.

Separate changed-code primary anchors from supporting citations. Permit a finding
to explain both changed caller and unchanged contract, while keeping its defect
ownership in reviewed change. Existing requirements-mode prompt forbids citations
to referenced source, so this requires a deliberate contract/policy update.

### 4. Add observed verification

Introduce an isolated worker for allowlisted named checks. Worker operates on
frozen snapshot in disposable storage, with explicit network policy, no provider
credentials, bounded resources, and captured outputs.

Persist command, executor, source identity, environment/dependency identity,
exit status, timeout, output digests, and limitations. Author test claims remain
separate. A passing command proves only its checks, not overall correctness.

For regression findings, compare BASE and HEAD where meaningful. A useful
reproduction shows expected behavior on BASE and failure on HEAD under the same
test and environment. New features may lack a valid BASE execution; record that
instead of forcing a misleading comparison. Generated tests need independent
validation of their expected result and input domain.

## Comprehensive review scope

Keep requirements review and standards review compatible. Define a versioned
engineering review scope with explicit enabled dimensions and necessary evidence.
Requirements and plans apply when supplied; absent documents must not be replaced
with invented business obligations.

| Dimension | Concrete questions | Evidence needed |
| --- | --- | --- |
| Behavior | Correct result, domain boundaries, invariants, failure paths? | Requirements, code, contracts, examples/reproductions |
| Compatibility | Existing callers, public APIs, serialization, migrations still valid? | Reverse references, consumers, schemas, BASE/HEAD comparison |
| State and concurrency | Retry, cancellation, races, idempotency, cleanup handled? | State transitions, callers, resource ownership, targeted checks |
| Design and maintainability | Cohesive responsibilities, sound boundaries, simpler viable design? | Surrounding architecture, conventions, current constraints |
| Verification quality | Tests exercise changed behavior and fail for plausible defects? | Test source, observed results, selected mutation or regression controls |
| Security and operations | Trust boundaries, failure recovery, diagnostics, resource use? | Applicable threat/deployment context, dependency/config evidence |
| Performance | Demonstrable complexity or resource regression? | Workload assumptions, relevant code paths, measurements where needed |

Distinguish demonstrated defects, mandatory standards violations, architectural
recommendations, and uncertainty. A useful recommendation can exist without a
runtime bug; its report class and effect on verdict must be explicit. Do not
inflate subjective preferences into blocking findings.

Coverage should track obligations and dimensions, alongside existing file
coverage. Record evidence supplied, reviewer assessment, and executed checks
separately. An out-of-scope dimension differs from an in-scope obligation that
cannot be assessed because required evidence is missing.

## Proposed implementation sequence

### Slice A — reproducible quality baseline

Commit a bounded corpus of approximately 20–30 labeled changes, reusing existing
synthetic cases where available. Include clean counterparts for every defect
family, multiple defects, misleading author claims, missing required context,
cross-file contracts, and post-author claim changes. Add several small real
regressions with known corrections and clear provenance.

Separate labels/oracles from transmitted artifacts. Match findings by root cause
and causal evidence, not exact prose. Report:

- finding precision and defect recall;
- clean-change false-positive rate;
- false abstention and correctly identified missing evidence;
- severity calibration and duplicate findings;
- delivery/completion rate, latency, calls, and cost;
- repeated-run variability, counting every predeclared run.

**Gate:** same corpus and scorer run from clean checkout; no label leakage;
provider failures remain a distinct outcome. Freeze model, policy, and repetition
count before an explicitly authorized paid sample. Keep holdouts out of prompt
tuning. Initial small sample provides a baseline, not a universal accuracy claim.

### Slice B — complete adjudication

Implement versioned final-claim verification and inconclusive projection, using
existing adverse-claim design as starting point. Extract focused adjudication
and projection modules as needed; avoid adding all behavior to the already large
orchestrator.

**Gate:** unsupported claim cannot change outcome by moving between finding,
limitation, standards-status, or summary channels; genuine missing evidence stays
visible; budget and resume tests cover additional stage. Corpus shows both
retained true positives and rejected false positives.

### Slice C — cross-file correctness

Add declaration expansion, qualified reverse references, supporting citation
roles, and bounded frozen-evidence access. Preserve universal fallback and
explicit unsupported relations.

**Gate:** changed helper breaking unchanged caller is found with both causal
locations; equivalent clean refactor produces no defect. Budget exhaustion and
unsupported resolution remain visible rather than claiming complete coverage.

### Slice D — isolated checks

Add runner-observed named checks, then targeted reproductions and differential
BASE/HEAD execution where meaningful.

**Gate:** known regression reproduces, clean control passes, environment failure
is distinguishable from code failure, and author claims never become observed
results without execution. No working-checkout mutation or credential exposure.

### Slice E — broader engineering assessment

Add explicit dimensions and obligation coverage. Reuse deterministic units for
bounded specialized passes, including a fresh missed-defect pass. Keep a
cross-unit synthesis step for interactions, contradictions, and deduplication;
one independent provider call per file would miss many system relationships.

**Gate:** realistic multi-file evaluation shows useful additional findings at
acceptable precision, abstention, delivery rate, and cost. Publish thresholds
before qualification. Wider dimensions can ship independently as evidence and
evaluation support mature.

## First build recommendation

Start with Slices A and B. Then use observed misses to prioritize Slice C.
Finish remaining friendly-operation work as a bounded usability track; it need
not postpone establishing review-quality evidence. Defer hosting, broad model
comparisons, and a general-purpose autonomous agent until core quality and cost
can be measured on representative changes.

This is a proposed extension of previously deferred scope. Evidence tooling,
execution, extra semantic stages, and paid qualification each need explicit
acceptance criteria in the canonical roadmap before implementation.
