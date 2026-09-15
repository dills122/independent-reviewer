# Paid smoke checkpoint — 2026-09-15

Target: merged `main` at `447a954` (`Define evaluation artifact contracts
(#178)`). This checkpoint tested provider and harness health after the next-wave
documentation, claim-adjudication decision, bounded Git preflight, and evaluator
contract foundation landed. Evaluation contracts are package-private, so they
did not change live review prompts or routing.

## Frozen request

The provider-free admission used the fixed four-case `smoke` suite and passed
4/4 with no calls. The authorized live request then used:

- selector: `--suite smoke`;
- run label: `checkpoint-smoke-447a954-20260915-live`;
- maximum reservation: `$0.08`;
- cases: `case_001`, `case_002`, `case_006`, and `case_012`; and
- local ignored `.env` credential loading, without persisting the key in run
  artifacts or command output.

The first live pass completed only `case_001`. It returned the expected `READY`
verdict after two calls. The other three cases stopped incomplete after
DeepInfra returned HTTP 429 provider errors. Runner accounting recorded nine
calls started, three succeeded, six failed, `$0.0007437` provider-reported cost,
and six unknown-cost attempts. No automatic retry followed.

## Explicit failed-case retry

After separate authorization, only the three incomplete cases were selected.
Provider-free admission again passed 3/3. The live retry used run label
`checkpoint-retry-447a954-20260915-live` and a `$0.06` maximum reservation.

| Case | Expected | Observed | Calls | Result |
| --- | --- | --- | ---: | --- |
| `case_002` | `NOT_READY` | `NOT_READY` | 3 | matched |
| `case_006` | `NOT_READY` | `NOT_READY` | 3 | matched |
| `case_012` | `UNABLE_TO_VERIFY` | `UNABLE_TO_VERIFY` | 3 | matched |

Retry accounting recorded nine calls started and succeeded, no failed calls,
`$0.0023565` provider-reported cost, and no unknown-cost attempts. Across both
live executions, known provider-reported cost was `$0.0031002`; the first pass
still has six attempts whose provider cost was not reported, so that figure is
not total actual spend.

## Interpretation

Combined observed verdicts matched all four smoke expectations. This is a
provider/harness checkpoint, not a repeated quality baseline or finding-level
score. First-pass 429s remain visible as transient provider-capacity evidence;
the explicit retry's 9/9 successful calls did not reproduce them. This result
therefore does not trigger provider-offering expansion. A future bounded retry
wave that again ends in provider-capacity failures should precede any routing
expansion and should define route health alerts, provider attribution, cooldown,
and unknown-cost handling before adding providers.

Private reproducibility artifacts remain under
`.review-runs/evaluation/checkpoint-smoke-447a954-20260915-live/` and
`.review-runs/evaluation/checkpoint-retry-447a954-20260915-live/`; these paths
are intentionally excluded from Git.
