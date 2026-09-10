# Whitespace generation diagnostic plan

## Objective

Identify a reproducible trigger or verified mitigation for final-stage whitespace
loops. Preserve the two-stage review contract. Research basis:
[structured-output whitespace report](../research/2026-09-09-structured-output-whitespace.md).

## Fixed inputs and limits

Use the reconstructed final request in
`.review-runs/whitespace-isolation-2026-09-09/final-request.json`, including the
original persisted preliminary assessment. Verify its original-route wire hash
against `96e0fb034e42f5cb927506d47680be3683244e5ee12300f8940ca73c47080c48`.
No fresh preliminary calls during isolation.

Keep GPT-OSS 120B, source evidence, author text, output allowance of 8,192 tokens,
180-second per-call timeout, price ceilings, and privacy controls fixed. Pin each
route so fallback cannot obscure the result. Do not change sampling or add
inter-call delays as experimental variables.

Maximum six submitted diagnostic calls, 160,000 conservatively reserved total
tokens, and $0.02 aggregate reserved cost for this new diagnostic batch, whichever
limit is reached first. Reserve every request before submission, including any
schema added to messages. Unknown usage consumes its reservation. No automatic
retries or repairs. Honor Retry-After before further affected calls; if unavailable
or too long to wait within the session, record the availability block. An HTTP
error does not count as evidence for or against a generation hypothesis, but
still consumes the call allowance.

## Step 1 — Make the probe dependable offline

Owner: local diagnostic harness, not production provider behavior.

- Use unique attempt directories and persist request identity before submission.
  Save raw response, route, finish reason, elapsed time, usage, and errors before
  running any analysis. Handle object JSON, string JSON, non-JSON error bodies,
  transport uncertainty, and missing usage. Do not overwrite prior attempts.
- Measure formatting whitespace outside JSON strings, longest consecutive run,
  total characters, and completion/reasoning tokens separately. Handle escaped
  quotes and backslashes; report character ratios as character ratios.
- Validate a successful response through the existing candidate materialization
  and final semantic/evidence checks using the frozen packet and preliminary.
  Provider JSON parsing alone is not a review pass. Disable any paid repair path.

Acceptance: offline replay of the saved length failure and a saved good final
preserves their distinct outcomes; mocked 429, non-JSON 502, and uncertain timeout
produce durable diagnostics without crashing. Local capture failure stops the
batch. Do not submit another live request until this passes.

## Step 2 — Compare providers with identical review content

Dependencies: Step 1. At most two calls, sequential.

| Test | Change from baseline | Question |
| --- | --- | --- |
| A | Pin CoreWeave/fp4 | Does the original final request still exhibit the symptom? |
| B | Pin DeepInfra/bf16 | Can the same requested model and review complete on another deployment? |

Compare semantic validity and whitespace metrics, not just finish_reason.
If A is poor and B is good, deployment sensitivity is a lead, not proof that
quantization or any specific decoder is the cause. If both are poor, shared
request/model behavior remains a lead. If both are good, the failure is
intermittent; preserve that result rather than claiming a fix. If a route is
unavailable, skip causal claims based on that route.

Checkpoint: record the two outcomes and choose one next variable. Initial live
pair requires at most six minutes of configured request wait, excluding any
explicit Retry-After wait. Stop early for uncertain transport or capture failure.

## Step 3 — Test the strongest remaining hypothesis

Dependencies: Step 2. Select one test, then inspect before using another slot.

### C — Schema visibility

On an available route that reproduced poor generation, append the exact final
response schema to a trusted message; keep response_format enforcement unchanged.
Recalculate admission. Change no formatting instructions or sampling settings.

Question: does making the contract explicitly visible improve completion and
content? Improvement supports schema/prompt sensitivity; it does not prove the
provider previously omitted the schema. A baseline on the same route is required.

### D — Decoder formatting control, only if documented for the endpoint

Verify whether the actual hosted endpoint exposes a supported whitespace bound
or compact-generation control. If available, compare with the original baseline
using that one control and unchanged messages/schema.

Do not send vLLM server settings as undocumented OpenRouter parameters. If no
control is available, mark this test unavailable. Preparing a support inquiry
is allowed; sending one requires explicit authorization.

### Alternative D — Reduced schema, if formatting control is unavailable

Reduce the response schema to the authorClaims object array with its existing
field constraints. Keep the original messages and sampling for this diagnostic.
This intentionally ceases to be a full review and must never produce a product
verdict. It tests whether the symptom survives much less schema structure.

A failure makes an authorClaims/local generation interaction worth reducing
further. Success alone does not prove which removed field mattered or justify
shipping a reduced report. Compare one reduction at a time, within batch bounds.

## Step 4 — Confirm one candidate, then decide

Dependencies: a candidate supported by Steps 2–3. Use remaining slots, up to two.

Replay the candidate against the exact exception request and a saved clean or
advisory request that previously showed excessive whitespace. Full reviews must
pass existing semantic/evidence checks and manual expected-outcome inspection.
Track longest formatting run and token use against saved baselines. A dramatic
reduction on two fixtures is preliminary mitigation evidence, not a statistical
reliability guarantee. Report all attempts, including unsuccessful controls.

- Confirmed candidate: propose the smallest production change with regression
  coverage and full application checks; do not bundle unrelated tuning.
- Provider availability prevents comparison: retain runnable reproduction and
  explicit missing comparison. Do not substitute repeated calls on another
  route and claim the unavailable route was tested.
- No candidate within bounds: produce a concrete support packet containing
  request/generation IDs, synthetic reproduction, expected behavior, response
  metrics, and questions about schema injection, decoder/version, formatting
  bounds, and cancellation. Do not claim root cause or silently expand testing.

## Separate product hardening

Streaming progress detection is a follow-on cost/time safeguard, not a causal
experiment or a way to complete a malformed review. Specify endpoint cancellation
and billing behavior before implementation. Preserve incomplete outcomes and
unknown cost. Keep this work separate from the initial diagnostic batch.

## Next action

Execute Step 1, then only the A/B provider pair. Choose further tests from their
actual results rather than running the entire matrix indiscriminately.
