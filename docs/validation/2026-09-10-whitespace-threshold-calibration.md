# Formatting-whitespace threshold calibration — 2026-09-10

Status: local retained-corpus calibration; no provider calls.

## Method

Enumerated 191 private `provider-response-attempt-*.raw.json` artifacts without
printing paths or content. Of these, 160 contained string completion content.
The measurement selected responses with `finish_reason: stop` whose completion
content passed `JSON.parse`, then counted the longest consecutive JSON formatting
run (`SP`, `HT`, `LF`, or `CR`) outside quoted strings while honoring escapes.

This is syntactic calibration, not proof of semantic report acceptance. The
private retained corpus is operational evidence, not a balanced or statistically
independent provider sample; duplicate requests and selected diagnostic batches
may be present.

## Results

- Parseable stopped completions: 156.
- Longest-run p50: 11 characters.
- Longest-run p90: 14 characters.
- Longest-run p95: 80 characters.
- Ten largest runs: 26, 60, 80, 190, 216, 630, 4,282, 7,529, 12,144,
  and 12,144 characters.
- Runs at or above 512: 5 of 156.

The observed corpus has a gap between 216 and 630 characters. A 512-character
guard sits inside that gap. It leaves 151 parseable stopped responses below the
threshold and deliberately interrupts five heavily formatted responses that
eventually became parseable. Those five are not described as healthy merely
because they completed; the guard trades their eventual success for bounded
latency and a different-endpoint retry.

## Decision and limits

Retain 512 as provider policy v4's initial threshold. The guard applies only to
consecutive formatting whitespace outside strings; it does not use global
whitespace percentage. A trip remains an incomplete, retryable provider attempt
and never becomes a report. Unknown usage retains full conservative reservation.

Recalibrate when the model, structured-output protocol, threshold, or endpoint
set changes materially. Do not infer upstream decoder root cause, population
failure rate, or guaranteed billing savings from this corpus.
