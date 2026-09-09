# Call recovery E2E batch — 2026-09-09

Five existing scenarios ran once through prompt v10 / candidate v2, with two
concurrent reviews, GPT-OSS 120B, the existing CoreWeave/DeepInfra allowlist,
160,000 conservative token units, and a $0.02 ceiling per review. No runtime
changes, manual restarts, or fresh reruns occurred during this batch.

| Scenario | Result | Calls | Provider retries | Output repairs | Seconds |
| --- | --- | --- | --- | --- | --- |
| Clean multi-file | READY, no findings; expected | 3 | 1 | 0 | 96.4 |
| Cross-file currency bug | NOT_READY, correct 100× conversion defect and fix | 4 | 1 | 1 | 146.5 |
| Two independent bugs | NOT_READY, pagination omission and shipping threshold both found | 3 | 0 | 1 | 164.2 |
| Misleading author | NOT_READY, access bug retained despite author justification | 2 | 0 | 0 | 100.2 |
| Incorrect author concern | READY, but unexpected P2 input-validation finding: quality failure | 3 | 0 | 1 | 219.6 |

## Call recovery

All five runs completed without manual intervention. Clean multi-file recovered
from a final-stage shared-pool 429. Cross-file recovered from a 502 during its
output-repair call; diagnostics also recorded a prior CoreWeave 429. Both retries
completed, with no repeated preliminary assessment. Each run persisted its blind
assessment before author delivery. No timeout occurred in this batch.

Fifteen calls reported $0.004397652 combined, excluding two failed calls whose
actual cost is unknown. Their conservative reservations remain in run ledgers.
This is evidence for bounded transient-error recovery, not an uptime guarantee.

## Remaining review-output issues

Three runs required output repair because they invented an EVIDENCE_GAP index 0
when the preliminary assessment had no evidence gaps. All three repairs succeeded.

Four of five scenarios matched expected defect findings. The incorrect-author-
concern fixture raised input validation outside the stated positive-input
contract; that behavior was not introduced by the refactor. Its example also
incorrectly claims Array.slice(-2, 0) returns the last two items; it returns [].
The result is therefore a false positive despite its READY verdict.

The cross-file report identified the correct extra multiplication and correction,
but its numeric example contradicts its own correct 100×-overcharge summary.
These are model-output quality issues, separate from recovered transport calls.

Private artifacts, reports, reproducible runner, and summary:
`.review-runs/recovery-batch-2026-09-09/`.
