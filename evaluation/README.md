# Review quality matrix

This package-private matrix checks review behavior against evaluator-owned cases. It is separate
from product tests: dry runs reconstruct every selected repository and validate capture/admission
without provider calls; live runs compare validated final reports with hidden expected verdicts.

## Run modes

| Suite | Cases | Purpose | Current maximum live reservation |
| --- | ---: | --- | ---: |
| `smoke` | 4 | Fast health check across both review modes | $0.08 |
| `standard` | 8 | Default provider-free change check and recommended paid regression run | $0.16 |
| `full` | 30 | Broad paired requirements, standards, adversarial, cross-file, and multilingual coverage | $0.60 |

Ceilings use the committed configuration's $0.02 per-case limit. Provider-reported charges are
usually lower, but admission always reserves the full ceiling. Both `matrix:dry` and `matrix:live`
are separate from `npm run check`; live runs additionally require explicit paid confirmation.

List all cases:

```sh
npm run matrix:list
```

Run the default `standard` suite without provider calls:

```sh
npm run matrix:dry -- --run-label candidate-dry
```

Choose one suite, one or more groups, or one or more exact cases:

```sh
npm run matrix:dry -- --suite smoke --run-label smoke-dry
npm run matrix:dry -- --group multilingual --run-label multilingual-dry
npm run matrix:dry -- --case case_017 --case case_018 --run-label go-pair-dry
```

A live run requires a clean committed checkout, an explicit selector, explicit paid confirmation,
and an operator ceiling that covers the selected cases:

```sh
npm run matrix:live -- \
  --suite standard \
  --run-label candidate-live \
  --confirm-paid \
  --max-total-cost-usd 0.16
```

Each run writes an immutable manifest, per-case result, and aggregate summary under
`.review-runs/evaluation/<run-label>/`. Existing labels are rejected. Reported spend and unknown-cost
attempts remain separate; retry reservations are recorded as conservative charges, not claimed as
provider bills.

## Reconstruct evaluator corpus

Reconstruct all 30 cases, validated case manifests, evaluator-only oracle artifacts, and complete
family split manifest into a new explicit directory without calling a provider:

```sh
npm run matrix:reconstruct-corpus -- --output /tmp/independent-reviewer-corpus-v1
```

Output directory must not already exist. Each reconstructed repository contains reviewer-visible
inputs only. Sibling `evaluator/` directories retain hidden assertion records, correction artifacts,
and case manifests; top-level `evaluator/family-split-manifest.json` binds every case-manifest digest.
Git runs receive an explicit deterministic environment, fixed author and committer metadata,
isolated configuration, disabled hooks and signing, and no ambient `GIT_*` authority channels. Thus
identical clean checkouts produce identical BASE commit and case-manifest identities.

Case manifests intentionally omit mutable development/holdout assignment. Evaluators must load each
case manifest together with `family-split-manifest.json` and call
`validateEvaluationFamilySplitV1`; its exact case-manifest digest and family binding make the split
authoritative only for that jointly validated case artifact.

Corpus v1 contains 12 defect/clean pairs and six controls. Eight pairs are development data and four
are holdout data. Controls cover missing required context, irrelevant missing context, misleading
author concern, unsupported author defense, conflicting applicable standards, and post-author claim
change exactly once. Whole families stay in one split, and paired reviewer inputs are identical.
Every case records source and license provenance, an explicit unqualified runtime identity,
obligations, label completeness, and expected roots, uncertainties, or recommendations. Unknown
catalog oracle IDs fail reconstruction instead of being filtered.

Three defect cases are reduced reverse-fix fixtures derived from repository regressions
[#128](https://github.com/dills122/independent-reviewer/issues/128),
[#132](https://github.com/dills122/independent-reviewer/issues/132), and
[#137](https://github.com/dills122/independent-reviewer/issues/137), fixed by commit
`597e2ba758a232f109f85dc01c47e21f9d30ed2a` and [PR
#139](https://github.com/dills122/independent-reviewer/pull/139). Their provenance retains source
path and blob identity, exact fix and parent revisions, issue/fix references, and environment needs.
That source revision has no top-level license file; manifests record `NO_LICENSE_FILE` and the narrow
repository-owner evaluator-use basis rather than claiming an open-source license. Clean pair members
are reduced comparators, not historical PRs. Oracle assertions are evaluator evidence, not qualified
executable checks; isolated execution remains deferred to Stage D.

## Corpus rules

- Keep case IDs opaque. Put defect labels and expected root causes only in evaluator-owned oracle
  fields; control inputs sent to the reviewer must not reveal them.
- Add behavior changes as clean/defect pairs where practical. Pair members keep BASE, obligations,
  standards, author framing, and split fixed; only intended HEAD correctness changes.
- Preserve fixed `smoke` and `standard` membership. Add new cases to `full` first; change smaller
  suites only when their coverage purpose changes deliberately.
- Set `labelsExhaustive` only when every material root cause has been labeled.
- Run `npm run matrix:dry -- --suite full --run-label <label>` before paying for new or changed
  cases.

Scored quality gates continue under
[GitHub issue #160](https://github.com/dills122/independent-reviewer/issues/160). Current slices own
reproducible selection, fixture construction, family splits, evaluator-only oracles, paid admission,
and result accounting.

## Evaluator artifact contracts

`artifact-contracts.ts` defines package-private v1 validation and serialization contracts for case,
split, experiment, attempt, adjudication, and score artifacts. `artifact-graph.ts` validates one
fully supplied artifact graph against frozen case, split, experiment, source, engine, variant,
repetition, claim, and raw-reference identities. Experiment manifests predeclare full metric and
baseline/candidate pair-comparison membership. Graph validation recomputes attempt, case, family,
and aggregate counts, paired deltas, resources, latency, cost, severity calibration, and enforcement
confusion from retained attempt/adjudication evidence. Pair membership is explicit and complete;
preliminary and final stages are provider-backed while eligible no-adverse-claim verification stays
local. Known-cost and unknown-cost attempt counts reconcile to every provider attempt. Stage
retention credits both retained true roots and removed false roots without double-crediting final
duplicates, and failed attempts contribute no retention denominator. `matchedRootId` is semantic
root identity for all supported defects: `MATCHED_DEFECT` names a case-oracle root,
`NOVEL_VALID_DEFECT` names a non-oracle root, and `DUPLICATE` names a root credited in same attempt
and stage. `INVALID_DEFECT` also names a non-oracle semantic root so wording-only restatements cannot
be scored as removed between stages. Defect, uncertainty, and useful/invalid recommendation labels
remain claim-kind scoped.
Zero-denominator metrics, unresolved adjudications, terminal failures, and cost uncertainty remain
visible. Execution-resource summaries remain empty until a later contract can bind them to retained
attempt evidence.

Clean-control scoring follows evaluator oracle semantics, not pair membership: every case with
exhaustive labels and zero expected defect roots contributes to clean false-positive rate, including
unpaired controls. Pair metadata remains limited to exact predeclared paired-delta selection.

`oracle-leak.ts` checks supplied reviewer messages, message metadata, references, and attachment
bytes against evaluator-only roots, uncertainties, labels, artifact identities, and content. Caller
must supply every message and attachment available to each reviewer stage. Checks cover canonical
serialized messages, raw oracle subsequences inside attachment streams, ordered independently
base64-encoded metadata fragments, and case-insensitive hexadecimal forms without concatenating
across messages. This module does not intercept provider traffic or discover omitted messages.

`scorer.ts` deterministically derives a complete `EvaluationScoreReportV1` from fixed case, split,
experiment, attempt, and human-adjudication artifacts. Callers supply stable artifact references,
score ID, and generation timestamp; scorer computes digests, attempt/case/family/global counts,
predeclared pair deltas, missingness, latency, resources, cost, severity, and enforcement confusion,
then validates complete graph before returning. Zero denominators stay unavailable. Provider
failures remain missing delivery while semantic abstentions remain delivered reports and are scored
through false-abstention policy. Recommendation adjudications stay visible in exact raw/evidence
coverage but cannot inflate defect metrics. Current intervals use explicit conservative `[0, 1]`
bounds because repeated calls are not independent cases or families. Artifact arrays are ordered by
UTF-16 artifact ID. Numeric totals retain each value's artifact ID, order by magnitude then numeric
value then UTF-16 artifact ID, and use Neumaier compensated summation.

USD values use fixed nine-decimal units. Contracts reject excess precision or values whose scaled
units exceed JavaScript safe-integer range. Cost totals and budget comparisons use integer units,
so boundaries such as `0.1 + 0.2 <= 0.3` remain exact without masking a one-unit overage.

Graph validation receives artifact locations independently from score under validation. Registry must
cover every case, split, experiment, attempt, and adjudication exactly once; one location cannot
alias multiple artifacts. Score type, ID, location, and recomputed digest must match registry entry.
Raw references use UTF-16 ordering by artifact type, then ID, then reference location.

`scorer-policy.ts` retains canonical policy bytes, scorer version, and their SHA-256 digest. Every
experiment and score must claim those exact values. Separate raw-artifact reference is unnecessary:
experiment engine commit and source-tree digest bind implementation containing policy source, while
experiment and score artifacts both carry policy digest derived directly from exported canonical
document bytes.

These evaluator-only modules do not allocate corpus splits, collect runtime messages, integrate
artifacts into matrix runs, call providers, or change product behavior. Those integration steps
remain later #160 work.
