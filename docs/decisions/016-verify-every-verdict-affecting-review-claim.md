# ADR-016: Verify preliminary adverse claims and own final limitations

## Status

Accepted

## Date

2026-09-13

## Context

ADR-012 added fresh, author-blind verification for preliminary findings, and
ADR-015 made its judgments explicitly violation-specific. The focused paid V2
confirmation did not exercise that verifier because preliminary review emitted
no findings. Instead, it described missing validation outside the canonical
positive-integer input domain as a limitation. Final reconciliation retained and
restated the limitation, and runner-owned bookkeeping correctly produced
`UNABLE_TO_VERIFY`.

This is a category escape. Preliminary `findings`, `evidenceGaps`, and
`limitations` are all model-authored semantic claims, but only findings receive
a fresh challenge. Final candidate limitations are unbound strings. Any such
string can block a ready verdict even when the same premise would have been
rejected as a finding.

The failed run used the same frozen snapshot, model, provider, and preliminary
policy as an earlier exact `READY` run. Different valid structured outputs are
therefore normal operating variance, not a condition a prompt-only fix can
assume away.

## Decision

Adopt this invariant:

> Every preliminary model-authored adverse claim must have a persisted fresh
> verification judgment before author disclosure. Final limitations are
> runner-owned projections, not free-form provider claims.

Generalize the author-blind verification stage from findings to all preliminary
adverse claims:

- Finding judgments remain `VIOLATION_DEMONSTRATED`, `NO_VIOLATION`, or
  `INCONCLUSIVE`.
- Evidence-gap and limitation judgments become
  `BLOCKING_UNCERTAINTY_DEMONSTRATED`, `NO_BLOCKING_UNCERTAINTY`, or
  `INCONCLUSIVE`.
- Provider returns ordered judgments without IDs. Runner binds finding IDs and
  concern kind/index, validates exact counts, and persists the artifact before
  author disclosure.
- Verification call runs when any preliminary adverse claim exists. A truly
  empty assessment still receives a local empty artifact with no provider call.

Runner projects verified judgments without interpreting prose:

- `VIOLATION_DEMONSTRATED` may remain a finding.
- `NO_VIOLATION` must be withdrawn.
- `NO_BLOCKING_UNCERTAINTY` cannot remain a limitation.
- Demonstrated or inconclusive blocking uncertainty remains visible and blocks
  readiness.

Active final-candidate V3 requires an empty provider-authored `limitations`
array. Runner builds report limitations only from persisted preliminary concern
dispositions, snapshot coverage, and standards state. A verifier judgment of
`NO_BLOCKING_UNCERTAINTY` requires `RESOLVED`; demonstrated or inconclusive
blocking uncertainty requires `REMAINS`.

Final-only finding verification and deterministic projection of inconclusive
finding judgments are separate follow-up work. This decision does not add a
fourth call or claim that every post-author semantic path is verified.

Old finding-verification artifacts remain readable through their explicit V1/V2
contracts. Active runs use the new protocol, and resume rejects old/new protocol
mixing before any provider call.

## Alternatives considered

### Add another prompt sentence

Rejected as the sole fix. Existing policy already says not to invent runtime
input obligations. The model complied for findings but moved the same concern
to a limitation. Prompt clarification is useful defense in depth, not an
enforceable boundary.

### Reject phrases about validation or invalid inputs

Rejected. It is language-dependent and would suppress legitimate findings when
requirements explicitly require validation. Runner would become a code reviewer.

### Ignore all limitations when findings are empty

Rejected. Real missing evidence must still prevent a false green result.

### Verify only preliminary limitations

Rejected. It fixes the observed representation but leaves evidence gaps as an
equivalent category escape. V3 verifies both preliminary concern collections.

### Replace the current schema/validation libraries

Rejected. Zod and generated JSON Schema correctly enforced structure. No
well-supported library can decide whether a natural-language concern is within a
repository's canonical requirements. That judgment belongs to a fresh review
agent; runner owns binding and projection.

## Consequences

- Clean reviews with no adverse claims remain two provider calls.
- Reviews containing preliminary adverse claims use the already-reserved fresh
  verification call; actual cost rises only when concerns exist.
- Contract, run ledger, schemas, resume checks, and reports gain another explicit
  version boundary.
- A true limitation remains fail-closed; an unsupported limitation can no longer
  veto readiness merely by occupying a different response field.
- Final-only findings remain a documented residual gap; addressing them requires
  a separate design and budget decision.
