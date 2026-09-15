# Provider-chain failover checkpoint — 2026-09-15

## Trigger

Paid full-matrix run `full-v4-834e7a4-20260915-live` completed nine cases before
two consecutive cases failed delivery. In both failures, OpenRouter reported a
CoreWeave 429 in `previous_errors`, then a terminal DeepInfra 502. Local retry
excluded only DeepInfra, leaving CoreWeave as the sole pinned retry target; it
returned another 429. The run stopped before case 12 spent further calls.

This proves a retry-policy defect, not that either provider is generally
unusable: terminal-error-only exclusion can immediately revisit an endpoint
already failed inside the same OpenRouter routing chain.

## Current endpoint evidence

OpenRouter's official model Endpoints API and ZDR endpoint registry were read on
2026-09-15. Four active `openai/gpt-oss-120b` endpoints met the evaluation
policy's ZDR, strict structured-output, context, output, and low-price needs:

| Endpoint | Prompt / 1M | Completion / 1M | Structured output | ZDR registry |
| --- | ---: | ---: | --- | --- |
| `coreweave/fp4` | $0.030 | $0.170 | Yes | Yes |
| `deepinfra/bf16` | $0.037 | $0.170 | Yes | Yes |
| `akashml/bf16` | $0.030 | $0.170 | Yes | Yes |
| `dekallm/bf16` | $0.030 | $0.180 | Yes | Yes |

Endpoint capability, privacy eligibility, price, and reliability are mutable
provider metadata, not service guarantees. OpenRouter enforces the request's
`zdr`, `data_collection: "deny"`, `require_parameters`, and `max_price`
intersection at routing time.

Sources:

- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter gpt-oss-120b endpoints](https://openrouter.ai/api/v1/models/openai/gpt-oss-120b/endpoints)
- [OpenRouter ZDR endpoint registry](https://openrouter.ai/api/v1/endpoints/zdr)
- [OpenRouter errors and debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging)

## Change

- Provider policy V6 derives a case-insensitive failed-provider set from every
  bounded `previous_errors` entry, response metadata, and terminal diagnostic.
- Open routing sends every newly failed base slug through `provider.ignore`.
- Pinned routing removes every failed base slug from its configured order and
  refuses another retry when no permitted endpoint remains.
- Evaluation routing keeps the same model and privacy controls, preserves
  CoreWeave and DeepInfra as first choices, then adds AkashML and DekaLLM.
- Evaluation completion-price ceiling rises from `$0.17/M` to `$0.18/M`, the
  smallest increase that admits DekaLLM. Per-case `$0.02` and aggregate matrix
  admission remain unchanged.

No fallback reviewer model was added. Provider failover preserves model identity;
model fallback remains a separate quality decision.

## Provider-free verification

- OpenRouter adapter suite: 30 tests passed, including open and pinned
  multi-provider failure-chain regressions.
- Full dry evaluation matrix: 30/30 cases passed, zero provider calls, zero cost.
- Repository gate: 732 coverage tests and 35 provider-free CLI E2E tests passed;
  dependency audit reported zero vulnerabilities.
- Local AI-context check passed with 57 skills and expected compatibility links.
- Paid qualification of this revised route pool has not yet been performed.
