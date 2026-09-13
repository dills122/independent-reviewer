# ADR-015: Use violation-specific verifier judgments

## Status

Accepted

## Date

2026-09-12

## Context

The paid 14-case matrix completed every run but produced one false positive. A
preliminary item described compliance with a guidance rule and said no correction
was needed. The verifier returned `CONFIRMED`, interpreting that word as
confirmation of compliant behavior instead of confirmation that the finding's
claimed violation existed. Runner enforcement then correctly retained what the
ambiguous judgment had incorrectly approved.

The verifier boundary is public, persisted, and resume-sensitive. Changing the
meaning of its existing enum in place would make old artifacts appear compatible
with new semantics. Parsing correction prose for phrases such as “none required”
would also move semantic review into language-dependent runner heuristics.

## Decision

Add `FindingVerificationV2` and its provider candidate contract while preserving
V1 readers. V2 replaces `CONFIRMED` and `REJECTED` with:

- `VIOLATION_DEMONSTRATED`: frozen changed evidence demonstrates the claimed
  violation of a supplied requirement or applicable selected rule.
- `NO_VIOLATION`: the item describes compliance, a satisfied rule, an absent
  obligation, an out-of-domain scenario, unchanged behavior, or another claim
  unsupported by the frozen change.
- `INCONCLUSIVE`: frozen evidence cannot establish whether the claimed violation
  exists.

New runs request `finding_verification_candidate_v2` with
`finding-verification-policy-v4`. Request and verification envelopes use schema
version 2. Runner binds ordered judgments to its persisted finding IDs and
requires every `NO_VIOLATION` item to be withdrawn during final reconciliation.
Resume validates the V2 schema name, prompt version, request digest, and persisted
V2 artifact; it rejects V1/V2 protocol mixing and asks for a new review.

Verifier policy explicitly asks whether a violation is demonstrated and forbids
using the positive status for compliant behavior, satisfied rules, or findings
that require no correction. Runner continues validating identity, count, scope,
and withdrawal bookkeeping without interpreting natural-language corrections.

## Alternatives considered

### Strengthen only the V1 prompt

Rejected. The enum remains linguistically ambiguous, and changing its semantics
without changing its version makes persisted artifacts unsafe to interpret.

### Reject known no-action correction phrases in the runner

Rejected. Phrase matching is language-dependent, easy to evade, and can reject a
valid correction that quotes or discusses a no-action phrase. Code-review
semantics remain agent-owned.

### Add a separate correction-required boolean

Rejected for now. It duplicates the V2 status meaning without independent
evidence and permits contradictory combinations that need more validation.

## Consequences

- Existing V1 schemas and exports remain available for explicit old-artifact
  readers; active orchestration writes V2 only.
- Exact schema names and prompt versions make incompatible resumes fail closed.
- Positive-compliance items now have an explicit negative finding judgment.
- This removes the observed ambiguity but does not make semantic model judgment
  deterministic. One focused paid replay remains required for empirical proof.
