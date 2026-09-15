# Review quality matrix

This package-private matrix checks review behavior against evaluator-owned cases. It is separate
from product tests: dry runs reconstruct every selected repository and validate capture/admission
without provider calls; live runs compare validated final reports with hidden expected verdicts.

## Run modes

| Suite | Cases | Purpose | Current maximum live reservation |
| --- | ---: | --- | ---: |
| `smoke` | 4 | Fast health check across both review modes | $0.08 |
| `standard` | 8 | Default provider-free change check and recommended paid regression run | $0.16 |
| `full` | 20 | Broad requirements, standards, adversarial, cross-file, and multilingual coverage | $0.40 |

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

## Corpus rules

- Keep case IDs opaque. Put defect labels and expected root causes only in evaluator-owned oracle
  fields; control inputs sent to the reviewer must not reveal them.
- Add behavior changes as clean/defect pairs where practical. Both members of a family belong to
  the same train/test split when scoring is added.
- Preserve fixed `smoke` and `standard` membership. Add new cases to `full` first; change smaller
  suites only when their coverage purpose changes deliberately.
- Set `labelsExhaustive` only when every material root cause has been labeled.
- Run `npm run matrix:dry -- --suite full --run-label <label>` before paying for new or changed
  cases.

Corpus expansion and scored quality gates continue under
[GitHub issue #160](https://github.com/dills122/independent-reviewer/issues/160). This first slice
owns reproducible selection, fixture construction, paid admission, and result accounting.

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
