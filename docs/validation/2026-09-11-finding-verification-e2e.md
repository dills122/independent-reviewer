# Finding-verification live E2E — 2026-09-11

Commit under test: `5ae508578391cd846e6f77fe2652ed39a707df57`

This run evaluates the fresh, author-blind `FINDING_VERIFICATION` stage added
between preliminary assessment and final reconciliation. It reuses the same 14
human-labeled requirements and standards fixtures as the earlier full matrix.

## Configuration and admission

- Model: `openai/gpt-oss-120b`
- Preferred endpoints: `coreweave/fp4`, then `deepinfra/bf16`
- Zero-data-retention required; data collection denied
- Output allowance: 8,192 tokens per call
- Cost ceiling: `$0.02` per review
- Full dry-run admission: 14/14 passed, zero provider calls

The first live launch was accidentally attempted inside the restricted network
sandbox. Calls failed in 24–313 ms without provider responses or reported cost.
That batch was stopped and excluded. The network-enabled rerun succeeded.

Repeated synthetic standards fixtures also reached the intentional three-instance
flow limit. The private runner was changed to pass `--new-flow`; an eight-case
dry rerun passed before paid execution resumed. The superseded flow-limit failure
is excluded from product results.

## Targeted canary

| Case | Expected | Actual | Verification result |
| --- | --- | --- | --- |
| Real cross-file conversion defect | `NOT_READY` | `NOT_READY` | Candidate confirmed and retained |
| Mistaken invalid-input concern | `READY` | `READY_WITH_FOLLOW_UPS` | Both candidates rejected and withdrawn; final model still added optional validation advice |
| Clean standards control | `READY` | `READY` | No candidates; verifier provider call skipped |

Canary totals: 3/3 completed, 2/3 exact top-level verdicts, 9 calls started,
8 succeeded, and `$0.002679682` provider-reported successful-call cost. One final
call timed out and its DeepInfra retry completed.

The canary proves the core behavior: rejected preliminary findings cannot survive
as findings, confirmed findings can survive, author text is delivered only after
verification persists, and clean assessments avoid the third provider call.

## Full matrix

The final matrix combines five requirements cases and the mandatory standards
case from the first network-enabled pass with eight standards cases resumed under
fresh synthetic flow IDs.

| Case | Expected | Actual | Assessment |
| --- | --- | --- | --- |
| Requirements: clean multi-file refactor | `READY` | `READY` | Exact pass; zero findings and limitations |
| Requirements: cross-file conversion | `NOT_READY` | `NOT_READY` | Exact pass; one consolidated real defect retained from three confirmed candidates |
| Requirements: two boundary bugs | `NOT_READY` | No report | Two correct preliminary findings; verifier returned duplicate IDs and contract rejected ledger |
| Requirements: misleading author | `NOT_READY` | No report | Two preliminary findings; verifier returned duplicate IDs and contract rejected ledger before author delivery |
| Requirements: mistaken concern | `READY` | `READY_WITH_FOLLOW_UPS` | No findings or limitations; optional invalid-input advice caused non-blocking verdict |
| Standards: mandatory violation | `NOT_READY` | `NOT_READY` | Exact pass; finding confirmed and retained |
| Standards: compliant counterpart | `READY` | No report | Clean preliminary; final timed out, then DeepInfra returned 502 |
| Standards: permitted exception | `READY` | `READY` | Exact pass |
| Standards: unsupported defense | `NOT_READY` | No report | Preliminary and repair both mismatched finding enforcement to REQUIRED rule |
| Standards: advisory-only rule | `READY_WITH_FOLLOW_UPS` | `READY_WITH_FOLLOW_UPS` | Exact pass; recommendation stayed non-blocking |
| Standards: conflicting rules | `UNABLE_TO_VERIFY` | `UNABLE_TO_VERIFY` | Exact pass; zero findings and one limitation |
| Standards: missing reference | `UNABLE_TO_VERIFY` | `UNABLE_TO_VERIFY` | Exact pass; zero findings and three limitations |
| Standards: clean refactor | `READY` | `READY` | Exact pass |
| Standards: supplied Markdown authority | `READY` | `READY` | Exact pass; unchanged `API_NAMES.md` capture remained effective |

Aggregate full-matrix results:

- 10/14 runs produced validated final reports.
- 9/14 starts matched the exact expected verdict; 9/10 completed reports matched.
- 35 calls started, 30 succeeded, and 5 failed.
- Three persisted verifier provider calls assessed five candidates, all confirmed.
- Eight no-finding assessments persisted deterministic verifier skips.
- Four provider retries were requested.
- Successful calls reported `$0.008395744`; failed timeout calls have unknown cost
  and must not be treated as free.

The earlier matrix completed 14/14 with 12/14 exact verdicts. This change improves
the false-positive path when verification completes, but the current protocol
regresses end-to-end completion because malformed verifier output has no repair
path. It is promising review logic, not yet a reliable review pipeline.

## Conclusions

What worked:

- Fresh verification occurred before author delivery.
- Genuine defects survived verification and final reconciliation.
- Invalid-domain findings were explicitly rejected and withdrawn in the canary.
- Clean paths skipped paid verification.
- Requirements and standards modes both exercised the new stage.
- Conflicting rules, missing references, and supplied authoritative Markdown
  retained their intended semantics.
- Malformed ledgers and invalid enforcement never degraded into a misleading report.

What failed:

- Two of two full-matrix verifier calls with exactly two preliminary findings
  returned duplicate IDs. The engine correctly rejected them, but produced no
  report.
- Model still turned a rejected or absent invalid-input concern into an optional
  fast follow, changing `READY` to `READY_WITH_FOLLOW_UPS`.
- One clean final call exhausted timeout plus provider retry.
- Existing preliminary structured-output repair did not fix enforcement mismatch
  in the unsupported-defense case.

## Next action

Highest-return slice: remove finding-ID bookkeeping from reviewer output. Send one
verification unit per preliminary finding, require only judgement and rationale,
and bind the result to its finding ID deterministically in the orchestrator. Calls
can run with bounded concurrency. This directly fixes the repeated duplicate-ID
failure while preserving the rule that models review code and deterministic code
owns identity, completeness, and ordering.

In the same slice, final reconciliation should be barred from reintroducing a
rejected finding's premise as a fast follow unless a separate surviving concern
supports it. Provider timeout behavior should remain a measured reliability issue,
not be confused with review correctness.

## Focused protocol fix and rerun

Implemented the follow-up in the same branch:

- Provider verification candidate contains ordered `status` and `rationale`
  judgments only; it never receives or returns finding IDs.
- Runner binds judgments to frozen preliminary finding IDs by position and persists
  the existing identity-bearing verification artifact.
- Final provider schema requires an empty fast-follow list. Runner derives fast
  follows only from validated non-blocking finding corrections.
- Prompt and response protocol identities advanced to `review-policy-v21`,
  `standards-review-v14`, `finding-verification-policy-v3`, and
  `finding_verification_candidate_v1`.

Offline gates passed: 331 tests, zero failures; repository-context CI passed. A
four-case targeted dry run admitted every case with zero calls. Paid targeted
results were 4/4 completed and 4/4 exact for the two former duplicate-ID failures,
the invalid-domain control, and the advisory control. Successful calls reported
`$0.00291252`.

The full 14-case dry matrix admitted every case with zero calls. Paid full-matrix
results:

- 12/14 completed; all 12 completed reports matched expected verdicts.
- 36 calls started, 35 succeeded, and one timed out before a successful route retry.
- Successful calls reported `$0.010076901`; timeout cost remains unknown.
- `two_bugs` completed with two retained findings. Raw verifier output contained
  only `status` and `rationale`; runner persisted distinct `finding_01` and
  `finding_02` identities.
- `misleading_author` completed `NOT_READY`; no verifier identity failure occurred.
- `wrong_concern` completed exact `READY` with zero findings, limitations, or fast
  follows after its preliminary finding was rejected.
- Advisory standards completed `READY_WITH_FOLLOW_UPS`; provider returned no fast
  follows and runner derived one from the validated RECOMMENDED finding.

No focused-fix regression appeared. Two standards runs did not complete because
preliminary assessment and its one repair both mismatched finding enforcement to
the selected REQUIRED rule. This happens before finding verification and is the
next distinct structured-output reliability issue; it is not evidence against the
ID-free verifier or runner-owned fast-follow fix.

Private evidence:

- `.review-runs/full-matrix-2026-09-11/live-verifier-canary-5ae5085/`
- `.review-runs/full-matrix-2026-09-11/live-verifier-full-5ae5085/`
- `.review-runs/full-matrix-2026-09-11/live-verifier-standards-resume-5ae5085/`
- `.review-runs/full-matrix-2026-09-11/focused-fix-live-v3/`
- `.review-runs/full-matrix-2026-09-11/focused-fix-full-live-v3/`
