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

The exact no-violation finding path is covered by a provider-mock regression. A
correction-phrase denylist was deliberately not added: it would make the runner
judge natural-language semantics, conflict with the general-tool requirement,
and be brittle across languages. V2 status directly represents whether a
correction-worthy violation exists.

## Focused V2 paid confirmation

The separately approved focused confirmation ran at commit `d444a10`. Its
provider-free dry-run admitted the exact `requirements/wrong_concern` case with
zero calls. The paid run completed in 21,737 ms with two successful CoreWeave
calls and `$0.00051348` provider-reported cost, but returned
`UNABLE_TO_VERIFY` instead of expected `READY`.

This run produced no preliminary findings, so the V2 finding verifier persisted
an empty local ledger and made no provider call. Preliminary review correctly
said the implementation preserved all specified positive-integer pagination
behavior, then added a limitation asking for validation of inputs outside that
stated valid domain. Final reconciliation retained and restated that limitation.
Runner-owned bookkeeping correctly converted the two limitations into
`UNABLE_TO_VERIFY`.

The result does not disprove the V2 judgment vocabulary; it did not exercise a
V2 judgment. It exposes a wider verification-boundary gap: preliminary findings
are challenged, but agent-authored evidence gaps and limitations can affect the
verdict without fresh verification. Final candidate limitations are also
unbound free text and can restate the same unsupported concern. The same frozen
snapshot and `review-policy-v21` had previously completed `READY` with no
limitations, so one successful replay was not evidence of stable behavior.

Further paid retries were stopped while the preliminary adverse-claim boundary
was fixed and covered offline. Decision and scope are documented in ADR-016 and
`docs/plans/2026-09-12-verdict-affecting-claim-verification-plan.md`.

## Preliminary adverse-claim verification checkpoint

Active runs now use `finding_verification_candidate_v3` and
`finding-verification-policy-v5`. One author-blind verifier call runs when the
preliminary contains any finding, evidence gap, or limitation; an entirely clean
preliminary still receives a local empty artifact and makes no verifier call.
Provider judgments remain ordered and identity-free. Runner binds concern
kind/index, persists exact scope, and resume rejects V1/V2/V3 mixing.

Final-candidate V3 no longer accepts provider-authored limitations. Runner
derives formal limitations from verified preliminary concern dispositions,
snapshot coverage, and standards state. `NO_BLOCKING_UNCERTAINTY` must resolve;
demonstrated or inconclusive blocking uncertainty must remain. The exact
limitation-only regression and genuine excluded-evidence control pass offline.
At that checkpoint, no post-fix paid provider run had been performed.

## Focused V3 paid confirmation — 2026-09-13

Validated the V3 working tree based on
`5fbfbb3ccfe1d3c83f738153ec011e82e1ceb468`; tracked patch digest before the
run was
`406c9d960f4b03bf17396279658cc3f2a5dbb30a88a9baf051f816e99f73e88e`.
The exact `requirements/wrong_concern` dry-run admitted with zero calls and zero
cost. The separately approved paid run then completed exact `READY` in 115,801
ms with three successful CoreWeave calls and `$0.00090193`
provider-reported cost. It produced zero final findings, zero limitations, zero
repairs, and zero transport retries.

Preliminary review again invented the non-positive-input validation obligation,
this time as one P1 finding rather than a limitation. V3
`finding-verification-policy-v5` returned `NO_VIOLATION`; final reconciliation
withdrew the finding. Raw final provider verdict was `NOT_READY`, while
runner-owned assembly correctly produced `READY`. Ledger order proves the V3
verification artifact was persisted before `AUTHOR_DELIVERED`.

This paid sample validates the V3 finding path and end-to-end runner projection.
It does not empirically exercise a non-empty `concernAssessments` response because
the preliminary model chose the finding category on this run. That exact
limitation-only path remains covered offline; a deterministic paid concern
canary would require separate approval.

Private run evidence:

- `.review-runs/full-matrix-2026-09-11/v3-preliminary-claim-dry-2026-09-13/`
- `.review-runs/full-matrix-2026-09-11/v3-preliminary-claim-live-2026-09-13/`

## Post-rebase paid confirmation — 2026-09-13

Rebased the V3 branch onto `582fe23`, incorporating the merged capture,
run-record, resume-eligibility, schema-bound, and guidance-limit fixes from
PRs #139, #140, #141, and #143. The rebased checkpoint was `1b11572`. Contract
schema generation, the 495-test application gate, coverage thresholds, and the
committed repository-context gate all passed before provider access. The exact
`requirements/wrong_concern` dry-run again admitted with zero calls and zero
cost.

The separately approved paid replay completed exact `READY` in 56,971 ms with
two successful CoreWeave calls, 8,214 reported tokens, and `$0.0005288`
provider-reported cost. It produced zero findings, zero limitations, zero
repairs, and zero transport retries. This time the preliminary assessment was
clean, so the V3 verifier correctly persisted an empty local artifact without
buying a third call. The final provider still returned the contradictory raw
compatibility verdict `NOT_READY` alongside no findings, limitations, or
blockers; runner-owned assembly correctly derived `READY`.

This replay confirms the rebased fixes did not regress capture, typed ledger
events, local empty verification, author-stage ordering, or final bookkeeping.
It complements the prior three-call sample: the earlier run exercised provider-
backed rejection of a false finding, while this run exercised the lower-cost
clean-preliminary path. A non-empty concern-verification response remains
covered deterministically offline rather than by this stochastic paid sample.

Private run evidence:

- `.review-runs/full-matrix-2026-09-11/v3-rebased-bugfix-dry-2026-09-13/`
- `.review-runs/full-matrix-2026-09-11/v3-rebased-bugfix-live-2026-09-13/`

## Full post-rebase paid matrix — 2026-09-13

Ran the complete 14-case matrix at `5fa4e84` after the build-output cleanup.
The provider-free pass admitted 14/14 cases with zero calls and zero cost. The
paid pass completed 9/14 cases; every completed verdict matched its human label.
Those nine reports contained the expected two pagination/shipping defects,
misleading-author access defect, mandatory and advisory naming findings,
missing-context limitations, and clean outcomes. Only one raw provider verdict
matched its human label, while runner-owned assembly produced 9/9 correct final
verdicts.

The run started 37 calls: 27 succeeded (16 CoreWeave, 11 DeepInfra) and 10
failed. Successful calls reported `$0.007381112` total across 961,359 ms of
aggregate per-case elapsed time. Failed-call cost was not reported and must not
be inferred as zero.

Five cases produced no report:

- `requirements/cross_file`: both configured providers first returned an
  aggregate shared-pool 429; the retry received a DeepInfra 200 response with
  null completion content.
- `standards/clean`: both preliminary attempts received DeepInfra 200 responses
  with null completion content.
- `standards/exception`, `standards/unsupported-defense`, and
  `standards/conflicting-rules`: preliminary/verification work persisted, but
  final calls exhausted the bounded retry after CoreWeave 429 and DeepInfra 502
  responses.

This is an availability failure, not evidence of wrong review semantics or a
regression caused by the build cleanup. One internal recovery weakness did
amplify `standards/clean`: in pinned mode, retry drops the first configured
endpoint rather than the endpoint named by response metadata. DeepInfra was the
actual failed provider, but the retry reduced the route to DeepInfra and never
tried CoreWeave. Add a regression for a non-head pinned-provider failure and
select the remaining configured endpoint by normalized provider identity.

Do not repeat the full paid matrix to diagnose this result. Fix and test pinned
retry selection offline, then replay only the five incomplete cases after
provider capacity stabilizes. No change to review prompts or verdict policy is
supported by this run.

Private run evidence:

- `.review-runs/full-matrix-2026-09-11/post-rebase-rimraf-full-dry-2026-09-13/`
- `.review-runs/full-matrix-2026-09-11/post-rebase-rimraf-full-live-2026-09-13/`
