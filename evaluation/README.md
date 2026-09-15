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
duplicates. Defect, uncertainty, and useful/invalid recommendation labels remain claim-kind scoped.
Zero-denominator metrics, unresolved adjudications, terminal failures, and cost uncertainty remain
visible. Execution-resource summaries remain empty until a later contract can bind them to retained
attempt evidence.

`oracle-leak.ts` checks supplied reviewer messages, message metadata, references, and attachment
bytes against evaluator-only roots, uncertainties, labels, artifact identities, and content. Caller
must supply every message and attachment available to each reviewer stage. Checks cover canonical
serialized messages, raw oracle subsequences inside attachment streams, ordered independently
base64-encoded metadata fragments, and case-insensitive hexadecimal forms without concatenating
across messages. This module does not intercept provider traffic or discover omitted messages.

These evaluator-only modules do not allocate corpus splits, execute scoring, collect runtime
messages, integrate artifacts into matrix runs, call providers, or change product behavior. Those
integration and execution steps remain later #160 work.
