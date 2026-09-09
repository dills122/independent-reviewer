# Advisory output-limit follow-up — 2026-09-09

The initial advisory standards run ended with CoreWeave finish_reason=length at
4,096 completion tokens and no valid final report. This targeted follow-up used
the same fixture, GPT-OSS 120B, CoreWeave/DeepInfra allowlist, 160,000 total-token
limit, $0.02 cost cap, and the 8,192 output allowance used in recent standards
checks. Standards policy is now v4, including intervening rule-accounting and
first-final reference fixes; this is not a controlled single-variable comparison.

Result: READY_WITH_FOLLOW_UPS, exactly one RECOMMENDED naming finding, a concrete
rename suggestion, zero blockers, and no limitations. Two calls, zero repairs,
zero retries; both calls returned from CoreWeave. Elapsed 110.1 seconds.
Reported cost $0.00077438, no unknown-cost calls.

Preliminary used 1,268 completion tokens; final used 2,468. Neither exceeded the
old allowance in this reproduction. Therefore the result confirms the formerly
incomplete scenario now completes with the tested configuration; it does not
prove the larger allowance caused success or eliminates truncation generally.

The ordinary CoreWeave/DeepInfra example config now exposes the tested 8,192
allowance, with total-token and cost limits unchanged. Larger scopes still need
admission checks; no automatic replay or automatic budget expansion was added.
The separately pinned BaseTen example is unchanged pending provider follow-up.

No runtime code changed. No new tests added for this configuration change.
Private fixture, responses, report and ledger:
`.review-runs/standards-advisory-check-2026-09-09/advisory/`.

Verification after the example update: npm run check passes all 213 tests;
python3 -B scripts/check-ai-context.py --ci passes.
