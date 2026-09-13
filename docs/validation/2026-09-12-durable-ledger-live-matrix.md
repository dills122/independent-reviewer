# Durable ledger paid E2E matrix — 2026-09-12

## Scope

Validated the `codex/durable-run-ledger` working tree based on
`759346fed286978c3d2f59cb59e6fe0b3e9151b4`. The existing frozen 14-case matrix
covered five requirements reviews and nine standards reviews. It exercised
clean changes, cross-file defects, multiple defects, misleading author input,
invalid-domain concerns, mandatory and advisory rules, explicit exceptions,
conflicting rules, missing reference context, clean refactors, and provided
authoritative context.

The provider-free admission run completed 14/14 cases with zero calls before
the separately approved paid run.

## Paid configuration

- Model: `openai/gpt-oss-120b`
- Pinned provider preference: `coreweave/fp4`, then `deepinfra/bf16`
- Zero-data-retention required; provider data collection denied
- Per-case cost ceiling: `$0.02`
- Maximum attempts per logical call: 2

## Results

- 14/14 cases completed.
- 13/14 validated verdicts matched the human label.
- 35 calls started and all 35 succeeded through CoreWeave.
- No transport retries, output repairs, malformed candidates, or unknown-cost
  calls occurred.
- Successful calls reported `$0.01031419` total. This is provider-reported
  usage, not a settled billing statement.
- Aggregate per-case elapsed time was 575,105 ms.

Runner-owned assembly materially improved outcomes: raw provider verdict fields
disagreed with the validated runner verdict in 12/14 cases. The raw verdict is a
compatibility field and is intentionally ignored; the runner derived 13 correct
verdicts from validated findings, limitations, coverage, and follow-up state.

## Sole mismatch

`requirements/wrong_concern` expected `READY` and completed
`READY_WITH_FOLLOW_UPS`. Preliminary review produced two findings:

1. A missing-invalid-input-validation concern. Fresh verification correctly
   rejected it because the requirement defined the valid domain without
   requiring runtime validation.
2. A positive “guidance compliance confirmed” item with correction “None
   needed.” Fresh verification incorrectly marked this item `CONFIRMED`, so the
   runner retained it as a P2 finding and derived a meaningless “None required”
   fast follow.

This is a review-semantic false positive, not a transport, persistence, or
resume failure. `CONFIRMED` was interpreted as confirming satisfied behavior
instead of confirming a demonstrated violation. Existing prose forbids this,
but the structured verifier contract does not make that distinction explicit
enough.

## Decision

Prioritize a narrow verifier-contract fix before orchestration decomposition:

1. Make positive verifier status unambiguously mean that a violation was
   demonstrated, not that compliant behavior was confirmed.
2. Require a retained finding to describe an actionable correction and reject
   a finding whose own correction says no change is required.
3. Add the exact `wrong_concern` path as a provider-mock regression.
4. Run the focused provider-free case, then one separately approved paid
   `wrong_concern` confirmation. Do not repeat the full paid matrix for this
   narrow fix.

Private evidence remains under
`.review-runs/full-matrix-2026-09-11/durable-ledger-live-2026-09-12/` and is
excluded from Git.

## Implementation checkpoint

Implemented the contract decision as versioned V2 artifacts with
`VIOLATION_DEMONSTRATED`, `NO_VIOLATION`, and `INCONCLUSIVE`. New runs use
`finding_verification_candidate_v2` and `finding-verification-policy-v4`; resume
rejects V1/V2 protocol mixing. Runner final semantics require every
`NO_VIOLATION` preliminary item to be withdrawn.

The exact no-violation path is covered by a provider-mock regression. A
correction-phrase denylist was deliberately not added: it would make the runner
judge natural-language semantics, conflict with the general-tool requirement,
and be brittle across languages. V2 status directly represents whether a
correction-worthy violation exists. Focused paid confirmation remains pending
separate approval.
