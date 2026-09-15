# ADR-020: Derive finding verification from structured checks

## Status

Accepted

## Date

2026-09-15

## Context

Finding-verification V3 asked a fresh model for one opaque status and rationale.
Its policy already rejected invented obligations, scenarios outside a stated
input domain, and factually unsupported behavior. A paid clean control still
returned `VIOLATION_DEMONSTRATED` for page zero when requirements explicitly
limited pagination to positive pages, and repeated an incorrect claim about
JavaScript `Array.slice` behavior. Final projection therefore created a false P1
blocker.

A further prompt sentence cannot enforce consistency. Natural-language semantic
classification still requires reviewer judgment, but runner can require reviewer
to expose independent premises needed for a demonstrated violation.

## Decision

Active finding verification uses candidate V4. For every preliminary finding,
provider returns three ordered checks without a final status:

- whether claimed obligation is applicable;
- whether concrete scenario is inside stated input domain, outside it, unrelated
  to runtime inputs, or undetermined; and
- whether claimed behavior is supported, refuted, or not established by frozen
  evidence and correct language/runtime semantics.

Runner derives persisted status:

- absent/inapplicable obligation, out-of-scope scenario, or refuted behavior
  becomes `NO_VIOLATION`;
- applicable obligation plus in-scope or input-independent scenario plus
  supported behavior becomes `VIOLATION_DEMONSTRATED`; and
- every remaining combination becomes `INCONCLUSIVE`.

Concern judgments retain V3 semantics. Runner continues to bind ordered results
to frozen finding and concern identities. Active resume requires exact V4 schema
and policy versions; V1-V3 artifacts remain readable through exported contracts
but cannot resume as V4 work.

## Consequences

- Provider cannot emit a demonstrated-violation label that contradicts its own
  explicit obligation, scope, or behavior checks.
- Exact case 005 regression proves out-of-domain or factually refuted premises
  become `NO_VIOLATION` and must be withdrawn from final report.
- Model can still classify an individual premise incorrectly. Paid promotion
  therefore still requires separately authorized semantic canary; structured
  derivation reduces inconsistency but does not make natural-language review
  deterministic.
- Candidate and persisted JSON schemas gain V4 artifacts; cost admission includes
  larger schema and response shape before first provider call.

## Alternatives considered

### Add another prompt warning

Rejected as sole fix because V3 already contained exact rule model violated.

### Detect validation phrases in prose

Rejected because text matching would suppress legitimate explicit validation
requirements and make runner perform unreliable semantic review.

### Execute arbitrary examples during verification

Rejected for this fix because isolated execution is not yet qualified and many
findings are not executable. Named checks remain separate work.
