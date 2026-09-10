# Streaming decoder selection plan

## Objective

Select a maintained SSE decoder for an eventual OpenRouter streaming progress
guard. Do not replace `ReviewProviderV1`, alter request policy, or claim decoder
choice fixes upstream constrained-generation whitespace.

## Candidates

- `@openrouter/sdk`: official complete client and working runtime stream decoder,
  but current declarations fail project TypeScript 6/Node 24 gates and its result
  parsing drops product-required raw provider extensions.
- OpenAI TypeScript SDK: officially supported against OpenRouter's compatible
  endpoint and mature streaming support, but requires a complete client/request
  migration to obtain a decoder and types do not own OpenRouter extensions.
- Vercel AI SDK with OpenRouter provider: official OpenRouter integration and
  strong application-level streaming, but adds orchestration abstractions not
  needed by this CLI transport boundary.
- `eventsource-parser`: focused, maintained WHATWG SSE parser with no model-client
  policy, transport, retry, or response-shape ownership.

## Provisional choice

Spike exact-pinned `eventsource-parser@4.1.0`. It has the smallest ownership
overlap: existing fetch, headers, abort signal, byte accounting, raw evidence,
OpenRouter event validation, usage normalization, pacing, and orchestrator retry
policy remain local. Library owns only UTF-8 chunk-to-SSE-event framing.

## Offline acceptance criteria

- Compiles directly under TypeScript 6.0.3 and Node 24.13.3 without declaration
  shims or `skipLibCheck`.
- Correctly handles CRLF/LF framing, UTF-8 code points split across byte chunks,
  multi-line `data`, comments, and `[DONE]`.
- Enforces a finite parser buffer before unbounded line/event accumulation.
- Surfaces malformed SSE through a stable local error mapping.
- Allows caller-owned incremental raw-byte capture and cancellation.
- Makes no network call and adds no automatic retries, request mutation, logging,
  credential handling, or model abstractions.

## Production follow-up gate

Do not switch production to streaming in this spike. A separate change must
define JSON-aware non-progress thresholds from saved good outputs, preserve raw
SSE under a total byte cap, distinguish parser/progress abort from transport
uncertainty, retain incomplete evidence, and record usage/cost as unknown when
final accounting is absent. Endpoint-specific cancellation support prevents any
general promise that client abort stops billing.
