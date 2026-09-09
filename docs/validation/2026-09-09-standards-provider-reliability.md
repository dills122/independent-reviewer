# Standards provider reliability follow-up — 2026-09-09

Scope: one pinned-BaseTen reproduction and one existing-route control for the
previously incomplete clean naming case, using standards policy v4. No runtime
changes, new providers, broader retry policy, or additional evaluation batch.

| Configuration | Result | Calls | Retries / repairs | Seconds | Reported cost |
| --- | --- | --- | --- | --- | --- |
| baseten/fp4, pinned | Preliminary valid; final 529 twice | 3 | 1 / 0 | 11.6 | $0.0007528 plus two unknown-cost calls |
| coreweave/fp4, deepinfra/bf16 | READY, zero findings or limitations | 2 | 0 / 0 | 107.9 | $0.00082654 |

Both successful control calls returned from CoreWeave. The control retained the
same 4,096 output-token allowance as the BaseTen example to avoid confounding
this check with the recent 8,192 allowance change. Model, synthetic code, rules,
author text, 160,000 total-token limit, 180-second timeout and $0.02 run cap were
matched. Routing and price ceilings necessarily differed; each run had its own
snapshot/config identity. This was not an exact-wire replay.

BaseTen returned an explicit HTTP/provider 529 without Retry-After. The current
bounded recovery waited about seven seconds and retried only the final stage;
that retry also received 529. Original packets and preliminaries remain intact.
No uncertain submission was replayed, and absent cost telemetry was not treated
as zero cost. Combined reported cost: $0.00157934 plus two unknown-cost calls;
maximum combined reservation $0.04.

## Decision and limits

Use the existing CoreWeave/DeepInfra example for standards pilot runs. README now
identifies the pinned BaseTen example as diagnostic-only for this workflow until
revalidated. No provider is silently removed or added to a user's configured
allowlist, and no runtime hardcoded provider exclusion was introduced.

This confirms a working alternative for the clean case and correctly bounded
recovery on the failing route. It does not fix BaseTen or establish an uptime
guarantee. Because preliminary calls succeed while final calls consistently
receive overload responses, public error messages do not distinguish general
capacity from request-specific behavior. That upstream cause remains unresolved;
more retries or an arbitrary delay would not establish it.

No new application tests were needed for this documentation-only mitigation.
Latest runtime check remains 213 passing tests at the prior configuration commit;
repository CI-context checks and diff whitespace checks pass for this change.

Artifacts:
- `.review-runs/standards-provider-check-2026-09-09/clean/`
- `.review-runs/standards-provider-control-2026-09-09/clean/`

The clean case now has a completed expected result. Original mandatory and
permitted-exception cases still need final-stage confirmation on a working route;
the earlier matching preliminaries alone are not completion evidence.
