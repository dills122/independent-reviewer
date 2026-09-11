# Review-unit library evaluation

Status: decision-ready after first live end-to-end review.
Decision owner: project maintainer.

## Executive conclusion

Keep report assembly, evidence identity, coverage, and verdict consistency in
small product-owned code. Those rules are specific to Independent Reviewer and
are already backed by frozen manifests and Zod contracts; a framework would
obscure rather than remove the important logic.

Adopt `fast-check@4.9.0` as a development dependency for coverage and evidence
invariant tests. Conditionally adopt `p-queue@9.3.3` when focused review-unit
fan-out lands, using it only for in-memory scheduling. Retain the current
OpenRouter transport: neither official SDK can preserve bounded raw-response
capture and OpenRouter-specific audit/error semantics while deleting enough
custom code. A later `@openrouter/sdk` spike may reuse request types only. Keep
`@ast-grep/napi@0.45.3` as optional later context enrichment, not citation proof
or report assembly.

Do not add XState, Temporal, BullMQ, LangChain, Vercel AI SDK, or an agent SDK
for this slice. They do not solve the observed failure and would duplicate the
durable run ledger or introduce a broader execution framework.

## Decision question

Which well-supported libraries can remove meaningful implementation work from
runner-owned review units while leaving agents responsible only for reviewing
code?

This matters now because the first live run proved that Git evidence and
provider transport work, while model-generated coverage bookkeeping and an
unsupported finding prevented a valid final report.

## Scope and stop condition

Evaluate libraries for runtime schema validation, deterministic invariant
testing, bounded review-unit scheduling, OpenRouter-compatible transport,
source context, and repeatable model evaluation. Do not install packages,
change runtime behavior, or make another paid provider call. Stop once each
credible option has an adopt, spike, defer, or reject disposition.

## Criteria

1. Agents return code judgments, evidence selections, and uncertainty only.
2. Runner owns frozen identity, ordering, coverage, attempts, cost, and report
   assembly.
3. Paid work remains budgeted, auditable, resumable, and conservatively failed.
4. Dependencies support Node.js 24, TypeScript 6, ESM, and exact pinning.
5. Adoption must delete meaningful commodity code or materially strengthen
   verification.
6. Repository and provider data remain untrusted input, never executable
   configuration.

## Evidence

- **Observation:** live final and repair candidates each emitted 46 coverage
  objects but only 31 unique paths. Local validation correctly rejected both.
- **Observation:** the model's only P1 was false even though the relevant diff
  contained both the dependency signature and correct routing extraction.
- **Inference:** deterministic coverage and citation identity are product
  contracts. Generic model or workflow frameworks cannot safely own them.
- **Observation:** repository already uses `zod@4.5.4` for runtime contracts and
  generated provider schemas.
- **Fact:** `fast-check@4.9.0` supports shrinking generated counterexamples,
  Node.js 24 CI, and TypeScript 6 in its current package tests.
- **Fact:** `p-queue@9.3.3` supports task IDs, concurrency, priorities,
  pause/drain, rate limits, abort signals, and lifecycle events on Node.js 20+.
  It is in-memory only.
- **Observation:** current filesystem concurrency helper is 27 lines and is
  adequate for packet capture. Paid review units need task identity, drain, and
  cancellation behavior that helper does not supply.
- **Fact:** OpenRouter documents `openai` as a supported drop-in SDK with a
  changed base URL. `openai@7.13.0` supports Node.js 22+, TypeScript 6 in its
  repository, explicit retry disabling, timeouts, custom fetch, typed errors,
  and raw success-response access.
- **Observation:** `openai` consumes non-success bodies before returning an
  error and does not bound them. OpenRouter routing, fallback, plugin, provider,
  and cost fields also remain untyped custom parameters.
- **Observation:** the prior exact `@openrouter/sdk@1.2.110` spike failed this
  repository's TypeScript 6 declaration gate and could not replace bounded raw
  response capture. The generated SDK continues to publish frequent patch
  releases, including breaking API changes.
- **Fact:** `@ast-grep/napi@0.45.3` parses supplied source strings, ships common
  platform binaries, and currently develops against TypeScript 6 and Node 24
  types. Official reference still calls Node API experimental.
- **Inference:** exact citation validation needs a digest-bound evidence map
  over frozen bytes. AST libraries can add enclosing declarations, but cannot
  prove that finding prose follows from cited code.

## Options and decisions

| Option | Useful ownership | Decision |
| --- | --- | --- |
| Existing `zod@4.5.4` | Parse narrow agent judgments and validate final product contracts. | Keep; no additional schema framework. |
| `fast-check@4.9.0` | Generate missing, duplicated, conflicting, reordered, and hostile coverage/evidence cases with minimized counterexamples. | Adopt as development dependency in next slice. |
| `p-queue@9.3.3` | In-memory scheduling, task IDs, priorities, pause/drain, and cooperative cancellation for paid review units. | Conditional adopt after review-unit ledger events are specified. Queue state and events are never durable authority. |
| `p-map@7.0.7` | Ordered bounded mapping with abort support. | Do not add alongside `p-queue`; retain current helper for filesystem batches. |
| `openai@7.13.0` | Commodity HTTP, timeout, error, retry, and response mechanics against OpenRouter's compatible endpoint. | Reject as transport replacement. Non-success body bounds and OpenRouter-specific policy still require custom transport logic. |
| `@openrouter/sdk` | OpenRouter-native generated request and response types. | Keep transport blocked. Later spike public request types/serialization only, after a clean TypeScript 6 compile. |
| Vercel AI SDK plus `@openrouter/ai-sdk-provider` | Cross-provider generation and structured-output helpers. | Defer/reject for runtime. It cannot enforce semantic Zod refinements and duplicates product retry, validation, and telemetry policy. |
| `@openrouter/agent` | Tool loops and multi-turn agent execution. | Reject. Reviewers should assess supplied code, not run an agent framework. Package is also beta. |
| `@ast-grep/napi@0.45.3` | Enclosing JS/TS declaration context from frozen strings. | Later fail-open spike; adopt only if review precision/recall improves on corpus. |
| XState | In-process state machines and persisted actor snapshots. | Reject now. Existing append-only ledger is audit authority; a second state model adds migration and replay concerns. |
| Temporal or BullMQ | Distributed durable jobs and retries. | Reject for local CLI. Adds service infrastructure and at-least-once/idempotency complexity. |
| Promptfoo | Model/prompt comparison and deterministic/model-graded assertions. | Optional evaluation harness only, with trusted local configuration and precomputed outputs. Never production runtime or untrusted repository configuration. |

## Required adapters and gates

### `fast-check`

- Generate arbitrary expected path sets and malformed agent result sets.
- Prove one canonical output entry per expected review unit.
- Prove unknown IDs reject and missing/conflicting results become `UNASSESSED`.
- Prove ordering is manifest-owned and independent of completion order.
- Store seed/path for every failure so CI can replay it.

### `p-queue`

- Assign stable unit IDs and input digests before enqueue.
- Persist `UNIT_PLANNED` before scheduling and `CALL_STARTED` only immediately
  before provider dispatch.
- Reserve worst-case cost for all in-flight units.
- Return explicit unit outcomes; do not fail coordination while paid work is
  still active.
- Serialize ledger writes and rebuild pending work from ledger on resume.
- Keep provider pacing, timeout, retry, and fallback outside queue.

### Optional `@openrouter/sdk` request-type spike

- Compile cleanly with repository TypeScript 6 settings and no `skipLibCheck`.
- Reproduce OpenRouter model fallback, provider routing, privacy, cache, and
  structured-output request fields.
- Compare SDK serialization with current golden wire fixtures.
- Do not use SDK dispatch, response parsing, or retries unless a future release
  supplies bounded raw-envelope access and preserves current diagnostics.

### `@ast-grep/napi`

- Parse only frozen packet strings; never traverse live checkout.
- Return enclosing declaration and exact source range for changed hunks.
- Fall back to line evidence on unsupported language, parse error, or native
  load failure.
- Prove deterministic output and platform support on Linux x64/arm64 and macOS.
- Adopt only after measured finding precision or recall improves.

## Source index

- [`p-queue` documentation](https://github.com/sindresorhus/p-queue) and
  [package metadata](https://raw.githubusercontent.com/sindresorhus/p-queue/main/package.json)
- [`p-map` documentation](https://github.com/sindresorhus/p-map) and
  [package metadata](https://raw.githubusercontent.com/sindresorhus/p-map/main/package.json)
- [`fast-check` documentation](https://fast-check.dev/docs/) and
  [package metadata](https://raw.githubusercontent.com/dubzzz/fast-check/main/packages/fast-check/package.json)
- [OpenRouter OpenAI SDK quickstart](https://openrouter.ai/docs/quickstart)
- [`openai` client configuration](https://github.com/openai/openai-node/blob/main/docs/configuration.md)
  and [package metadata](https://raw.githubusercontent.com/openai/openai-node/master/package.json)
- [OpenRouter TypeScript SDK](https://github.com/OpenRouterTeam/typescript-sdk)
  and [release history](https://github.com/OpenRouterTeam/typescript-sdk/releases)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [`@ast-grep/napi` API](https://ast-grep.github.io/reference/api),
  [usage guide](https://ast-grep.github.io/guide/api-usage/js-api), and
  [package metadata](https://raw.githubusercontent.com/ast-grep/ast-grep/main/crates/napi/package.json)
- [Promptfoo configuration reference](https://github.com/promptfoo/promptfoo/blob/main/site/docs/configuration/reference.md)
  and [security model](https://github.com/promptfoo/promptfoo/security)
- [Existing OpenRouter SDK compatibility spike](./2026-09-09-openrouter-sdk-compatibility-spike.md)

## Confidence and next gate

Confidence: high that no new runtime library is needed for runner-owned report
assembly; high for `fast-check` test value; medium for `p-queue` until paid-unit
semantics are implemented; high that current SDKs should not replace transport;
medium-low for measurable AST context gain.

Next gate: approve next implementation slice, then install exact `fast-check`
and implement product-owned review-unit/evidence-map contracts first. Add
`p-queue` only when concurrent provider dispatch exists. Run optional SDK-type
and AST spikes independently so neither can block report-assembly work.
