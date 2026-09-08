# ADR-003: Use a versioned and budgeted model-call protocol

## Status

Accepted

## Date

2026-09-07

## Context

The external reviewer needs enough repository evidence to make a credible
engineering judgment, but OpenRouter calls are metered and model behavior is
nondeterministic. Every additional evidence, verification, repair, or author
turn can repeat accumulated conversation context and increase cost.

The core review property also depends on sequencing: neutral evidence must be
reviewed before author rationale is exposed. Provider conveniences cannot be
allowed to compress away required evidence, replay an old answer, change the
reviewer silently, or retry an uncertain request without an auditable budget
decision.

The supporting
[prompt, call, and token-efficiency research spike](../research/2026-09-07-prompt-call-and-token-efficiency-spike.md)
evaluated prompt structure, API shape, progressive evidence, caching, routing,
accounting, retries, malformed output, and minimal evaluation practices.
The later
[provider failover and cost-control spike](../research/2026-09-08-openrouter-provider-failover-and-cost-spike.md)
used live smoke ledgers to refine the same-model routing and final-stage retry
policy.

## Decision

### Own orchestration locally

The application owns messages, stage transitions, tool dispatch, persistence,
budgets, validation, and retries. Use the thin OpenRouter client rather than a
provider-managed agent loop.[^openrouter-client]

The initial adapter uses non-streaming Chat Completions. OpenRouter's TypeScript
Responses surface is currently beta, while this batch-oriented CLI gains no
product benefit from streamed partial output.[^openrouter-responses]

### Use small versioned stage prompts

Keep a stable trusted policy message first and append dynamic, explicitly
untrusted stage evidence afterward. The policy states the outcome, success
criteria, trust and permission boundaries, verdict constraints, efficiency
guidance, and stop rules. Tool definitions and output schemas are supplied
through their API-native fields instead of being duplicated in prose.[^openai-prompting]

Use separate strict response schemas for preliminary assessment, author
ask-back, and final report. Validate every provider result locally even when the
provider reports schema-constrained output.[^openrouter-structured]

The preliminary response includes the request to receive the author packet.
After it is validated and persisted, the orchestrator sends the already-held
author packet without paying for an otherwise empty request turn.

### Use progressive, bounded evidence

Send the complete changed-path manifest and the most useful changed hunks in the
blind brief. Keep the complete snapshot local and let the reviewer request
additional bounded evidence. Batch independent evidence requests into one model
continuation and return compact, digest-addressed results with explicit clipping
and continuation markers.

Do not rely on provider context compression. OpenRouter's transform can remove
or truncate messages from the middle, so it is explicitly disabled.[^openrouter-compression]

### Reserve and reconcile metered usage

Before each call, conservatively reserve its maximum output/reasoning cost and
any request charge. Before optional work, also reserve capacity for a valid
final non-ready report or an `Unable to verify` limitation result. Unknown usage
remains reserved rather than being treated as zero.

Record exact wire bytes, estimated tokens, provider-reported prompt/completion/
reasoning/cache tokens, and estimated/reserved/actual dollars as distinct
quantities. OpenRouter reports actual usage and cost, while tokenization differs
by model.[^openrouter-usage]

Use a dedicated API key with an appropriate provider-side spending limit as an
independent backstop. Numerical per-stage and per-run defaults are selected only
after a representative-change evaluation.

### Make routing and caching explicit

Use one explicit model and a small configured provider allowlist, require
requested parameters, enable provider fallback only within that allowlist, cap
eligible provider prices, and record the actual route. Model fallback remains
disabled: every stage and retry in one review instance uses the same requested
model.[^openrouter-routing][^openrouter-metadata]

Response caching remains disabled for live reviews because it stores and
replays a complete answer and is unavailable with account-level ZDR.[^openrouter-response-cache]
Prompt caching may be enabled later if the privacy policy permits it and
measured savings justify its sticky-routing effects; correctness never depends
on a cache hit.[^openrouter-prompt-cache]

### Fail visibly and retry conservatively

The orchestrator, not an opaque SDK default, owns retry count, delay, cost
reservation, and audit records. It inspects typed errors, response bodies, and
finish reasons because an error can arrive inside HTTP `200` after processing
has begun.[^openrouter-errors]

OpenRouter may fail over a clear provider rejection inside the same request. If
all allowed providers return a definite final-stage HTTP 429, an operator may
explicitly resume that final stage once from the persisted preliminary result
and identical run configuration. The blind stage is not repeated. A timeout or
connection loss after possible submission enters `TRANSPORT_UNCERTAIN` and is
never resumed automatically. Invalid complete model output is preserved and
may receive at most one separately designed budgeted repair request with exact
validation errors. Truncation, refusal, exhausted budget, or unresolved invalid
output cannot become `Ready`.

### Tune empirically

Choose the default model, reasoning effort, prompt revision, and numerical
budgets using the smallest task-specific evaluation that covers known defects,
clean changes, misleading author claims, missing scope, oversized context,
prompt injection, and transport/output failures. Change one variable at a time
and ship the lowest-cost configuration that meets recorded quality thresholds.
Prompt engineering remains an empirical loop, not a one-time prose exercise.[^openai-evals][^anthropic-evals]

## Alternatives considered

### One request containing all evidence and author rationale

This minimizes protocol turns but breaks the blind assessment and scales poorly
for large changes.

### Retrieval-only initial context

This makes the first request small but spends avoidable turns discovering the
basic shape of every change. The chosen hybrid sends the manifest and useful
changed hunks first.

### Streaming responses

Streaming improves perceived latency for an interactive UI but complicates
partial-output persistence and error handling without improving this batch CLI's
review result.

### Provider-managed state, compression, caching, or automatic fallback

These features can improve convenience, availability, or cost, but they obscure
or alter inputs, outputs, routing, and replay behavior at boundaries the product
must audit. They remain explicit future options, not initial defaults.

### Unlimited retry or repair loops

These may eventually produce syntactically valid output, but can duplicate
spend, shop for a favorable verdict, and hide provider instability.

## Consequences

- Prompt templates, tool schemas, and response schemas require versions and
  content hashes in every run record.
- The provider adapter needs explicit call, finish, error, usage, and route
  normalization rather than a single “completion text” method.
- The budget ledger reserves future mandatory work before optional calls.
- Conversation growth, evidence bytes, attempts, and repair calls become tested
  contract dimensions.
- The CLI may stop with `TRANSPORT_UNCERTAIN`, `FAILED`, or `Unable to verify`
  even when an automatic retry or fallback might have produced an answer.
- Prompt caching remains a measurable optimization; response caching and silent
  context compression are not part of live-review correctness.
- A small evaluation gate is required before selecting the default model and
  numerical budgets, but an exhaustive benchmark is not required for the first
  usable release.

[^openrouter-client]: OpenRouter, [Client SDKs](https://openrouter.ai/docs/client-sdks/overview).
[^openrouter-responses]: OpenRouter, [TypeScript Responses SDK reference](https://openrouter.ai/docs/client-sdks/typescript/api-reference/responses).
[^openai-prompting]: OpenAI, [model and prompting guidance](https://developers.openai.com/api/docs/guides/latest-model).
[^openrouter-structured]: OpenRouter, [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
[^openrouter-compression]: OpenRouter, [Message Transforms](https://openrouter.ai/docs/guides/features/message-transforms).
[^openrouter-usage]: OpenRouter, [Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting) and [Models metadata](https://openrouter.ai/docs/guides/overview/models).
[^openrouter-routing]: OpenRouter, [Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection).
[^openrouter-metadata]: OpenRouter, [Router Metadata](https://openrouter.ai/docs/guides/features/router-metadata).
[^openrouter-response-cache]: OpenRouter, [Response Caching](https://openrouter.ai/docs/guides/features/response-caching).
[^openrouter-prompt-cache]: OpenRouter, [Prompt Caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).
[^openrouter-errors]: OpenRouter, [Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging).
[^openai-evals]: OpenAI, [Evaluation Best Practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
[^anthropic-evals]: Anthropic, [Define Success Criteria and Build Evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests).
