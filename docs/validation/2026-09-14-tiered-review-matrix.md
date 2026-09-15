# Tiered review matrix paid validation — 2026-09-14

## Scope

Validated the first committed 20-case tiered corpus on
`bdc3fedd5ad4184d2c1decaedde83033840e069e`. The branch was exactly one commit
ahead of `origin/main` and had no divergence before provider access. The full
provider-free matrix had already admitted 20/20 cases with zero calls and zero
cost.

The paid run used:

- model `openai/gpt-oss-120b`;
- pinned provider order `coreweave/fp4`, then `deepinfra/bf16`;
- zero-data-retention required and provider data collection denied;
- `$0.02` maximum cost per case and `$0.40` aggregate matrix ceiling; and
- at most two attempts per logical provider call.

The run started at `2026-09-15T02:41:21.730Z` and completed at
`2026-09-15T03:02:17.511Z`, or approximately 20 minutes 56 seconds.

## Paid result

- 20 cases selected; 19 delivered validated final reports.
- 18/20 matrix successes: 18 expected verdicts, one semantic mismatch, and one
  incomplete delivery.
- 52 calls started: 49 succeeded and three failed.
- Successful or telemetried attempts reported 150,911 prompt tokens, 58,242
  completion tokens, and 209,153 total tokens.
- Provider-reported cost was `$0.01445129`.
- Three failed attempts have unknown cost. Conservative retry accounting
  retained 59,882 tokens and `$0.004394706` separately from reported billing.
- All six new Python, Go, and Java cases matched their expected verdicts.

| Case | Expected | Validated | Complete | Calls |
| --- | --- | --- | --- | ---: |
| `case_001` | `READY` | `READY` | yes | 2 |
| `case_002` | `NOT_READY` | `NOT_READY` | yes | 3 |
| `case_003` | `NOT_READY` | `NOT_READY` | yes | 2 |
| `case_004` | `NOT_READY` | `NOT_READY` | yes | 3 |
| `case_005` | `READY` | `NOT_READY` | yes | 3 |
| `case_006` | `NOT_READY` | none | no | 4 |
| `case_007` | `READY` | `READY` | yes | 2 |
| `case_008` | `READY` | `READY` | yes | 2 |
| `case_009` | `NOT_READY` | `NOT_READY` | yes | 3 |
| `case_010` | `READY_WITH_FOLLOW_UPS` | `READY_WITH_FOLLOW_UPS` | yes | 3 |
| `case_011` | `UNABLE_TO_VERIFY` | `UNABLE_TO_VERIFY` | yes | 3 |
| `case_012` | `UNABLE_TO_VERIFY` | `UNABLE_TO_VERIFY` | yes | 3 |
| `case_013` | `READY` | `READY` | yes | 2 |
| `case_014` | `READY` | `READY` | yes | 2 |
| `case_015` | `READY` | `READY` | yes | 2 |
| `case_016` | `NOT_READY` | `NOT_READY` | yes | 3 |
| `case_017` | `READY` | `READY` | yes | 2 |
| `case_018` | `NOT_READY` | `NOT_READY` | yes | 3 |
| `case_019` | `READY` | `READY` | yes | 2 |
| `case_020` | `NOT_READY` | `NOT_READY` | yes | 3 |

## Retained failures

`case_005` produced a false P1 blocker. Its declared valid domain requires
positive one-based page numbers, but preliminary and finding-verification stages
treated page zero as a required runtime-validation case. The claimed JavaScript
behavior was also wrong: `items.slice(-10, 0)` returns an empty array for an
ordinary array of more than ten items, not its last ten items. This non-critical
semantic defect is tracked in
[#171](https://github.com/dills122/independent-reviewer/issues/171).

`case_006` persisted preliminary and finding-verification artifacts before its
CoreWeave-first final request ended after 120 seconds as `TRANSPORT_UNCERTAIN`.
Its bounded retry, recorded as DeepInfra, then returned HTTP 502. This was an
external delivery failure, not a local admission, persistence, or accounting
defect. Two attempt costs remain unknown.

Cross-case audit found non-blocking normalization and presentation defects:
opaque limitation text, one unsupported compilation claim, clipped verification
rationales, and inconsistent static author-claim dispositions. Evidence was
added to [#168](https://github.com/dills122/independent-reviewer/issues/168).
Aggregate evidence was added to
[#160](https://github.com/dills122/independent-reviewer/issues/160).

No paid replay was attempted. This single run validates harness behavior and
provides initial quality evidence; it is not a provider-reliability estimate.

Private evidence remains under
`.review-runs/evaluation/paid-full-bdc3fed-20260914/`, which is excluded from
Git.

## Post-run harness correction

The paid runner had persisted `error: null` when a CLI attempt ended without a
validated final report. The merge branch now records bounded, control-safe
diagnostics and distinguishes missing or invalid final reports from execution
and ledger-accounting failures. Provider-free regressions cover the `case_006`
shape, malformed final reports, and long diagnostics. This reporting-only
correction does not justify another paid run.
