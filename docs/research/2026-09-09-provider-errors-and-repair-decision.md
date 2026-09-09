# Provider errors and repair calls: decision brief

Status: researched recommendation; runtime changes not implemented.
Date: 2026-09-09. Decision owner: repository owner. Examined commit: `bd7846f`.

## Recommendation

Keep GPT-OSS 120B, the existing two-stage independent review, provider allowlist,
and cost ceiling. Prioritize:

1. Surface the provider-error details already present in saved responses.
2. Reduce redundant model-authored reconciliation metadata and make repair
   requests specific about missing references or contradictory fields.
3. Permit one budgeted retry per review for an explicit transient provider error,
   retrying only the failed call. Keep timeouts/unknown submissions separate.

Retain the current 180-second per-call timeout as practical headroom. Do not
claim it fixes upstream capacity. Do not add model fallback, streaming, a JSON
healing plugin, or another broad provider comparison now.

## Scope and method

Question: which changes improve completion rates without inflating cost or
weakening review independence? Used saved ledgers, raw error envelopes, rejected
candidates, current implementation, and official documentation. No paid inference
or account changes. Stop condition: identify failure classes, quantify repair
outcomes, and rank a small implementation sequence.

Primary cohort: 14 runs / 33 calls under `.review-runs/repeat-2026-09-09/`,
`.review-runs/repeat-recovery-2026-09-09/`, and `.review-runs/larger-2026-09-09/`.
This mixes prompts v6–v8, fixtures, concurrency, and timeout settings; percentages
are descriptive, not production reliability estimates. Historical 20B artifacts
were inspected only to distinguish earlier 429 and output-cap failures.

## Observations

### Provider failures have concrete upstream evidence

- **502:** saved `repeat-2026-09-09/clean/packet/review/provider-response-attempt-3.raw.json`
  contains `previous_errors`: CoreWeave returned 429, then DeepInfra failed to
  generate a completion. Same-model fallback was already attempted. The current
  normalized diagnostic exposes only the last provider, hiding this explanation.
- **Historical 429:** `health-candidate-live-2026-09-09/clean/packet-20b-deepinfra/review/provider-response-attempt-1.raw.json`
  identifies `provider_error_code=engine_overloaded` and
  `limit_source=upstream_provider_shared_pool`, with BYOK false. This supports
  upstream shared-capacity overload, not exhaustion of the user's personal quota.
  The adapter currently looks for `provider_code`, missing this alternative field.
- **Timeout:** the misleading-author preliminary attempt failed at 120,015 ms,
  matching our client deadline. Its provider and eventual completion/billing
  outcome are unknown. The transport wrapper loses the cause in the durable
  summary, so queue delay versus generation delay cannot be established.
- **Historical 20B length failures:** two saved CoreWeave responses report 4,096
  completion tokens, `finish_reason=length`, and no content. They report zero
  reasoning tokens. The exact generation/provider failure remains unknown;
  attributing it to hidden reasoning would be unsupported. No corresponding
  length failure occurred in the recent 120B cohort.

These observations do not justify removing either provider: both also completed
reviews. The final provider name alone cannot establish which routes were tried.

### Repair is mostly reconciliation overhead

Of 13 runs reaching a final candidate, seven completed without repair and six
requested one repair. Four repairs succeeded, one received the 502 above, and
one repeated its original contradiction. One additional run timed out before
final review. Initial repair reasons:

| Trigger | Runs |
| --- | ---: |
| Missing preliminary finding dispositions | 3 |
| Missing preliminary concern reference | 1 |
| Finding origin disagrees with supplied references | 1 |
| READY paired with every changed path UNASSESSED | 1 |

All six candidates were parseable JSON. These were not comma/brace failures.
Known repair-call cost was $0.001955340, about 17% of all reported cohort cost
($0.011605844). Two failed calls have unknown cost. Fourteen runs is a small,
non-independent sample, and paid repair cannot be assumed always to help.

Source locations: `src/orchestrator/two-stage-review.ts` (`parseFinal`,
`assertFinalSemantics`, `completeFinalStageV1`),
`src/orchestrator/response-schema.ts`, and `src/provider/openrouter.ts`.
The runner already assembles original source text, but the model still repeats
relationship information in finding origin, disposition type, and final IDs.
Repair instructions currently include generic error text, often without naming
which expected IDs are missing. Reference enums/counts are added only at repair.

## Documented facts and implications

- OpenRouter distinguishes upstream shared-capacity 429s from platform limits;
  it attempts eligible same-model fallbacks before surfacing an upstream error.
  Backoff should honor `Retry-After` when supplied. This matches the observed
  fallback chain. [Limits](https://openrouter.ai/docs/api_reference/limits)
- `only`, price caps, parameter support, and data-policy filters bound eligible
  routes. Our explicit `order` disables default load balancing. Keeping two
  approved routes is deliberate; adding a third requires a current capability,
  price, and data-policy check, not just a low advertised price.
  [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- Provider errors may arrive in a response body after HTTP headers were sent.
  HTTP status alone is insufficient; inspect the error envelope. No-content
  responses can have several causes, including warm-up/scaling, without proving
  that explanation for our failures.
  [Errors](https://openrouter.ai/docs/api_reference/errors-and-debugging)
- Strict JSON-schema enforcement varies by provider. Valid structure does not
  establish cross-reference consistency or factual correctness. Field descriptions
  are recommended to guide output. We already request strict structured output
  and supported parameters; turning them on again is not a solution.
  [Structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- Response Healing repairs JSON syntax/wrappers and cannot recover output
  truncated by the token cap. It does not address this cohort's reconciliation
  errors. [Response Healing](https://openrouter.ai/docs/guides/features/plugins/response-healing)
- Reasoning tokens count as output; excluding their display does not disable
  reasoning. Changing effort could affect quality and needs a controlled test,
  but this evidence does not establish reasoning as the cause of our failures.
  [Reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- Billing protection has specific eligibility rules. Do not equate missing
  visible content with zero billed cost or substitute it for recorded usage.
  [Zero Completion Insurance](https://openrouter.ai/docs/guides/features/zero-completion-insurance)

## Options and decision

| Option | Benefit | Tradeoff | Recommendation |
| --- | --- | --- | --- |
| More prompt sentences indefinitely | Cheap to try | Brittle; duplicates remain | Stop relying on this alone |
| Simpler candidate plus targeted repair errors | Addresses observed repair causes | Small candidate-contract change | First output-reliability work |
| One transient-error retry | May survive short overload/failure | Extra latency and possible cost | Add with run-wide cap |
| Retry every failed review | Easy superficially | Rebuys preliminary; unknown duplicates | Reject |
| Remove consistency checks | Fewer rejected reports | Could present unreviewed scope as READY | Reject silent acceptance; preserve uncertainty |
| New provider/model or larger token cap | Could help some failures | New quality/cost variables | Defer absent specific evidence |
| Streaming or JSON-healing plugin | Progress/syntax handling | Does not target observed causes | Defer |

### Proposed implementation sequence

**A. Small diagnostics improvement.** Retain a bounded provider failure chain
(provider name and error code), `limit_source`, native code aliases, and timeout
classification. Keep raw upstream text and account identifiers out of public
messages. Do not implement a general telemetry system.

**B. Simplify reconciliation.** Ask the model for conclusions and explicit source
links once. Derive finding origin from those links rather than asking for a second
possibly contradictory label. Keep an explicit reason when a preliminary finding
is withdrawn; missing links are incomplete reconciliation, never silently inferred
withdrawals. Keep the persisted report format if feasible. Add short schema-field
descriptions for inspection versus test execution. Repair errors should enumerate
missing IDs and identify contradictory fields. Reserve any added payload before
its provider call; do not expand prompts after budget admission unnoticed.

Keep necessary checks: required review data, frozen-source references, explicit
unreviewed scope, author/runner distinction, and blockers versus verdict. Do not
add exact prose comparisons or rewrite model judgments to make validation pass.
This removes redundant output obligations, not independence or evidence.

**C. One provider retry, at most, across the whole run.** Apply only to an explicit
429/502/503 error envelope with no usable candidate, for the identical failed stage
and messages. Honor Retry-After; otherwise use short backoff with jitter. If the
hint exceeds the permitted wait, return an actionable failure rather than retrying
early. Reserve cost/tokens before dispatch, charge unknown usage conservatively,
and record the additional attempt. Do not replay the blind assessment to recover
final or repair calls. Keep one output-repair allowance separate; worst case is
four calls (two mandatory, one output repair, one provider retry).

Do not automatically retry a client timeout, disconnect, or unknown submission.
The existing `resume-final` logic only accepts one exact final-429 event sequence;
a general retry implementation must update that eligibility coherently rather
than bypassing the ledger. No assumption that a 502 costs zero.

## Next gate and confidence

First validate the changed mapping/error handling against retained rejected
candidates, without provider calls. Then use the same cross-file, misleading-author,
and clean order-service fixtures: one run each, $0.06 total admission cap. Target:
expected findings, no bookkeeping repair, and unchanged author isolation. Provider
retries must never restart a successful preliminary stage. Broader model/provider
experiments wait for these results.

High confidence in the observed fallback chain and repair categories. Moderate
confidence that simpler output reduces repair frequency. Low confidence in any
provider ranking or claim that 180 seconds fixes latency: sample size and mixed
conditions do not support those conclusions. No new inference calls were purchased
for this research. Runtime, ADRs, and public contracts remain unchanged pending
selection of the recommendation.
