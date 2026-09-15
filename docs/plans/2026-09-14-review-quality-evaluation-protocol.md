# Review-quality evaluation protocol

Status: implementation started for [#160](https://github.com/dills122/independent-reviewer/issues/160).
Thirty-case corpus, deterministic fixture builder, versioned family splits, evaluator-only oracle
reconstruction, tiered selection, paid admission, and run accounting are implemented. The first paid
Stage A sample is recorded in
[tiered review matrix paid validation](../validation/2026-09-14-tiered-review-matrix.md).
Finding-level scorer, adjudication records, and repeated sampling remain pending.

## Purpose

Measure whether review finds real problems, avoids unsupported claims, preserves
necessary uncertainty, and completes at bounded cost. Keep this evaluation
separate from deterministic runner tests. It consumes product packets, attempts,
and reports; it does not change production verdict rules.

Parent plan: [correctness and engineering review](2026-09-14-correctness-engineering-review-plan.md).
Methodology evidence: [deep research](../research/2026-09-14-engineering-review-deep-research.md).

## Corpus composition

Initial target is approximately 30 frozen changes:

- Twelve defect/clean pairs, including local arithmetic/boundaries, direct
  imported contracts, changed helper/unchanged caller, state/resource lifecycle,
  API/schema compatibility, and behavior-preserving refactors. Several pairs
  should come from small real regressions with clear provenance.
- Six uncertainty/adversarial controls: missing required context, irrelevant
  missing context, misleading author concern, unsupported author defense,
  conflicting applicable standards, and post-author claim change.

Use original synthetic cases where practical. Real cases need source revision,
license/provenance, original issue/fix references held only by evaluator, and
recorded environment requirements. A historical bug-fix commit is not itself a
bug-introducing patch: select the actual introduction or construct an explicitly
labeled reverse-fix fixture. Do not claim a synthetic inversion is a real PR.

Clean means manually assessed clean for declared obligations, not universally
bug-free. Defect cases may contain multiple known roots. Corpus record must say
whether labels are exhaustive for scope; unexplored extra findings are not
automatically false.

### Split and versioning

Keep both members of each pair and closely related repository families in the
same split. Aim for eight development pairs and four holdout pairs; allocate
controls before freeze. If real repository grouping changes these counts,
record actual split rather than weakening family separation.

Version every source, expectation, split, scoring policy, and evaluator decision.
Holdout labels are accessible to evaluator only and must not be used to tune
prompts. When a holdout is inspected for diagnosis, record contamination and
replace it before the next claimed holdout comparison. Corrections to invalid
gold labels require an explicit corpus version and rescore of both variants.

## Proposed evaluator-only artifacts

Names below describe future contracts, not currently exported schemas.

| Artifact | Required content |
| --- | --- |
| Case manifest | Case/pair/family/control-role ID, source provenance and digests, BASE/HEAD or cumulative snapshot, mode, obligations, permitted reviewer inputs, expected roots/uncertainties/recommendations, oracle references, label completeness, split |
| Experiment manifest | Engine commit, corpus/scorer versions, model and provider policy, prompt/schema versions, depth/evidence variant, environment, seed where supported, repetition count, budgets, stop rules |
| Attempt record | Case/repetition/variant, runtime run reference, terminal state, stage outcomes, valid usage, known cost, unknown-cost reservation, latency |
| Adjudication record | Finding/claim digest, label, matched root, causal evidence, adjudicator identity/type, rationale, unresolved disagreement |
| Score report | Metric numerators/denominators, missingness, case/family breakdown, paired deltas, uncertainty intervals, raw artifact references |

Implement under package-private `evaluation/`. Avoid exposing labels through
public product schemas, prompts, context services, logs transmitted to models,
or author packets. Product run records remain canonical for calls and charges.

## Oracle separation

Reviewer may receive requirements and tests that actually belong to declared
review scope. Evaluator-only bug descriptions, expected verdicts, gold fixes,
future regression tests, and issue-resolution discussion remain separate.
Fixture names in transmitted paths must not reveal labels such as `known-bug`.

For each case, retain a reviewer-input allowlist and an evaluator-only inventory.
Leak checks must inspect blind, verifier, author, reconciliation, tool-result,
and repair messages, including filenames and metadata. Reject a run if any
oracle-only artifact enters a reviewer stage.

Tests supplied as review evidence and tests used as a hidden oracle have distinct
roles. Moving a hidden regression test into reviewer context creates a new case
variant and must not be compared as though inputs stayed constant.

## Finding adjudication

Match a finding to a root only when it identifies the relevant obligation,
reachable failing scenario, wrong behavior/impact, and causal source evidence.
Location overlap or similar words alone is insufficient. Equivalent explanations
need not reproduce gold prose. A wrong scenario at a correct line earns no credit.

Assign one of these evaluator labels:

- `MATCHED_DEFECT`: supported claim matching a known root.
- `NOVEL_VALID_DEFECT`: supported, in-scope defect absent from current gold list.
- `INVALID_DEFECT`: incorrect premise, unreachable/out-of-domain scenario,
  unchanged/out-of-scope behavior, or unsupported causal claim.
- `UNRESOLVED`: insufficient evaluator evidence or adjudicator disagreement.
- `RECOMMENDATION`: useful non-defect engineering feedback, scored separately.
- `DUPLICATE`: repeated supported root already credited in this review.

Each root earns at most one recall credit per completed review. Multi-root
findings need distinct supported scenarios; a vague omnibus comment cannot claim
every root. Keep duplicates visible as triage burden. Validate novel findings
before changing labels and rescore baseline/candidate under the same corpus
version; never call every unmatched finding false simply because gold is partial.

Initial semantic adjudication uses a human-reviewed rubric and retained reasons.
A model judge may propose matches but cannot be sole authority for promotion
until a representative blind human sample establishes useful agreement. Review
all claimed severe false positives, novel roots, and baseline/candidate
disagreements. Do not infer independence solely from a different model name.

## Metrics

Use counts and ratios; no composite leaderboard score initially. Report macro
case/family views alongside pooled counts so a large case cannot hide weaknesses.

| Metric | Definition |
| --- | --- |
| Known-defect recall, completed runs | Unique known roots detected / known roots in completed eligible runs |
| Known-defect recall, all starts | Unique known roots in delivered valid reports / known roots across all started eligible case-runs |
| Adjudicated defect precision | Unique supported roots / (unique supported roots + invalid defect claims), with unresolved and duplicates reported separately |
| Conservative precision bound | Same numerator with unresolved defect claims added to denominator |
| Unique-action yield | Unique supported roots / all emitted defect claims, including duplicates and unresolved items |
| Clean false-positive rate | Completed clean reviews with at least one invalid defect claim / completed clean reviews |
| False abstention | Complete-evidence reviews unable to assess without valid necessary uncertainty / completed complete-evidence reviews |
| Correct uncertainty | Missing-required-evidence controls preserving the expected uncertainty / completed eligible controls |
| Duplicate rate | Duplicate defect claims / emitted defect claims |
| Delivery rate | Valid completed reports / all started reviews |
| Stage retention | Known true roots retained and false roots removed between preliminary, verification, and final |

For every ratio, denominator zero means unavailable, never 100%. Incomplete
adjudication must show unresolved counts and label coverage alongside precision.
All-start recall captures delivery failure without pretending a provider error
is a semantic model miss. Semantic analyses also report completed-run metrics.

Record severity/enforcement confusion counts, not only exact verdict agreement.
Recommendations receive separate usefulness/invalidity labels and never inflate
defect recall. Negative advice that blocks work through uncertainty or standards
status is assessed even when no finding appears.

Latency: per-review elapsed time and per-stage distribution, including failures.
Cost: successful-call reported cost, unknown-cost attempts, and conservative
reservation separately. Report aggregate admitted ceiling; never infer failed
calls cost zero. Measure provider attempts, evidence bytes, output size, and
execution resources when available.

## Repetition and comparisons

Freeze repetition count, case set, engine revisions, model/provider constraints,
budgets, and stopping rules before execution. Initial proposal: three repetitions
of one baseline and one change, only after a bounded canary succeeds and explicit
aggregate spend is authorized. This is an experiment template, not authorization
to start 180 reviews or a universal required batch size.

Use the same case corpus across variants. Interleave/randomize variant order
under the same pacing policy to reduce route/time confounding; retain actual
model/provider metadata. A seed is recorded where supported but does not imply
deterministic provider output.

Each repetition ends in its original terminal state. A transport retry belongs
to that run's configured attempt policy; a later restart or resume is separately
identified. Never report only a favorable retry, best-of-N result, or successful
recovery wave. Report recovery outcomes alongside initial delivery.

Estimate uncertainty at independent case/family level; repeated calls on the
same fixture are not new independent defects. For zero false-positive reviews
among 12 independent clean cases, exact one-sided 95% binomial upper bound is
about 22.1%, illustrating how little a tiny perfect sample establishes. Repeated
runs mainly estimate output variance, not population diversity. The NIST
[binomial interval guidance](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)
supports reporting interval assumptions explicitly.

## Required experiments by delivery stage

| Experiment | Fixed factors | Changed factor | Decision signal |
| --- | --- | --- | --- |
| B adjudication | Corpus, evidence, model/routing, budget policy | Claim eligibility/projection | Unsupported outcomes removed without hiding real roots or necessary uncertainty |
| C1 context | Corpus, reviewer/verification policies | Current windows vs declarations vs bounded access | Incremental recall/precision per added bytes, calls, and latency |
| C2 relations | C1 evidence policy | Reverse syntax baseline vs semantic adapter | Additional true cross-file roots; false edges and unsupported scope accounted |
| D verification | Snapshot, obligation, check oracle | Static evidence vs observed check | Better causal classification; environment errors stay distinct |
| E discovery | Corpus, evidence, adjudication | One discovery pass vs fresh focused pass | Incremental unique roots versus added noise and cost |

Avoid changing model, context, prompt, and scoring simultaneously. If an
experiment must change several components, label it an end-to-end comparison
and do not attribute benefit to a single component.

## Gates and stop conditions

Offline gate: fixture reconstruction, explicit schema/version checks, no label
leakage, deterministic scoring arithmetic, expected mock reports, and meaningful
negative controls. Runtime checks remain separate.

Semantic promotion gate: predeclare target metric, acceptable regressions,
mandatory canaries, cost/latency ceiling, adjudication coverage, and evidence
needed to make a decision. No severe unsupported blocking finding is acceptable
on designated clean safety canaries. Small holdout outcomes remain qualified
observations; require a larger representative sample before numerical reliability
claims or broad default enablement.

Stop on credential/privacy or identity failure, unexpected scope disclosure,
oracle leakage, admission inconsistency, aggregate budget exhaustion, or
predeclared provider-capacity threshold. Keep infrastructure failures visible
and do not tune semantic policy in response to 429/transport errors.

## Deliverables for first implementation

1. Versioned corpus and split manifests with provenance.
2. Evaluator-only artifact contracts and offline scorer.
3. Mock result corpus proving arithmetic, duplicate handling, partial labels,
   empty denominators, and delivery accounting.
4. Reviewer-message leak qualification.
5. Baseline run recipe and case-level report template.
6. Explicit paid experiment request containing exact case count, repetition,
   provider policy, maximum reservation, and stop rules.

### First implementation slice

The package-private [evaluation harness](../../evaluation/README.md) reconstructs 30 mixed synthetic
and repository-history-derived cases from clean Git baselines. Three defect cases are explicitly
labeled reduced reverse fixes of repository regressions #128, #132, and #137; they retain exact
source revision, parent, path/blob, issue/fix, environment, and honest no-license provenance. Fixed
`smoke` (4), `standard` (8), and `full` (30) suites plus group and exact-case selectors keep routine
runs bounded. Live execution requires an explicit selector, confirmation, and aggregate cost ceiling
before fixture creation or provider access. Opaque case IDs and construction-time leak guards keep
evaluator root labels outside reviewer inputs.

All six specified controls are unpaired and explicitly typed. Every pair shares BASE, reviewer mode,
requirements or standards, and complete author framing; only intended HEAD correctness differs.
Catalog oracle IDs are exhaustively classified as roots, uncertainties, or recommendations before
reconstruction.

This slice records versioned case and family split manifests, evaluator-only hidden assertions and
correction artifacts, experiment manifests, per-case terminal results, validated verdicts,
provider-reported usage, unknown-cost attempts, and conservative retry charges. It does not yet
satisfy finding-level scoring or repeated baseline qualification.
