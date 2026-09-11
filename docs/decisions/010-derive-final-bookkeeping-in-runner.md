# ADR-010: Derive final review bookkeeping in the runner

## Status

Accepted

## Date

2026-09-11

## Context

A live clean-control review produced no findings, evidence gaps, or limitations,
but returned `NOT_READY` with no blocker. Local validation correctly rejected that
contradiction. The bounded repair call then invented a blocker requiring independent
test execution even though no canonical input required it. Review conclusions were
sound; model-owned bookkeeping caused the false negative and a third paid call.

Frozen coverage, finding severity, concern disposition, and final report validation
already belong to the runner. Verdict and action classification are deterministic
projections of those values, not additional code-review judgments.

## Decision

Runner derives final bookkeeping after materializing reviewer judgments:

1. P0/P1 findings, or REQUIRED standards findings, produce `NOT_READY`; their
   corrections become blockers in stable finding order.
2. Without a blocking finding, any limitation, unresolved preliminary concern, or
   runner-owned coverage constraint produces `UNABLE_TO_VERIFY`.
3. Non-blocking finding corrections become fast follows; a non-empty set produces
   `READY_WITH_FOLLOW_UPS`. Unbound provider suggestions are discarded.
4. Otherwise verdict is `READY`.

Standards uncertainty takes precedence over REQUIRED findings because incomplete or
conflicting standards cannot support a complete standards assessment. Exact duplicate
actions are removed without rewriting their text.

Provider candidate v3 retains `verdict` and `nextActions` for wire and resume
compatibility. Runner treats them as non-authoritative, requires provider fast follows
to be empty on the wire, and discards both fields. A future candidate version may
remove them without changing persisted report v1 or CLI exit semantics.

## Alternatives considered

### Continue model repair

Rejected. Repair asks the same reviewer to reconcile deterministic fields, adds cost
and latency, and can manufacture unsupported work.

### Silently change candidate v3

Rejected. Removing required fields in place would break committed schemas and persisted
resume compatibility.

### Preserve unbound optional suggestions

Rejected. A suggestion without a validated non-blocking finding can reintroduce the
premise of an adversarially rejected finding and incorrectly change `READY` to
`READY_WITH_FOLLOW_UPS`. Reviewers still own findings, limitations, and concern
dispositions; runner derives actions only from validated findings.

## Consequences

- Clean and internally inconsistent provider candidates can complete in two calls.
- Model-authored blockers cannot turn author-reported verification into required work.
- Rejected findings cannot survive as unbound optional follow-ups.
- Report validation remains the final guard over evidence and reconciliation semantics.
- Candidate v3 carries temporary redundant fields until a deliberate protocol upgrade.
