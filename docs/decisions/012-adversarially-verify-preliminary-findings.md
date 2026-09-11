# ADR-012: Adversarially verify preliminary findings before author disclosure

## Status

Accepted

## Date

2026-09-11

## Context

Focused evidence and deterministic bookkeeping improved review completeness, but
the same reviewer still re-evaluated its own preliminary findings during final
reconciliation. That reviewer remained anchored to plausible-sounding false
positives, especially when a scenario depended on inputs outside the canonical
valid domain. Author context could challenge the finding, but it should not be
needed to make the review test its own claim against already-frozen evidence.

Whether a finding is supported remains a review judgment. Encoding language- or
framework-specific defect heuristics in the runner would move code review into
bookkeeping and make the general tool brittle.

## Decision

After persisting a non-empty preliminary assessment, orchestration makes one
fresh blind finding-verification call. It receives the same frozen blind evidence
and an ordered projection of the persisted preliminary findings, but no author
packet, prior reviewer conversation, or finding IDs. It cannot add findings.

Verifier returns one ordered `CONFIRMED`, `REJECTED`, or `INCONCLUSIVE` judgment
with a concise rationale for each input finding. It must try to falsify the finding
against canonical inputs, selected rules, changed evidence, and stated valid-input
domains. Provider schema fixes judgment count. Runner binds each judgment to its
frozen finding ID by position and fails closed on a count mismatch before author
disclosure. Provider never reproduces identity bookkeeping.

The verification artifact is persisted before `AUTHOR_DELIVERED`. Final
reconciliation receives it, and runner semantics require every `REJECTED`
preliminary finding to be withdrawn. A locally invalid final candidate retains
the existing single bounded final-repair opportunity.

When preliminary findings are empty, runner writes an empty verification artifact
without a provider call. Admission still reserves the possible verification call,
the final call, and one provider retry before spending on call one. A final-stage
resume revalidates and reuses the persisted verification artifact.

## Alternatives considered

### Ask the original reviewer to self-check in the final prompt

Rejected. Existing reconciliation already did this and remained anchored to the
preliminary claim.

### Implement deterministic defect heuristics in the runner

Rejected. Runner should enforce identities, scope, ordering, and exact ledgers;
agents should judge code semantics. Heuristics would overfit languages and move
review responsibility into product code.

### Verify after author reconciliation

Rejected. Author claims would contaminate the independent challenge, and a late
rejection would require another reconciliation turn or runner-authored judgment.

### Always make the verification call

Rejected. An empty preliminary finding set has nothing to challenge. Persisting
an empty runner-owned ledger preserves lifecycle and resume invariants at no
provider cost.

## Consequences

- Finding-bearing reviews normally use three provider calls; clean reviews remain
  two calls.
- False-positive resistance gains an independent, author-blind challenge step.
- Worst-case preflight reservation increases even when a clean run later skips
  the selective call.
- Verification failure remains visible and cannot silently become a clean report.
- Duplicate or missing provider-authored finding IDs are structurally impossible;
  finding identity, completeness, and ordering remain runner-owned.
- Verification does not discover missed defects; broader recall still depends on
  review units, evidence quality, and later evaluation.
