# First-final concern scope and route assessment — 2026-09-09

Checkpoint `2e18573` committed all preceding output, recovery, pacing, and
validation work. Follow-up scope: prevent invented empty concern references on
the first final call and assess another GPT-OSS 120B endpoint.

## Changes and checks

The first final-call schema now narrows preliminary-concern count and kind from
the persisted assessment. Zero concerns means maxItems=0. This previously only
happened during a paid repair call. Local semantic checks remain authoritative.
The specialization only shrinks the existing schema, preserving its initial
token reservation. A direct replay checked empty scope, each single concern kind,
and non-increasing serialized schema size. Prompt version is v11.

Cost admission now prices known reserved input and output quantities separately
and includes a request fee for every reserved call. Previously every reserved
token was priced at the output rate, unnecessarily rejecting higher-output-price
providers even when their conservative prompt/output total fit the same cap.
All 193 existing tests pass through npm run check.

## Provider assessment

[OpenRouter's endpoint listing](https://openrouter.ai/api/v1/models/openai/gpt-oss-120b/endpoints)
advertised structured outputs for AkashML and BaseTen. AkashML fit the previous
price ceiling but all three fixtures failed with repeated 429s, six calls total.
Published aggregate uptime did not predict our route's availability.

BaseTen advertised $0.10 per million input tokens and $0.50 per million output
tokens. Initial admission rejected both fixtures before any paid call because
of the over-conservative pricing described above. After correcting that split,
all four completed under the unchanged $0.02 per-review ceiling and privacy
controls. Endpoint was pinned to baseten/fp4 with no fallback.

| Fixture | Seconds | Calls | Retries / repairs | Reported cost | Quality |
| --- | --- | --- | --- | --- | --- |
| Mistaken author concern | 17.0 | 2 | 0 / 0 | $0.0021574 | READY, no findings; expected |
| Cross-file conversion | 24.9 | 2 | 0 / 0 | $0.0029928 | Real 100× bug found, plus rounding false positive |
| Two boundary bugs | 18.7 | 2 | 0 / 0 | $0.0025925 | Both seeded defects found |
| Larger order refactor | 24.1 | 2 | 0 / 0 | $0.0037429 | Double-charge and incorrect-tax defects found |

BaseTen reported $0.0114856 across eight calls. AkashML failed calls had no cost
telemetry; no billed amount is inferred from that absence.

## Decision and limits

Use the new examples/review-config.gpt-oss-120b-baseten.json for subsequent route
testing. The original example remains available. This small sample supports
BaseTen as a promising transport option; it does not establish long-term uptime
or better model judgment. Model and schema changes also mean this is not a
controlled provider-quality benchmark.

The cross-file extra finding assumes fractional prices, but the supplied
requirement specifies whole-dollar prices and safe arithmetic. Its claim of
nondeterminism is also unsupported. Keep this visible as a quality failure.
Duplicate model-assigned preliminary IDs remain an unresolved observed failure
mode from the earlier pacing batch; this follow-up does not claim to fix them.

Private requests, endpoint snapshot, results, and reports:
.review-runs/reference-fix-2026-09-09/.
