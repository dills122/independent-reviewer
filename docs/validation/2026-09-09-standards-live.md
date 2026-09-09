# Standards-mode live evaluation — 2026-09-09

Live batch authorized after implementation checkpoint `85b5816`. Planned eight
synthetic, human-labeled standards cases; maximum reservation $0.02 per review,
$0.16 across eight starts. No repository source or implementation conversation
sent: each case uses an isolated fixture repository and explicit selected rules.
The normal convenience CLI performs both model stages. Credentials load directly
from the ignored environment file and are not included in evaluation artifacts.

## Results

Eight review starts, 19 provider calls, four validated final reports, two full
semantic passes. Three final verdicts matched expected labels, but missing-context
findings were still wrong. All starts count, including failures. Do not interpret
this mixed-route, mixed-output-cap batch as a stable reliability estimate.

| Case | Final outcome | Calls | Seconds | Assessment |
| --- | --- | --- | --- | --- |
| Mandatory violation | No report: 529 | 2 | 7.2 | Correct preliminary only |
| Compliant counterpart | No report: 529 | 2 | 4.7 | Correct preliminary only |
| Permitted exception | No report: repeated 529 | 3 | 14.4 | Correct preliminary; retry exhausted |
| Unsupported author defense | NOT_READY | 2 | 91.6 | Pass: real violation retained |
| Advisory-only rule | No report: output limit | 2 | 144.4 | Incomplete |
| Conflicting required rules | NOT_READY | 3 | 91.3 | Fail: ignored conflict |
| Unavailable context | UNABLE_TO_VERIFY | 3 | 76.3 | Mixed/fail: correct verdict, unsupported REQUIRED finding |
| Clean refactor | READY | 2 | 54.8 | Pass: no findings |

Provider-reported cost: **$0.005222004**, plus **six unknown-cost calls**.
Maximum batch reservation remained $0.16. All failed submissions retained their
ledgers; none was silently replaced by a successful rerun. The three available
provider retries were recorded: one BaseTen retry failed again; the two retries
on the alternate route completed their respective stages. No output-repair call
occurred in this batch.

## Observed failure and fix

GPT-OSS 120B through pinned `baseten/fp4` returned valid preliminary assessments
for mandatory naming, compliant naming, and a documented naming exception. Those
assessments matched expected results. Each final stage received an explicit 529
response identifying temporary overload; diagnostics also contained earlier
429/529 upstream failures. No valid final report was produced on that route.

Our transient-error allowlist omitted 529. Added that explicit status to the
existing run-wide one-retry policy, using the same 5–10 second jittered fallback
as 429 and continuing to honor Retry-After. Existing token/cost admission,
unknown-cost reservation, timeout non-replay, and maximum retry count remain.
Explicit `resume-final` eligibility is unchanged; historical failed runs were
not replayed.

Regression test first reproduced failure, then passed for both 503 and 529:
only the failed final call repeats, with identical inputs, unique attempt IDs,
and failed-call token/cost reservations. `npm run check`: 208 tests passed.
`python3 -B scripts/check-ai-context.py --ci`: passed.

The exception case exercised the fix live: one retry occurred, then BaseTen
returned 529 again. Recovery handling works; it cannot restore provider capacity.
Stopped BaseTen submissions after three failed reviews. Remaining cases use the
existing CoreWeave/DeepInfra configuration with the same model and cost ceiling.
This route change prevents interpreting the batch as a controlled quality
comparison between providers.

## Evidence

Private reproducible fixture runner, expected labels, per-run reports/ledgers,
and aggregate cost summary: `.review-runs/standards-live-2026-09-09/`.
Failed calls with missing usage are unknown-cost calls, not free calls. Initial
assessment accuracy does not establish successful final reconciliation.

## Review quality and configuration observations

The unsupported-author-defense case completed correctly: the final report kept
the mandatory naming violation despite the author's request to disregard it.
The correction is useful, although its wording says “multi-word” where the rule
only requires descriptive full words.

The advisory case exhausted CoreWeave's 4,096-token final output allowance and
produced no valid report. It was not restarted. The last three cases use 8,192
output tokens with the same 160,000 total-token and $0.02 cost ceilings; admission
passed. This is an evaluation configuration change, not a global default change.

The distinct-ID conflicting-rules case completed but failed semantic evaluation.
The model flagged the descriptive-name requirement while ignoring the simultaneous
requirement to use exactly `v`; its proposed rename violates that second rule.
The report has no limitation and returns NOT_READY instead of reporting an
unresolved conflict. Current provenance validation checks that cited rules exist
and apply, but does not establish that all rules were meaningfully considered.
Profile-level coverage accepted this incomplete interpretation. Duplicate-ID
rejection from offline tests does not cover semantic contradictions.

Next quality fix should expose per-rule assessment/conflict coverage through
both stages, validate complete rule accounting, and require corrections to be
checked against other applicable mandatory rules. This cannot guarantee semantic
truth, but makes ignored rules visible and testable. Do not mark conflict handling
complete based on schema-valid output alone.

The missing-context case returned the correct UNABLE_TO_VERIFY verdict and
explicitly named the absent registry. However, it also created a REQUIRED
finding from that uncertainty and suggested adding an accepted name to the
registry. Missing evidence does not prove a code violation or authorize changing
the standard. Count this as a mixed result / quality failure, not a full pass.
Unknown rule assessments need a separate representation from confirmed violations.
