# Remaining standards cases — 2026-09-09

Two previously incomplete cases ran once through standards policy v4 using the
existing GPT-OSS 120B CoreWeave/DeepInfra configuration: 8,192 output tokens,
160,000 total-token reservation limit and $0.02 ceiling per run. No runtime
changes, hidden reruns, or broader batch.

| Case | Result | Calls | Retry / repair | Seconds | Reported cost |
| --- | --- | --- | --- | --- | --- |
| Mandatory violation | NOT_READY, one correct REQUIRED naming finding | 3 | 1 / 0 | 59.5 | $0.00053746 plus one unknown-cost call |
| Permitted exception | Correct preliminary, no final report: output limit | 2 | 0 / 0 | 209.2 | $0.00166153 |

Mandatory finding cites the frozen BASE/HEAD name change and proposes a descriptive
name. The first final call received DeepInfra 502, with prior CoreWeave 429 in
diagnostics. One bounded final-only retry succeeded without repeating the blind
assessment. This case now has a complete expected result.

The exception preliminary explicitly recognized the adjacent @publicApiStable
annotation as satisfying the selected exception, with no findings. Final call
returned CoreWeave finish_reason=length at 8,192 completion tokens. This was a
completed error response with reported usage, not a transport-uncertain timeout.
No final report was fabricated and the failed generation was not replayed.

## Concrete new failure evidence

Saved final content is 31,081 characters, of which 30,127 (about 97%) are
whitespace. It begins a malformed JSON object around authorClaims, then emits
large whitespace sequences instead of completing the report. This is observed
runaway output, not evidence that a valid review needs a larger output budget.
Underlying cause (model behavior versus constrained-decoding/provider behavior)
is not yet established.

Do not raise the output cap again as a presumed fix or trim/salvage this partial
response into a passing report. Next narrow investigation should inspect the
authorClaims schema/request and malformed generation, verify exact endpoint
behavior, and test a bounded correction. Streaming abort or a different generation
protocol would be separate implementation work, not silently introduced here.

Combined reported cost: $0.00219899 plus one unknown-cost call, within the $0.04
combined reservation. Mandatory passes; permitted exception remains incomplete.
Prior matching preliminary judgments do not establish final-stage success.

Private runner and artifacts: `.review-runs/standards-remaining-2026-09-09/`.
Documentation-only update; runtime remains at the previously verified 213 tests.
Repository-context and whitespace checks pass for this evidence update.
