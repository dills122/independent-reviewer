# OpenRouter TypeScript SDK migration plan

## Status and scope

Offline compatibility spike for replacing the hand-written HTTP invocation in
`src/provider/openrouter.ts` with the official `@openrouter/sdk`. Preserve the
`ReviewProviderV1` boundary and all product policy. Do not make a paid provider
call, add `@openrouter/agent`, or combine streaming/progress-guard work with the
transport migration.

## Current ownership inventory

The adapter currently owns:

- exact Chat Completions request serialization, bearer authentication, endpoint,
  and public headers;
- strict structured-output request fields; provider allowlist/order/fallback,
  price, required-parameter, data-collection, and ZDR controls; disabled context
  compression and response caching;
- request timeout spanning headers and body consumption, with post-submission
  failures classified as `TRANSPORT_UNCERTAIN`;
- an 8 MiB response-body ceiling, JSON decoding, typed-error detection in HTTP
  200 responses, non-JSON HTTP failure handling, and credential-redacted raw
  response evidence;
- bounded error diagnostics, response metadata, conservative usage normalization,
  finish/model/content checks, structured JSON parsing, and credential-reflection
  rejection;
- credential-free deterministic request/body digests and policy versioning;
- shared per-model pacing, retry deferral, and allowed-provider reordering for an
  orchestrator-owned retry.

## Boundary decision

SDK replaces endpoint construction, authentication/header plumbing, request
dispatch, and OpenAPI request/response typing. Product retains request-policy
construction, audit serialization, timeout classification, bounded evidence
capture, credential handling, response validation/normalization, pacing, and
retry policy.

SDK automatic retries must be explicitly disabled. Orchestrator remains sole
retry owner so attempt counts, cost reservations, durable events, and uncertain
submission handling stay accurate. SDK debug logging remains disabled because it
can expose authorization headers.

SDK request construction is not itself audit identity. Adapter will continue to
create one credential-free canonical wire-body representation before dispatch;
tests must prove SDK transport receives semantically identical fields and that
the digest changes only when audited request policy changes.

## Spike sequence

1. Pin one exact `@openrouter/sdk` release and inspect installed declarations,
   generated transport, retry defaults, error types, fetch injection, hooks, and
   streaming interfaces. Record any mismatch with current needs.
2. Add deterministic mock-transport tests before changing production behavior.
   Capture URL, headers, body, retry count, abort signal behavior, successful raw
   envelope, JSON and non-JSON errors, typed HTTP-200 errors, and oversized/body-
   phase failures.
3. Introduce the smallest SDK-backed dispatch seam behind `OpenRouterProviderV1`.
   Keep existing validation and evidence functions until parity is proven. Update
   provider-policy version only if serialized wire identity changes.
4. Run focused provider tests, full `npm run check`, and repository-context check.
   Document declaration/API gaps and whether the spike should ship, be revised,
   or be abandoned.

## Acceptance criteria

- `@openrouter/sdk` and transitive lock data are exact-pinned; no deprecation
  warnings exist in used SDK declarations or runtime paths.
- No provider call can be retried inside SDK. Existing orchestrator retry and
  `forRetry` behavior remains unchanged.
- `ReviewProviderV1`, CLI construction, and orchestrator call sites do not change.
- Captured SDK request preserves model/messages, output limit, strict JSON Schema,
  full provider routing/privacy/price policy, disabled context compression, and
  disabled response caching.
- Request audit remains deterministic, credential-free, and bound to dispatched
  semantics. Tests detect any request/audit drift.
- Success, malformed envelope/content, wrong model, abnormal finish, embedded
  provider error, non-JSON HTTP error, network/body timeout, oversize response,
  usage, raw evidence, and credential-redaction behavior match current contracts.
- Mock transport proves exact SDK request count and makes no network access.
- Full application and repository-context checks pass.

## Separate streaming/progress-guard decision

SDK streaming may expose deltas early enough to detect whitespace-only progress,
but adoption alone does not fix runaway whitespace. That failure occurs in
upstream provider constrained decoding. A later decision must prove that an
abort guard can bound bytes/time without misclassifying valid leading whitespace,
losing final usage/routing metadata, hiding raw SSE evidence, or implying known
cost after cancellation. Until then, production stays non-streaming and a
cancelled streamed request would remain cost-uncertain.
