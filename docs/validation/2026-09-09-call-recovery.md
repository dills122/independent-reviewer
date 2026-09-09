# Call recovery fix — 2026-09-09

## Changes

- Normally terminated empty completions can trigger the existing one-per-run
  provider retry. Truncation, model mismatch, and malformed review content remain
  distinct from this transport recovery path.
- HTTP 429/500/502/503/504 remain recognizable when the body is plain text or
  lacks OpenRouter's error object. Retry-After is honored within the bounded wait.
- A retry preserves messages and schemas, preferring another endpoint inside
  the original allowlist. Audit digests reflect the changed routing order.
- Admission reserves both mandatory calls plus the larger stage's retry tokens
  and cost before submission. The 120B example now allows 160,000 conservative
  token units with the same $0.02 cost ceiling. The larger fixture needs 104,433
  reserved units; its former 80,000-unit cap could not cover recovery.
- Unknown-outcome transport timeouts remain visible and are not automatically
  replayed. This prevents silently duplicating possibly billed requests.

## Verification

`npm run check` passes all 193 existing tests; `git diff --check` passes.
Successful live calls reported $0.001180734 combined. The failed 429's actual
cost is unknown; its conservative reservation is retained separately.

A direct adapter/orchestrator replay using saved successful responses injected
an empty completion, plain-text 503, and 429 into the final stage. Each completed
with three calls total, one preliminary assessment, identical final messages,
one provider retry, and unchanged provider allowlist. No external calls or
credentials were used by the replay.

The live eight-file buggy order refactor then exercised actual recovery:

1. CoreWeave completed the blind review in 93.8 seconds.
2. The final call received a shared-pool 429; diagnostics also recorded a prior
   DeepInfra 429 during provider fallback.
3. The runner reserved 37,113 token units and $0.001917949 for the failed attempt,
   waited 1.824 seconds, and retried only the final stage.
4. The retry completed, finding exactly the seeded incorrect-tax and repeated-
   request double-charge defects. No candidate repair was required.

This proves recovery from one observed live transient failure, not immunity to
provider outages. Private ledgers, response bodies, report, and replay results:
`.review-runs/call-recovery-2026-09-09/`.

The live process used an intermediate diagnostic-only
`RETRY_CAPACITY_RESERVED` event. That extra event was removed before final checks
to preserve the existing strict manual-resume event sequence. Recovery logic and
wire requests are unchanged by its removal.
