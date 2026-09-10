# ADR-006: Route for availability, stop streaming, and retry per call

## Status

Accepted

## Date

2026-09-10

## Context

Live validation repeatedly failed to deliver a review while OpenRouter itself
was healthy. The recorded failure modes were a shared-pool 429 on a pinned
endpoint, a null completion with no usage, a 180-second uncertain transport, and
runaway constrained-decoding whitespace. Earlier work treated each as a separate
provider defect. Measured together they share one cause: the product removed
almost every recovery path OpenRouter provides, then observed that recovery did
not happen.

Four decisions compounded.

`openRouterWireBodyV4` sent `only: order` alongside `order`, and for the final
stage narrowed to `order.slice(0, 1)` with `allow_fallbacks: false`. The
catalog lists 22 endpoints for `openai/gpt-oss-120b`. The final call — the one
that produces the report — ran on exactly one of them with failover disabled, so
any single degraded endpoint failed the run. `zdr`, `data_collection: "deny"`,
`require_parameters` and a `max_price` ceiling set at the cheapest available tier
narrowed the pool further, and none of the three privacy filters was a stated
compliance requirement.

`ReviewRunConfigV2` carried one `model`. OpenRouter's `models` fallback array,
which covers rate limiting, downtime, context-length and moderation refusals, was
unused. A review does not care whether reviewer output came from the primary or a
configured alternate; it cares that a reviewer finished.

The final stage streamed. A review response is structured JSON with no
interactive consumer, so streaming bought nothing and cost a hand-written SSE
decoder, a JSON whitespace progress guard, partial-content diagnostics, and a
truncation-versus-invalid classification — four failure surfaces attached to a
call that could have been one request and one response.

Recovery was budgeted, not attempted. One retry existed per run across both
stages, and every failed attempt was charged `inputTokens + maxOutputTokens`
against the token reservation. A 429 that never reached a model was billed as a
complete review, which exhausted the reservation and produced
"The remaining token budget cannot reserve a provider retry." Retries died of
accounting rather than of provider behavior.

Measurement during this change confirmed the remaining question. Twelve
back-to-back one-token probes on this account returned 429
`temporarily rate-limited upstream` about 40 percent of the time under every
routing configuration, including fully open routing. The same probes spaced four
seconds apart returned 15 successes out of 15 across three models. The 429s were
an account-level burst limit, and `ProviderCallPacerV1` was constructed with
`minimumIntervalMs = 0`, so it imposed no spacing until after a 429 had already
been returned.

## Decision

Route for availability by default, and make every narrowing opt-in.

- `order` is a preference. `only` and `allow_fallbacks: false` are sent only when
  a run sets `providerRouting.pinToOrder`, which exists for diagnosis.
- `zdr` and `data_collection: "deny"` are sent only when a run sets
  `zeroDataRetention` or `denyDataCollection`. Both default to false.
- `max_price` stays on every request. It is not only a routing filter: the
  reservation and cost-ledger arithmetic assumes no endpoint bills above it, so
  removing it would make every cost reservation untrue. It is documented as a
  ceiling rather than a target, and example configs widen it accordingly.
- `require_parameters` stays. A provider that ignores `response_format` returns
  prose the report contract cannot accept.

Carry a model chain. `ReviewRunConfigV3` adds `fallbackModels`, sent as
OpenRouter's `models` array. A response is accepted from any model in the
permitted set, and the run record stores which model and endpoint answered.
Aliases and routers (`:latest`, `auto`) remain rejected, because a review artifact
binds an explicit model identity.

Stop streaming. Every call is `stream: false`.
`src/provider/openrouter-sse-decoder.ts` and
`src/provider/json-whitespace-progress.ts` are deleted along with the
`eventsource-parser` dependency and the `UNPRODUCTIVE_STREAM` error code.

Retry per call with a real budget. `budgets.maxAttemptsPerCall` (default 3)
replaces the single per-run retry, with exponential backoff over the existing
jittered delay. The budget belongs to each logical call rather than to the run,
so a preliminary retry cannot leave the final stage with nothing; the run-wide
token reservation and cost ledger still bound the total. `TRANSPORT_UNCERTAIN` becomes retryable in-process: an inference
call is idempotent for this product, and the uncertain attempt is still charged
the full conservative reservation before a retry is admitted, so a possible
double submission cannot be free. Resuming a transport-uncertain run from a
*later process* remains forbidden; that stance is unchanged.

Charge failed attempts for what they consumed. A `PROVIDER_ERROR` carrying no
usage never reached a model and is charged zero. Any other failure may have
generated output and keeps the full conservative reservation.

Pace calls. `budgets.minimumCallIntervalMs` (default 1500) is passed to a
per-run `ProviderCallPacerV1`, so workers sharing a model stay under the account
burst limit instead of discovering it.

Final-stage resume eligibility becomes structural rather than an exact literal
event sequence, because an in-run retry inserts extra events and a retried run is
exactly the kind of run resume exists for.

## Consequences

A default run may execute on any eligible endpoint and on a configured fallback
model. Route attribution therefore comes from the run record rather than from the
config, which is why `CALL_STARTED` now records preferred and excluded endpoints
and `requestedModels`, and `CALL_SUCCEEDED` continues to record the returned
model and provider.

`ReviewRunConfigV2` is removed rather than deprecated, and
`schemas/review-run-config-v2.schema.json` is replaced by the v3 artifact. The
package export moves with it. This is a pre-release breaking change.

Runs that previously failed on a pinned endpoint may now succeed on an endpoint
the operator did not name. An operator who needs the old behavior sets
`pinToOrder` and accepts that a single degraded endpoint fails the run.

Whitespace containment is gone with streaming. If constrained-decoding whitespace
recurs, it now presents as a truncated or malformed non-streaming response, which
the existing `INVALID_RESPONSE` path and the final-output repair call already
handle.
