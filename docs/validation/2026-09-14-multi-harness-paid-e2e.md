# Multi-harness paid E2E matrix — 2026-09-14

## Scope

Validated the complete 14-case requirements and standards matrix after rebasing
the multi-harness guidance branch directly onto `d428f86`. The tested commit was
`347f41e141f0b2f14f5f29aae0da46d2f6466578`. PR #156 repository checks,
including coverage, provider-free E2E, dependency review, and both CodeQL
analyses, passed on that rebased commit.

Configuration retained the previously qualified controls:

- model `openai/gpt-oss-120b`;
- pinned provider order `coreweave/fp4`, then `deepinfra/bf16`;
- zero-data-retention required and provider data collection denied;
- `$0.02` maximum cost per case, `$0.28` aggregate matrix ceiling; and
- at most two attempts per logical provider call.

Before provider access, 32 provider-free CLI E2E tests passed. The complete dry
matrix then admitted 14/14 cases with zero calls and zero cost.

## Paid result

- 3/14 cases completed; all 3 completed verdicts matched their human labels.
- 35 calls started: 12 succeeded and 23 failed.
- Successful calls reported `$0.003062727` total cost. Failed-call cost was
  unavailable and must not be inferred as zero or as part of a settled bill.
- No completed report had a semantic mismatch.

Completed cases:

| Case | Expected | Validated | Calls | Reported cost |
| --- | --- | --- | ---: | ---: |
| `requirements/misleading_author` | `NOT_READY` | `NOT_READY` | 3 | `$0.00074853` |
| `standards/exception` | `READY` | `READY` | 2 | `$0.00048258` |
| `standards/provided-context` | `READY` | `READY` | 2 | `$0.00048943` |

## Incomplete-case classification

All 23 failed calls were typed `PROVIDER_ERROR` responses with HTTP 429 and
`upstream_provider_shared_pool` as the limit source. Initial routed attempts
reported CoreWeave `rate_limit_exceeded` after a prior DeepInfra 429. Bounded
DeepInfra retries reported `engine_overloaded`. No local admission, guidance,
schema, malformed-output, transport-uncertain, persistence, or rebase failure
caused an incomplete case.

- Preliminary unavailable; fresh review required: `requirements/cross_file`,
  `requirements/two_bugs`, `standards/clean`, `standards/conflicting-rules`,
  `standards/missing-context`, and `standards/clean-refactor`.
- Preliminary saved; finding verification unavailable and no final-only resume:
  `standards/mandatory`, `standards/unsupported-defense`, and
  `standards/advisory`.
- Preliminary saved; final call unavailable and `resume-final` may be eligible
  after local revalidation: `requirements/clean_multi` and
  `requirements/wrong_concern`.

No automatic paid replay or final-only resume was attempted. Capacity failure
does not support a prompt, verdict-policy, guidance, or orchestration change.
Retry only selected incomplete cases after provider capacity stabilizes and
with separate explicit paid authorization.

Private evidence remains under:

- `.review-runs/full-matrix-2026-09-11/post-rebase-guidance-dry-2026-09-14-347f41e/`
- `.review-runs/full-matrix-2026-09-11/post-rebase-guidance-live-2026-09-14-347f41e/`

Both directories are excluded from Git.

## Targeted recovery — 2026-09-14

After explicit paid authorization to retry every incomplete case, capacity was
materially healthier:

- `resume-final` revalidated and completed `requirements/clean_multi` and
  `requirements/wrong_concern` as `READY`, matching both human labels. Each
  resume used one successful call; together they reported `$0.000547637` of new
  successful-call cost.
- A fresh targeted run completed the remaining 9/9 cases, and all nine verdicts
  matched their human labels. It started 26 calls: 24 succeeded and two failed
  before bounded recovery. Successful calls reported `$0.006603348`.
- The complete recovery wave therefore finished 11/11 cases with expected
  verdicts. It added 28 calls, 26 successes, two failed calls of unknown cost,
  and `$0.007150985` in reported successful-call cost.

One `requirements/two_bugs` finding-verification attempt timed out as
`TRANSPORT_UNCERTAIN`; the in-process, conservatively charged retry defined by
ADR-006 succeeded. One `standards/clean` final attempt received HTTP 502 from
DeepInfra after a prior CoreWeave 429; its bounded retry succeeded. No other
recovery call failed.

Combining the original and recovery waves, every one of the 14 human-labeled
cases produced the expected validated verdict. Across both waves, 63 calls
started, 38 succeeded, and 25 failed. Successful calls reported `$0.010213712`;
failed-call cost remains unknown and must not be inferred as zero.

Private recovery evidence remains under:

- the resumed case directories within
  `.review-runs/full-matrix-2026-09-11/post-rebase-guidance-live-2026-09-14-347f41e/`; and
- `.review-runs/full-matrix-2026-09-11/failed-retry-live-2026-09-14-eb38824/`.

These directories are excluded from Git. No completed case was rerun, and no
additional paid call followed the successful recovery wave.
