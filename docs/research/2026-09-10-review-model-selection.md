# Review model selection — 2026-09-10

## Decision

Qualify fixed `deepseek/deepseek-v4-flash-0731` first and fixed
`z-ai/glm-5.3-flash` second. Keep `openai/gpt-oss-120b` supported for
compatibility and diagnosis, but do not describe it as preferred. No model is
promoted to preferred by this research alone; promotion requires live protocol
evidence.

Do not use `:latest`, preview, batch, or automatic-router model aliases. Review
artifacts bind an explicit model identity, and the returned identity must match.

## Evidence and method

This review combined:

- OpenRouter's current model and endpoint catalogs, including structured-output,
  context, output-token, operational-status, price, and zero-data-retention
  metadata;
- OpenRouter benchmark API results from Artificial Analysis and Design Arena;
- provider-free local dry-run admission against the same compact one-file fixture,
  with 8,192 output tokens per call, 160,000 total tokens, both mandatory stages,
  and one shared retry; and
- existing repository live-validation evidence.

Benchmark scores screen candidates; they do not measure this product's
independent-review accuracy. Catalog status also does not prove endpoint
reliability under load. This research made metadata requests only and incurred no
new model-inference cost.

## Candidate tiers

| Tier | Model | Why | Current limitation |
| --- | --- | --- | --- |
| Qualification focus 1 | `deepseek/deepseek-v4-flash-0731` | Strong coding signal, 1.3M context, broad endpoint and ZDR diversity, fits current cost cap | Must pass pinned live protocol matrix |
| Qualification focus 2 | `z-ai/glm-5.3-flash` | Strongest shortlisted agentic score, strong coding signal, 1.3M context, broad ZDR diversity | Conservative reservation exceeds current $0.02 cap |
| Supported, not preferred | `openai/gpt-oss-120b` | Cheap, protocol-compatible, many eligible endpoints | Lower coding scores and repeated live capacity, malformed-output, and whitespace failures |
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

## Cost admission

Conservative dry-run reservations for the compact fixture were:

| Model and candidate route | Reservation | Admission consequence |
| --- | ---: | --- |
| GPT-OSS 120B, current config | $0.006527 | Fits $0.02 |
| DeepSeek V4 Flash 0731, Together + DeepInfra FP8 | $0.015769 | Fits $0.02 |
| Qwen3 Coder 30B, Novita + SiliconFlow | $0.011325 | Fits $0.02 |
| GLM 5.3 Flash, Fireworks + Modal | $0.021810 | Needs at least a separate $0.03 cap |
| Gemini 3.8 Flash, Google Vertex | $0.139772 | Premium reference only |
| Claude Sonnet 5, Bedrock global | $0.372726 | Premium reference only |

Reservations are admission bounds, not provider charges. Larger repository scope
can raise them, and every live run must dry-run its actual scope first.

## Initial route candidates

For DeepSeek, start with pinned Together and DeepInfra FP8 endpoints. Both were
listed as ZDR and represent different provider organizations. A prior DeepInfra
failure on GPT-OSS does not establish DeepSeek endpoint behavior, but it does make
independent qualification mandatory.

For GLM, start with pinned Fireworks and Modal endpoints under a separate $0.03
test cap. Keep the cap change isolated to the qualification configuration.

If GPT-OSS remains in periodic compatibility testing, qualify AkashML BF16 before
reconsidering CoreWeave. Do not promote any GPT-OSS route without fresh evidence.

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
- [OpenRouter zero-data-retention routing](https://openrouter.ai/docs/guides/features/zdr)
- [DeepSeek V4 Flash 0731](https://openrouter.ai/deepseek/deepseek-v4-flash-0731)
- [GLM 5.3 Flash](https://openrouter.ai/z-ai/glm-5.3-flash)
- [Qwen3 Coder 30B A3B Instruct](https://openrouter.ai/qwen/qwen3-coder-30b-a3b-instruct)
- [GPT-OSS 120B provider performance](https://openrouter.ai/openai/gpt-oss-120b/uptime)
- [Repository live-validation evidence](../validation/2026-09-10-whitespace-guard-e2e.md)
