# OpenRouter provider failover and cost-control research spike

Status: accepted and implemented.

Date: 2026-09-08

Decision owner: repository owner.

## Executive conclusion

Keep the reviewer model fixed and enable bounded **provider** failover inside
each OpenRouter request. Do not add a fallback model, an automatic whole-run
retry, or an arbitrary delay between review stages.

The current adapter sets `allow_fallbacks: false`. With OpenRouter's default
price-prioritized routing, the inexpensive AkashML endpoint handled each
successful preliminary call. In both smoke runs that reached the final stage,
the immediately following final call returned an AkashML HTTP 429. The final
attempt produced no usable completion, but rerunning the application would buy
another preliminary response before reaching the same point.

For the next smoke-test slice, use this explicit policy for
`openai/gpt-oss-20b`:

```json
{
  "order": ["coreweave/fp4", "deepinfra/bf16"],
  "only": ["coreweave/fp4", "deepinfra/bf16"],
  "allow_fallbacks": true,
  "require_parameters": true,
  "data_collection": "deny",
  "zdr": true,
  "max_price": {
    "prompt": 0.03,
    "completion": 0.14,
    "request": 0
  }
}
```

This keeps the same model and restricts routing to two currently available ZDR
endpoints that advertise `response_format` support. CoreWeave is the primary;
DeepInfra is the bounded backup. The price cap is expressed in dollars per
million tokens and rejects a route that becomes more expensive than the
declared ceiling.[^provider-routing]

Provider order is operational configuration, not a permanent judgment about
the companies. Endpoint capabilities, prices, and performance change. Recheck
the endpoint metadata before adopting this as a long-lived default.

## Decision question

How should the mandatory two-stage review survive an upstream provider 429
without paying repeatedly for successful preliminary calls, weakening privacy
or schema enforcement, or changing reviewer models?

## Scope and stop condition

This spike covers:

- the three diagnostic smoke ledgers from 2026-09-08;
- OpenRouter's current 429, same-model routing, ZDR, structured-output, and
  zero-completion billing behavior;
- current endpoint metadata for `openai/gpt-oss-20b`;
- provider fallback, provider pinning, delay, model fallback, and whole-run
  retry options; and
- the smallest implementation and paid validation gate.

It does not make an inference call, mutate the OpenRouter account, implement a
routing change, select the eventual production reviewer model, or evaluate
review accuracy.

Research stopped once primary OpenRouter documentation, current endpoint
metadata, and repeated local behavior were sufficient to rank the options and
bound the next paid check.

## Decision criteria

1. Do not pay for another preliminary solely because the final-stage provider
   is temporarily unavailable.
2. Keep the requested reviewer model fixed across both stages.
3. Preserve strict structured output, `data_collection: "deny"`, and ZDR.
4. Bound provider eligibility and per-token/per-request prices explicitly.
5. Keep retries visible and avoid ambiguous resubmission after timeouts.
6. Add as little product machinery as possible.

## Local observations

All three diagnostic runs used the same frozen snapshot and
`openai/gpt-oss-20b`. Their durable ledgers report:

| Run | Preliminary result | Final result | Provider-reported preliminary cost |
| --- | --- | --- | ---: |
| `diagnostic-run` | Valid, 2,839 tokens, 24.010 s, AkashML | HTTP 429 from AkashML after 1.211 s | $0.00016766 |
| `diagnostic-run-2` | 3,639 tokens, 115.856 s, AkashML; rejected locally for invalid evidence path | Not called | $0.00024758 |
| `diagnostic-run-3` | Valid, 2,479 tokens, 14.408 s, AkashML | HTTP 429 from AkashML after 6.117 s | $0.00013142 |

The successful preliminary responses total `$0.00054666` in provider-reported
cost. Immediately after the latest run, the account usage endpoint still
reported `$0.00041524`. This discrepancy is an accounting timing or adjustment
unknown; do not treat an immediate key-usage read as the authoritative cost of
the newest request.

Both final failures had:

- HTTP status `429` and returned provider `AkashML`;
- no provider error subtype or upstream provider code;
- no response ID; and
- no `Retry-After` value.

These observations are consistent with an AkashML capacity or rate limit after
a successful long request. They do not prove a provider-specific rate window,
because the response supplied no subtype or retry hint. OpenRouter documents
that a 429 can originate either at OpenRouter or at an upstream provider, and
that upstream fallback is attempted before a provider-side error reaches the
client when fallback routing is allowed.[^limits]

## Current endpoint evidence

An authenticated read-only call to OpenRouter's model Endpoints API and its ZDR
endpoint list on 2026-09-08 found twelve ZDR routes for
`openai/gpt-oss-20b`.[^endpoints-api] The three routes most relevant to this
decision were:

| Endpoint tag | ZDR list | `response_format` | Prompt / 1M | Completion / 1M | 30-minute uptime | P50 throughput |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `akashml/fp4` | Yes | Yes | $0.02 | $0.10 | 99.516% | 34 tok/s |
| `coreweave/fp4` | Yes | Yes | $0.03 | $0.13 | 99.999% | 107 tok/s |
| `deepinfra/bf16` | Yes | Yes | $0.03 | $0.14 | 99.989% | 75 tok/s |

This is a point-in-time observation, not a service guarantee. OpenRouter also
states that provider 429s are tracked separately from uptime, so a high uptime
figure alone does not rule out the behavior seen in our smoke runs.[^provider-integration]

## Documented facts and implications

### Same-model fallback is the native recovery mechanism

- **Documented fact:** `allow_fallbacks` defaults to `true`. OpenRouter's normal
  routing prioritizes providers without recent outages, favors cheaper stable
  candidates, and uses the rest as fallbacks. `order` sets preferred provider
  order; `only` limits the eligible provider set.[^provider-routing]
- **Observation:** this adapter overrides the default with
  `allow_fallbacks: false`, leaving one selected endpoint to serve each call.
- **Inference:** enable fallback within a small allowlist. This repairs the
  availability gap without changing the model or creating another application
  attempt.

### Failed zero-output calls are protected, but successful preliminaries are not

- **Documented fact:** OpenRouter's automatically enabled zero-completion
  insurance does not deduct inference cost for responses with an error finish
  reason, or with zero completion tokens and a blank/null finish reason. It
  covers prompt, completion, and reasoning inference charges.[^zero-completion]
- **Inference:** the observed final 429s should not themselves create inference
  charges if they met those conditions. The successful preliminary calls are
  usable model output and remain billable. Avoiding whole-run repetition is
  therefore the important cost saving.
- **Unknown:** the failed records have no generation ID or usage object, so the
  local ledger cannot independently reconcile each failed request to a settled
  zero charge.

### Privacy and schema filters compose with fallback

- **Documented fact:** `zdr: true` restricts routing to ZDR endpoints;
  `data_collection: "deny"` excludes providers that collect data; and
  `require_parameters: true` excludes endpoints that do not support every
  supplied parameter.[^provider-routing]
- **Inference:** fallback does not require relaxing these constraints. It only
  broadens recovery inside the explicitly eligible intersection.

### A rate ceiling is not a complete run-cost cap

- **Documented fact:** `max_price` prevents a request from running when no
  eligible provider is at or below the configured prompt, completion, and
  optional request-unit prices.[^provider-routing]
- **Inference:** combine `max_price` with the existing maximum-token admission
  and the API key's credit cap. `max_price` limits unit rates; it does not alone
  cap total tokens or total dollars.
- **Bound for the proposed smoke policy:** the current `maxTotalTokens: 80,000`
  and `$0.14/1M` highest permitted token rate imply a deliberately loose
  inference-only ceiling of `$0.0112` for the whole run. The real ceiling is
  lower because output is capped at 4,096 tokens per call and prompt tokens cost
  at most `$0.03/1M`. The last preliminary would have cost approximately
  `$0.00017690` at the proposed maximum endpoint rates.

### Provider retries and model retries are different decisions

- **Documented fact:** a `models` list falls back to a different model on rate
  limits and other errors, and the successful request is priced using the model
  ultimately used.[^model-fallbacks]
- **Inference:** do not add a fallback model now. It changes reviewer behavior,
  complicates evaluation, and is unnecessary while the same model has multiple
  compatible ZDR providers.

## Options considered

| Option | Avoids repaid preliminary | Same model | Cost bound | Reliability | Decision |
| --- | --- | --- | --- | --- | --- |
| Keep one provider and rerun the whole review | No | Yes | Poor | Low | Reject |
| Add a fixed inter-stage delay | Maybe | Yes | Medium | Unknown | Reject as primary fix |
| Pin both calls to another single provider | Maybe | Yes | Good | Single point of failure | Reject |
| Allow unrestricted provider fallback | Yes | Yes | Weak without price cap | High | Reject |
| Allowlist two providers with same-model fallback and price cap | Yes | Yes | Strong | High | **Recommend** |
| Add fallback reviewer models | Yes | No | Configurable | Highest | Defer |
| Add application-level call retries | Maybe | Yes | Requires reservations/idempotency policy | Medium | Defer |

### Why not a delay?

Neither failed response supplied `Retry-After`, and no official AkashML rate
window was established. A guessed delay makes every review slower and can still
fail. Honor a future `Retry-After` value, but do not invent one for this case.

### Why not application retry?

OpenRouter can retry another provider before returning the response, which is
safer than resubmitting the request from the application. Application retry
would need a new attempt budget and special handling for uncertain submission;
the current architecture intentionally avoids automatic replay of a possibly
submitted timeout.

### Why exactly two providers?

Two removes the observed single-provider failure while keeping route fan-out,
price variance, and evaluation variance small. `only` also makes later audit
clear: the response came from one of two declared endpoint variants. If both
fail, the run remains visibly failed rather than expanding silently to the
entire marketplace.

## Small implementation slice

If the repository owner accepts this proposal:

1. Version the OpenRouter provider policy and include the proposed `order`,
   `only`, `allow_fallbacks`, and `max_price` values in the wire body.
2. Keep model fallback and application-level retries disabled.
3. Retain the actual returned provider in each stage's run record; this is
   already implemented.
4. Add unit tests proving the exact credential-free wire body and price/privacy
   constraints.
5. Run all offline gates.
6. Make exactly one paid smoke run against the existing tiny fixture. Stop if it
   reaches a valid final report, or if it fails for a new reason. Do not rerun
   reflexively.

The smoke succeeds when both mandatory stages complete, the final report passes
local validation, every route is inside the allowlist, and the recorded total
cost remains within the configured envelope. Review-quality evaluation remains
a separate later task.

## Unknowns and reassessment triggers

- OpenRouter did not return the failed attempt chain or a retry hint in the
  observed 429 bodies. Router metadata could improve diagnostics later, but it
  is not required to correct the immediate routing gap.
- Endpoint performance, ZDR status, capabilities, and prices can change.
  Reassess the allowlist when metadata no longer satisfies the policy.
- If a two-provider same-model request still returns 429, inspect the recorded
  provider/error metadata before considering a third endpoint or a model
  fallback.
- If cross-provider or cross-quantization output variance harms review quality,
  evaluate provider variants explicitly before changing the production policy.
- If real repository runs approach the token envelope, implement the
  dollar-reservation fields already required by ADR-003 rather than raising the
  key limit casually.

## Sources

[^provider-routing]: OpenRouter, [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection), including default fallback, `order`, `only`, parameter/data/ZDR filters, and `max_price` semantics. Accessed 2026-09-08.
[^limits]: OpenRouter, [Limits and handling 429 errors](https://openrouter.ai/docs/api_reference/limits). Accessed 2026-09-08.
[^zero-completion]: OpenRouter, [Zero Completion Insurance](https://openrouter.ai/docs/guides/features/zero-completion-insurance). Accessed 2026-09-08.
[^endpoints-api]: OpenRouter, [List all endpoints for a model](https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model), plus authenticated read-only metadata from [`/api/v1/models/openai/gpt-oss-20b/endpoints`](https://openrouter.ai/api/v1/models/openai/gpt-oss-20b/endpoints) and [`/api/v1/endpoints/zdr`](https://openrouter.ai/api/v1/endpoints/zdr). Accessed 2026-09-08.
[^provider-integration]: OpenRouter, [Provider Integration: uptime monitoring and performance metrics](https://openrouter.ai/docs/guides/community/for-providers). Accessed 2026-09-08.
[^model-fallbacks]: OpenRouter, [Model Fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks). Accessed 2026-09-08.
