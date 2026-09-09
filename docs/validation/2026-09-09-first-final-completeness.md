# First-final concern completeness — 2026-09-09

Target: recent conflict and missing-context runs required a paid repair because
the first final response omitted a saved preliminary limitation reference.

Root cause: first-final schema restricted maximum count and available kinds but
allowed zero entries. Exact count and indices were enforced only for repair.
Also, final capacity was 24 entries while preliminary allowed 24 gaps plus 12
limitations. The first final now requires the exact saved count and bounds
indices to the kind-local available range, with capacity for all 36 concerns.

The pre-call schema template includes widest numeric bounds so specialization
does not enlarge its admitted byte/token reservation. Regression verifies empty,
one-kind, mixed-kind and maximum scope, input immutability, exact counts, index
bounds, and non-increasing serialized size. Local (kind,index) completeness and
duplicate validation remain authoritative. Repair/retry budgets unchanged.
Policy identities advanced to review v12 / standards v4; artifact contracts did
not change. The regression failed before the fix; npm run check passes 213 tests
and the separate CI repository-context check passes.

## Targeted live result

Same synthetic missing-context case and GPT-OSS 120B/CoreWeave-DeepInfra config,
8,192 output-token allowance and $0.02 review cap. New private run, no replay of
an uncertain submission. Both returned calls used CoreWeave.

Two calls, **zero repairs**, **zero provider retries**, 79.3 seconds,
**$0.0004606** reported cost, no unknown-cost calls. Preliminary produced one
evidence gap and one limitation. First final correctly referenced index 0 once
for each kind and retained both concerns. Final UNABLE_TO_VERIFY, zero findings,
and a request for existing authoritative evidence matched expected semantics.

This confirms one first-final success on the affected scenario, not a guarantee
of future model compliance or a controlled latency comparison. Earlier failed
and repaired runs remain intact. No broader evaluation batch was run.

Artifacts: `.review-runs/standards-concern-fix-2026-09-09/missing-context/`.
