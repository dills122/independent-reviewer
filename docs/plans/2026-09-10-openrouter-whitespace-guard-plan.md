# OpenRouter whitespace progress guard

Status: SUPERSEDED on 2026-09-10 by [ADR-006](../decisions/006-route-for-availability-not-pinning.md).
The guard, the streaming final stage, and the SSE decoder it depended on are removed: a review
response has no interactive consumer, so streaming was pure failure surface. Retained for the
threshold-calibration evidence and for the record of what was tried.

Original status: implemented after independent review instance 1 of 3; healthy-path paid provider
validation complete. Different-endpoint final retry was observed after live provider
errors; a live whitespace-guard trip was not observed.

## Objective

Contain intermittent strict-JSON generations that spend their output allowance
on formatting whitespace. Preserve the two-stage review, semantic validation,
bounded retry, private failure evidence, and conservative cost accounting. This
change does not claim to fix or identify the upstream decoder defect.

## Decisions

- Stream final-stage calls only. Preliminary calls retain existing non-streaming
  multi-endpoint routing.
- Pin every final attempt to exactly one configured endpoint with OpenRouter
  fallback disabled. A retry pins the next different configured endpoint.
- Abort after 512 consecutive JSON formatting characters (`SP`, `HT`, `LF`, or
  `CR`) outside strings. A stateful scanner carries quote and escape state across
  deltas. Retained-corpus calibration found a gap between 216 and 630 characters;
  151 of 156 stopped parseable responses remained below 512. See
  [`2026-09-10-whitespace-threshold-calibration.md`](../validation/2026-09-10-whitespace-threshold-calibration.md).
- Record guard abort as retryable `UNPRODUCTIVE_STREAM`. Preserve a bounded,
  credential-screened SSE transcript and partial-content metrics in the existing
  private failed-attempt artifact. This is durable after terminal handling, not
  crash-durable and not byte-exact after redaction. `CALL_STARTED` remains the
  evidence for a process interrupted in flight.
- Unknown usage retains the existing full conservative reservation. Cancellation
  is not represented as proof that upstream generation or billing stopped.
- Defer automatic circuit breaking. Requested endpoint and guard diagnostics are
  observable in the attempt ledger; persistent quarantine needs a separate state
  contract and owner decision.
- Bump the OpenRouter provider-policy identity because final wire format and
  routing semantics change. Rollback is a code/config release rollback to the
  existing failure-visible non-streaming policy; no per-run toggle is introduced.

## Implementation order

1. Replace the decoder's shifting queue with cursor-based draining and add a
   many-events regression.
2. Add a stateful JSON formatting-whitespace scanner with chunk-boundary,
   string, escape, and threshold tests.
3. Add final-stage streaming envelope normalization, usage/finish metadata,
   bounded credential-screened transcript capture, and stable error mapping.
4. Record the requested endpoint before submission. Pin final attempts and make
   `forRetry` exclude the first attempted endpoint.
5. Exercise guard abort persistence, unknown usage reservation, alternate final
   retry, no same-endpoint retry, and preservation of the preliminary stage.
6. Run focused tests, `npm run check`, CI repository-context verification, and
   `git diff --check`. Paid validation requires separate authorization.

## Acceptance

- Healthy streamed final content follows existing JSON and semantic validation.
- Formatting whitespace inside strings never trips the guard.
- The 511/512 boundary is deterministic across arbitrary SSE chunking.
- Guard abort cancels locally, persists a private diagnostic, remains incomplete,
  and consumes conservative unknown usage.
- With two endpoints and an unused global retry, retry uses a different pinned
  endpoint without repeating the preliminary assessment.
- With one endpoint or an already-used retry, failure remains visible.
- No credential bytes appear in errors, metadata, ledger, or response artifacts.
- Existing non-streaming preliminary and provider-error behavior remains covered.

## Explicit exclusions

- Provider root-cause claims, prompt/schema tuning, response healing, higher
  output caps, JSON salvage, persistent circuit breaking, and support contact.
- Guaranteed billing cancellation.
- A second retry or a separate final-stage retry budget.
