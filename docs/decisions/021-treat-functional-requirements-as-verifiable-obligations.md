# ADR-021: Treat functional requirements as verifiable obligations

## Status

Accepted; refines the derivation table in
[ADR-020](020-derive-finding-verification-from-structured-checks.md)

## Date

2026-09-18

## Context

The full paid matrix `full-7308032-20260917-live` ran the V4 structured checks on
a synthetic owner-access inversion that replaced `user.id === document.ownerId`
with `user.id !== document.ownerId`. The supplied requirement stated that only a
document owner may read it. Preliminary review recorded a correct P1 finding with
HEAD evidence.

Finding verification then returned `obligationStatus=ABSENT_OR_INAPPLICABLE`
together with `scenarioStatus=IN_SCOPE` and `behaviorStatus=SUPPORTED`. Its
rationale treated an explicit functional product requirement as irrelevant
because it was not a legal or written-policy obligation. The ADR-020 derivation
table maps any absent obligation to `NO_VIOLATION`, so the runner forced
withdrawal and the final report emitted `READY` with no blockers for a
demonstrated access-control defect.

Two independent defects produced that outcome: the policy left "obligation" open
to a legal or compliance reading, and the derivation accepted a check set that
denies the obligation while affirming both the in-domain scenario and the changed
behavior it creates.

## Decision

Verification policy states that any supplied functional or behavioral
requirement, including ordinary product behavior such as who may read, write, or
see a record, is an applicable obligation. Legal, regulatory, contractual, or
written-policy status is never required for `APPLICABLE`, and a stated
requirement does not become inapplicable because it is a feature requirement.

The runner derivation gains one contradiction rule ahead of the existing table:
`ABSENT_OR_INAPPLICABLE` plus `IN_SCOPE` plus `SUPPORTED` derives `INCONCLUSIVE`
rather than `NO_VIOLATION`. Every other combination keeps ADR-020 semantics, so
an out-of-scope scenario, a refuted behavior, and an absent obligation with a
`NO_INPUT_SCENARIO` or unestablished behavior still derive `NO_VIOLATION`.

The active finding-verification policy version becomes
`finding-verification-policy-v7`.

## Consequences

- A denied obligation can no longer withdraw a finding whose concrete in-domain
  scenario and changed behavior the same response affirmed. That combination
  becomes uncertainty rather than a clean verdict.
- The #171 out-of-domain rejection path is unchanged, because it turns on
  `OUT_OF_SCOPE` and `REFUTED` rather than on obligation absence.
- Invented obligations that carry no runtime input boundary keep deriving
  `NO_VIOLATION` through `NO_INPUT_SCENARIO`, so ordinary false-positive
  suppression is preserved.
- Runner enforcement still binds only `NO_VIOLATION` to withdrawal. A
  `VIOLATION_DEMONSTRATED` finding that the final stage withdraws anyway remains
  unenforced and stays with final-claim verification in
  [#161](https://github.com/dills122/independent-reviewer/issues/161).
- The policy version bump means in-flight V4 work cannot resume across this
  change; resume already requires exact policy and schema versions.
- Candidate and persisted JSON schemas are unchanged, because status stays
  runner-derived and absent from provider output.

## Alternatives considered

### Derive `VIOLATION_DEMONSTRATED` from the contradictory check set

Rejected. The runner would be overriding an explicit provider check rather than
refusing an inconsistent one, and a genuinely absent obligation would then
produce a blocker.

### Extend the contradiction rule to `NO_INPUT_SCENARIO`

Rejected. Most invented obligations have no runtime input boundary, so the rule
would convert the common false-positive shape into retained uncertainty and
weaken the #171 result.

### Add a further prompt sentence alone

Rejected as a sole fix for the reason recorded in ADR-020: a natural-language
warning cannot enforce consistency between checks the same response returns.
