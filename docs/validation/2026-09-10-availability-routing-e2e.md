# Availability routing live E2E — 2026-09-10

Validates [ADR-006](../decisions/006-route-for-availability-not-pinning.md) against
the paid OpenRouter account. Offline suite: 223 tests, 0 failures.

## Endpoint-catalog and rate-limit measurement

`openai/gpt-oss-120b` currently lists **22 endpoints**. The previous wire policy
sent `only: order` and, for the final stage, `order.slice(0, 1)` with
`allow_fallbacks: false`, so the call that produces the report ran on one of
those 22 with no failover.

Twelve back-to-back one-token probes returned HTTP 429
`temporarily rate-limited upstream` roughly 40 percent of the time, under every
routing configuration tried — pinned, unpinned, with and without `zdr`, and with
fully open routing. Fifteen probes spaced four seconds apart returned fifteen
successes across `openai/gpt-oss-120b`, `moonshotai/kimi-k2.5` and
`anthropic/claude-sonnet-5`. The account holds $10 of credits and is not free
tier, so the 429s were an account-level burst limit rather than credit
exhaustion, provider pinning, or the low-traffic mystery earlier runs recorded.
`ProviderCallPacerV1` was constructed with `minimumIntervalMs = 0` and so
imposed no spacing until after a 429 had already been returned.

`provider.ignore` was checked separately: OpenRouter accepts both a display name
(`CoreWeave`) and an endpoint tag (`coreweave/fp4`), and silently accepts an
unknown value. A wrong exclusion therefore degrades to a no-op and must not be
read as an assertion that an endpoint was excluded.

## Review batch

Fixture: a two-branch Git repository whose `bug` branch adds `cartTotalCents`
computing `subtotal - subtotal * discount.percentOff` where `percentOff` is
documented 0-100, so a 10 percent discount on 2,000 cents returns -18,000. The
author packet claims the value was hand-checked as 1,800.

| Runs | Mode | Outcome |
| --- | --- | --- |
| 6 sequential | Requirements | 6 completed, verdict Not ready |
| 4 concurrent | Requirements | 4 completed, verdict Not ready |
| 1 | Requirements | Completed, verdict Not ready |
| 1 | Standards | Completed, Standards satisfied |

Totals across 12 runs: **25 successful provider calls, 0 failed calls, 0
retries**, $0.0128615 provider-reported cost. Sequential wall time 61-107
seconds per review; the concurrent four finished in 29-111 seconds with no 429.

Six distinct endpoints served those calls: AkashML, CoreWeave, DeepInfra,
Google, Mancer 2, Nebius. Only CoreWeave and DeepInfra appear in the example
config's `order`. Under the previous policy the final call of every run would
have been pinned to `coreweave/fp4` with failover disabled.

One run (`seq-bug-2`) had its final candidate rejected once and completed
through the existing repair call, using three provider calls rather than two.

## Detection

The requirements-mode runs reported the seeded defect as a P1 with a concrete
failing scenario, cited `src/cart.ts` HEAD lines 23-24, proposed dividing
`percentOff` by 100, and marked the author's hand-check claim as contradicted.

The standards-mode run on the same code returned Standards satisfied. That is
correct for its stated scope — the mode reviews selected code-quality rules and
excludes bug hunting — but it means standards mode must not be presented as a
defect review.

## What this does not establish

No live retry, model fallback, or provider exclusion occurred, because nothing
failed. The retry, backoff, failed-attempt charging, and `provider.ignore` paths
are covered offline only. Twelve successful runs on one small fixture also do
not measure behavior on large diffs, where output-token limits and context
length were the earlier failure surface.
