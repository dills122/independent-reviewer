# Semantic verdict adjudication — issue #184

## Scope

Offline adjudication of three disagreements reported in
[#184](https://github.com/dills122/independent-reviewer/issues/184), using
persisted preliminary assessments, finding-verification ledgers, final reports,
and neutral briefs. No new provider requests were made. Raw provider responses
remain local; this document records bounded field-level conclusions only.

Original run: `checkpoint-full-8bd8ca7-20260915-live`, engine `8bd8ca7`.
Later comparison: `full-7308032-20260917-live`, engine `7308032`.
Artifacts reside under ignored `.review-runs/evaluation/<run>/<case>/packet/review/`.

## Claim-level results

| Case and claim | Preliminary | Verification | Final | Attribution |
| --- | --- | --- | --- | --- |
| 008: departure from advisory naming rule despite mandatory-rule exception | Correct `RECOMMENDED` finding; mandatory exception does not waive separate advice | `NO_VIOLATION` solely because recommendation is not required | Finding withdrawn; `READY`, no follow-up | Verifier policy/semantic classification; projection follows its persisted rejection |
| 014: registry-backed compliant export | No finding; placeholder limitation `type` | `NO_BLOCKING_UNCERTAINTY` for placeholder | Placeholder resolved; registry rule remains unassessed, `UNABLE_TO_VERIFY` | Evidence selection; required registry absent from actual blind packet |
| 022: registry-backed mismatching export | No finding; standards input `UNASSESSED` | Empty ledger; no adverse preliminary claims to verify | Missing coverage and unassessed registry preserved, `UNABLE_TO_VERIFY` | Evidence selection; same missing registry |

The original issue said registry evidence was supplied. It existed in the fixture
repository, but both original neutral briefs have empty `referencedSources`
and `referenceEvidence.captureStatus=UNAVAILABLE` for `reference_api_names`.
The reviewer could not evaluate a registry it never received. These are capture
defects, not demonstrated oracle errors or unjustified abstention.

PR #188 (merged `1cd29c7`) already restored declared-reference capture for V3
standards requests and added the current-request regression in
`test/snapshot/standards-references.test.ts`. Its separately authorized targeted
paid confirmation matched both cases; see the
[capture/failover checkpoint](2026-09-15-provider-chain-failover.md).
The later comparison also contains the registry in both briefs and yields
`READY` for 014 and `NOT_READY` for 022.

Case 022's later result is not proof of complete semantic correctness: its
verifier reports `INCONCLUSIVE` because alleged downstream import failures lack
support. Final reconciliation retains the naming violation and also retains
that unsupported impact. Material claim continuity and inconclusive projection
remain [#161](https://github.com/dills122/independent-reviewer/issues/161).
Case 014's placeholder handling is separately addressed by ADR-022/PR #193.

Case 008 repeats in the later run. V4 checks explicitly record
`ABSENT_OR_INAPPLICABLE`, `IN_SCOPE`, and `SUPPORTED`; rationale denies an
obligation solely because enforcement is advisory. ADR-021 now maps that exact
contradiction to `INCONCLUSIVE`, but does not explain that advisory rules can
apply. It also deliberately leaves `NO_INPUT_SCENARIO` plus absent obligation
as `NO_VIOLATION`, preserving genuine exception/invented-obligation rejection.

## Bounded correction

Verification policy V8 distinguishes applicability from mandatory enforcement.
Selected recommendations can be applicable; supported departures use existing
`VIOLATION_DEMONSTRATED` status while runner-owned severity remains
`RECOMMENDED`. Exceptions remain local to their declaring rule. An exception to
the recommendation itself still permits rejection.

No oracle, family split, fixture, status derivation, or report schema changes.
Case 008 belongs to development family `typescript-naming`; registry cases 014
and 022 belong to holdout family `typescript-naming-registry`. Holdout artifacts
were used only to adjudicate capture and residual uncertainty, not to tune policy.
No rule-specific or case-specific runtime matching. Generic CLI regressions
cover advice alone, advice alongside a mandatory-rule exception, and an
exception to advice itself. Their mock responses exercise existing deterministic
status and report projection; policy assertions check wording reaches the blind
verifier. Final blockers remain empty; supported advice yields one fast-follow
and `READY_WITH_FOLLOW_UPS`, while exempt advice yields `READY`.

## Qualification boundary

Three advisory CLI tests failed against V7 at the missing policy instruction,
then passed against V8. This is a policy-delivery regression, not a reproduction
of stochastic model reasoning. Offline tests cannot establish that a live model
will classify applicability correctly. V8 still permits a model to return an
incorrect individual check, and final reconciliation remains subject to #161.

Application checks passed: formatting, lint, type checking, 743 coverage tests
(93.38% lines, 86.71% branches, 96.15% functions), and 37 provider-free CLI tests.
`npm run check` reached its final audit step, which could not access npm from
the sandbox; the separate network-enabled `npm run audit:dependencies` passed
with zero vulnerabilities. Committed context validation and separate local
`python3.12 -B scripts/check-ai-context.py` also passed.

Issue #184 remains open for separately authorized paid advisory confirmation.
Any request must freeze selector, repetitions, provider policy, reservation,
and stop conditions before spending. Registry cases already have paid capture
confirmation and need not be replayed solely for this policy clarification.
