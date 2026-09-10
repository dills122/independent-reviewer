# AkashML qualification — 2026-09-10

Status: supported route; failed preferred qualification.

## Scope and admission

The planned matrix contained one clean rename and one planted mandatory naming
violation. Both were synthetic one-file TypeScript repositories with
human-labeled expected verdicts. Each used `openai/gpt-oss-120b`, pinned only to
`akashml/bf16`, with 8,192 output tokens per call, 160,000 total tokens, a
180-second timeout, and a $0.02 per-run ceiling.

Provider-free dry-runs passed:

- clean: 88,485 reserved tokens and $0.006095 reserved cost;
- mandatory defect: 88,443 reserved tokens and $0.006094 reserved cost.

Reservations are not confirmed charges.

## Live result

The clean run did not complete:

1. Preliminary attempt 1 succeeded through AkashML in about 16.1 seconds. It
   reported 1,995 prompt tokens, 726 completion tokens, 2,721 total tokens, and
   $0.00018327 cost. The preliminary assessment was persisted before author input.
2. Final attempt 2, pinned to `akashml/bf16`, returned HTTP 429 with provider code
   `queue_timeout` and limit source `upstream_provider_shared_pool`. Usage and
   cost were absent and remain unknown.
3. The one permitted final-only retry preserved the preliminary assessment and
   submitted attempt 3 to the same pinned endpoint. It received one empty
   assistant SSE chunk followed by `[DONE]`, with no finish reason, no usage, and
   no cost. The adapter rejected it as `INVALID_RESPONSE`.

The retry transcript contained zero content characters and zero formatting
whitespace. This result does not reproduce the runaway-whitespace problem and
does not implicate SSE framing: the decoder received complete event boundaries
and `[DONE]`, while the provider supplied no valid terminal completion state.

The mandatory-defect case was not submitted after the clean route failed twice.
An exact-byte audit after the retry found zero OpenRouter credential matches
across 82 private fixture and artifact files.

## Decision

Keep AkashML/GPT-OSS available as a supported compatibility route, but do not
mark it preferred or spend the remaining qualification matrix on it now. Move
the next value-model qualification to Kimi K2.5. Revisit AkashML only in a later
spaced window; short catalog uptime did not predict final-stage protocol success.
