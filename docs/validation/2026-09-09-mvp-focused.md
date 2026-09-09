# Focused MVP live check — 2026-09-09

Targeted prompt change: require present defects with concrete failing scenarios,
calibrate P0–P3 severity, and explicitly permit withdrawal of unsupported
preliminary findings. Prompt version: `review-policy-v4`. No new validation
layers or tests added; existing reservation fixture allowance updated for prompt size.

Three existing synthetic scenarios ran through the real CLI and OpenRouter with
GPT-OSS 120B, CoreWeave/DeepInfra routing, and a $0.02 admission ceiling per run.
All six calls were served by CoreWeave. Each review completed in two calls,
without repair. Reported usage cost totals $0.00170073; this is provider telemetry,
not settled billing.

| Scenario | Result | Duration | Reported cost |
| --- | --- | --- | --- |
| Inverted access predicate | Not ready; one P1 finding; no speculative extra finding | 76.2 s | $0.00059553 |
| Clean refactor | Ready; no findings | 47.9 s | $0.00039650 |
| Explicit no-logging rule violation | Not ready; logging defect caught | 78.9 s | $0.00070870 |

Quality limitation: rule-violation report repeats the same logging line under two
applicable rules. Both refer to a real defect, but should ideally be one finding.
These three samples demonstrate the MVP flow, not a general accuracy guarantee.

Independence: existing runner withholds author explanation until the blind
assessment is saved. No implementation conversation or agent memory is supplied.
The clean report marks author-reported tests unverified; the bug report contradicts
the misleading author claim. Credentials remain in local `.env`, outside review inputs.

Private requests, fixtures, responses, and reports are under
`.review-runs/mvp-focused-2026-09-09/`. From the repository root, rerun the bug
scenario against its existing fixture using the normal user-facing command:

```sh
node --env-file=.env dist/src/cli.js review \
  --request .review-runs/mvp-focused-2026-09-09/bug/request-120b.json \
  --config examples/review-config.gpt-oss-120b.json \
  --output .review-runs/manual-bug-review-01
```

Output directory must be new for each review. Exit 2 means a completed Not ready
review, not an execution failure. Exit 0 means Ready. The CLI prints the report path.
