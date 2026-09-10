# Review model selection — 2026-09-10

## Decision

Qualify `akashml/bf16` first as the provider route for the supported
`openai/gpt-oss-120b` budget baseline. Qualify fixed `moonshotai/kimi-k2.5` next
as the value challenger with direct code-review benchmark evidence. Use fixed
`openai/gpt-5.2` and `anthropic/claude-opus-4.6` as premium quality controls.

Keep fixed `deepseek/deepseek-v4-flash-0731` and `z-ai/glm-5.3-flash` as
secondary value candidates. Treat fixed `openai/gpt-5.6-sol` and
`anthropic/claude-opus-4.8` as upgrade challengers, not assumed replacements:
the directly relevant benchmark predates them, and its own results show that a
newer model can review code worse than its predecessor.

AkashML route qualification does not promote GPT-OSS itself to preferred. No
provider or model is promoted by this research alone; promotion requires live
protocol evidence.

Do not use `:latest`, preview, batch, or automatic-router model aliases. Review
artifacts bind an explicit model identity, and the returned identity must match.

## Evidence and method

This review combined:

- OpenRouter's current model and endpoint catalogs, including structured-output,
  context, output-token, operational-status, price, and zero-data-retention
  metadata;
- OpenRouter benchmark API results from Artificial Analysis and Design Arena;
- Factory's code-review-specific benchmark over 50 real pull requests, with at
  least three runs per model and a human-curated defect set;
- provider-free local dry-run admission against the same compact one-file fixture,
  with 8,192 output tokens per call, 160,000 total tokens, both mandatory stages,
  and one shared retry; and
- existing repository live-validation evidence.

Benchmark scores screen candidates; they do not measure this product's exact
independent-review protocol. Factory also excluded runs in which a model
malfunctioned, so its quality ranking must not be treated as a reliability
ranking. Catalog status and short-window uptime do not prove endpoint reliability
under load. This research made metadata requests only and incurred no new
model-inference cost.

## Candidate tiers

| Tier | Model | Why | Current limitation |
| --- | --- | --- | --- |
| Provider focus 1 | `openai/gpt-oss-120b` on `akashml/bf16` | BF16, ZDR, structured output, full 131K context, lowest route price, strong current short-window uptime | Provider route is unqualified; model has weaker general coding signals and no Factory result |
| Model focus 1 | `moonshotai/kimi-k2.5` | 51.9% Factory review F1 at $0.41/PR, 262K context, several ZDR structured-output routes | Needs a materially higher local admission cap and pinned live qualification |
| Premium control 1 | `openai/gpt-5.2` | Best Factory result: 60.5% F1 with 65% precision and 57.6% recall | Only Azure is currently ZDR on OpenRouter; expensive under this protocol |
| Premium control 2 | `anthropic/claude-opus-4.6` | Second Factory result: 59.8% F1 with the highest top-model recall at 61.8% | Very expensive; ZDR routes concentrate on Bedrock and Vertex |
| Upgrade challenger | `openai/gpt-5.6-sol` | Current long-context coding model with structured outputs | Not in Factory review benchmark; ZDR currently limited to Azure routes |
| Upgrade challenger | `anthropic/claude-opus-4.8` | Current Opus-class long-context model with structured outputs | Not in Factory review benchmark; premium cost |
| Secondary value | `deepseek/deepseek-v4-flash-0731` | Strong general coding signal, 1.3M context, broad endpoint and ZDR diversity, fits current cost cap | No direct Factory review result; must pass pinned live protocol matrix |
| Secondary value | `z-ai/glm-5.3-flash` | Strong agentic and coding signals, 1.3M context, broad ZDR diversity | Factory measured GLM-5.1, not this model; exceeds current $0.02 cap |
| Supported, not preferred | `openai/gpt-oss-120b` on other routes | Cheap, protocol-compatible, many eligible endpoints | Lower coding scores and repeated live capacity, malformed-output, and whitespace failures |
| Experimental | `qwen/qwen3-coder-30b-a3b-instruct` | Cheap and fits current cap | Only two eligible endpoints and no exact current benchmark match |
| Experimental | `qwen/qwen3-coder` | Coding-specialized and 262K context | Pricier, limited endpoint diversity, weaker available arena signal |
| Experimental | `mistralai/codestral-2508` | Coding-specific and protocol-compatible | Two eligible endpoints from one provider organization and lower arena result |
| Premium reference | `google/gemini-3.8-flash` | Best shortlisted coding benchmark and strong arena result | Conservative reservation is about seven times current cap; ZDR route diversity is concentrated |
| Premium reference | `anthropic/claude-sonnet-5` | Strong coding and arena results | Conservative reservation is about nineteen times current cap; ZDR diversity is concentrated |

## Quality signals

Artificial Analysis coding scores available through OpenRouter placed Gemini 3.8
Flash at 76.3, GLM 5.3 at 74.8, GLM 5.3 Flash and Claude Sonnet 5 at 71.5,
DeepSeek V4 Flash 0731 at 69.1, and GPT-OSS 120B high at 30.4. GLM 5.3 Flash
also led the shortlisted agentic scores at 51.2.

Design Arena code results placed Gemini 3.8 Flash at 1321 ELO, Claude Sonnet 5
at 1293, DeepSeek V4 Flash 0731 at 1247, Qwen3 Coder at 1159, Codestral 2508
at 1023, and GPT-OSS 120B at 979. These datasets have different methods and
sample sizes, so ranking agreement matters more than isolated score precision.

Factory's more directly relevant code-review benchmark ranked GPT-5.2 first at
60.5% mean F1, Opus 4.6 second at 59.8%, GLM-5.1 fifth at 55.8%, and Kimi K2.5
eighth at 51.9%. GPT-5.2 cost $1.25 per Factory PR, Opus 4.6 $3.11, GLM-5.1
$1.06, and Kimi K2.5 $0.41. Those costs reflect Factory's 56K–4.2M-token
benchmark workload and pricing method, not this repository's admission formula.

The benchmark did not test GPT-5.6 Sol, Opus 4.8, DeepSeek V4 Flash, GLM 5.3
Flash, or GPT-OSS 120B. Claims that the newer GPT-5.6 Sol or Opus 4.8 is a better
reviewer are therefore hypotheses for our matrix, not benchmark conclusions.

## Cost admission

Conservative dry-run reservations for the compact fixture were:

| Model and candidate route | Reservation | Admission consequence |
| --- | ---: | --- |
| GPT-OSS 120B, current config | $0.006527 | Fits $0.02 |
| GPT-OSS 120B, AkashML BF16 | about $0.0061 projected | Fits $0.02 |
| DeepSeek V4 Flash 0731, Together + DeepInfra FP8 | $0.015769 | Fits $0.02 |
| Qwen3 Coder 30B, Novita + SiliconFlow | $0.011325 | Fits $0.02 |
| GLM 5.3 Flash, Fireworks + Modal | $0.021810 | Needs at least a separate $0.03 cap |
| Kimi K2.5, SiliconFlow + Phala | about $0.112 projected | Needs a separate $0.12 cap |
| GPT-5.2, Azure ZDR | about $0.455 projected | Needs a separate $0.46 cap |
| Claude Opus 4.6, Bedrock + Vertex ZDR | about $0.932 projected | Needs a separate $0.95 cap |
| Claude Opus 4.8, Bedrock + Vertex ZDR | about $0.932 projected | Needs a separate $0.95 cap |
| GPT-5.6 Sol, Azure ZDR routes | about $1.159 projected | Needs a separate $1.16 cap; no provider-org diversity |
| Gemini 3.8 Flash, Google Vertex | $0.139772 | Premium reference only |
| Claude Sonnet 5, Bedrock global | $0.372726 | Premium reference only |

Reservations are admission bounds, not provider charges. Projected rows apply the
same admitted prompt and completion-token quantities to current route ceilings;
they are not executed dry-runs. Larger repository scope can raise them, and every
live run must dry-run its actual scope first.

## Initial route candidates

Start with `openai/gpt-oss-120b` pinned to `akashml/bf16`. Current catalog
metadata reports BF16 quantization, ZDR, strict structured-output support,
131,072 context tokens, 117,964 maximum completion tokens, and $0.03/$0.17 per
million input/output tokens. The observed 30-minute uptime was about 99.97% when
queried, which is enough to justify a test—not a reliability claim.

For Kimi K2.5, start with pinned SiliconFlow and Phala endpoints. Both are ZDR,
support structured output, and represent different provider organizations. Use a
separate $0.12 qualification cap.

Test GPT-5.2 on Azure ZDR and Opus 4.6 on Bedrock plus Vertex only as explicitly
budgeted quality controls. Their direct review evidence makes them valuable
anchors even when they are unsuitable defaults.

Only after those anchors, test GPT-5.6 Sol on Azure ZDR and Opus 4.8 on Bedrock
plus Vertex. Compare each successor against its benchmarked predecessor on the
same frozen cases; do not infer improvement from release order.

For DeepSeek, start with pinned Together and DeepInfra FP8 endpoints. Both were
listed as ZDR and represent different provider organizations. A prior DeepInfra
failure on GPT-OSS does not establish DeepSeek endpoint behavior, but it does make
independent qualification mandatory.

For GLM, start with pinned Fireworks and Modal endpoints under a separate $0.03
test cap. Keep the cap change isolated to the qualification configuration.

Do not promote AkashML, GPT-OSS, or any other route without fresh evidence.

## Promotion gate

A candidate becomes preferred only after all of these checks:

1. Pin two ZDR endpoints independently. Run identical guarded final-stage probes
   in at least three spaced windows; record status, latency, usage, finish reason,
   maximum whitespace run, guard activation, and transport uncertainty.
2. Run the full two-stage clean, mandatory-change, exception, unsupported-author,
   and missing-context cases.
3. Run one larger multi-file clean case and one planted-defect case.
4. Achieve at least 9 of 10 complete, schema-valid final attempts across at least
   five labeled cases, with no transport-uncertain result, no credential
   reflection, expected verdicts, and no repeated unproductive stream.
5. Preserve failed attempts and unknown usage in the ledger. A retry cannot erase
   failure evidence, and a test cell cannot change prompt, schema, model, or
   endpoint after it starts.

The threshold is an engineering release gate, not a population-level reliability
estimate. Flaky models may remain supported, but documentation and examples must
label them non-preferred until they pass again.

## Sources

- [OpenRouter benchmark API](https://openrouter.ai/docs/api/api-reference/benchmarks/get-benchmarks)
- [Factory code-review benchmark](https://factory.com/news/code-review-benchmark)
- [OpenRouter zero-data-retention routing](https://openrouter.ai/docs/guides/features/zdr)
- [GPT-5.2](https://openrouter.ai/openai/gpt-5.2)
- [GPT-5.6 Sol](https://openrouter.ai/openai/gpt-5.6-sol)
- [Claude Opus 4.6](https://openrouter.ai/anthropic/claude-opus-4.6)
- [Claude Opus 4.8](https://openrouter.ai/anthropic/claude-opus-4.8)
- [Kimi K2.5](https://openrouter.ai/moonshotai/kimi-k2.5)
- [DeepSeek V4 Flash 0731](https://openrouter.ai/deepseek/deepseek-v4-flash-0731)
- [GLM 5.3 Flash](https://openrouter.ai/z-ai/glm-5.3-flash)
- [Qwen3 Coder 30B A3B Instruct](https://openrouter.ai/qwen/qwen3-coder-30b-a3b-instruct)
- [GPT-OSS 120B provider performance](https://openrouter.ai/openai/gpt-oss-120b/uptime)
- [Repository live-validation evidence](../validation/2026-09-10-whitespace-guard-e2e.md)
