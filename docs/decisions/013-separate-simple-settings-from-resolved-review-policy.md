# ADR-013: Separate simple user settings from resolved review policy

## Status

Accepted

## Date

2026-09-11

## Context

The shipped CLI exposes the complete review-run configuration to ordinary users.
That contract correctly controls model routing, privacy, evidence size, token and
cost admission, retries, pacing, timeouts, and provider behavior, but those are
engine concerns. A first-time user normally wants to select a review model, set a
maximum spend, identify project guidance, and explain the change being reviewed.

Making every internal limit a required user decision increases setup cost and
encourages unsafe combinations. Replacing the strict internal contract would lose
deterministic admission, resume compatibility, and auditability. Repository-owned
configuration from the proposed change also cannot be allowed to silently change
credentials, routing, or paid-call limits.

## Decision

Provide a small versioned user-settings surface that resolves into the existing
strict review-run policy before packet preparation or provider access. Normal
settings contain:

- selected supported model profile;
- maximum cost per review;
- whether author explanation is required, defaulting to `true`; and
- whether repository steering discovery is enabled, defaulting to `true`.

`init` stores these selections in Git-local state outside the reviewed tree.
Explicit CLI values override local selections, which override versioned engine
defaults. Credentials remain environment-only. Repository content cannot alter
paid-call policy.

The engine owns safe defaults for routing, privacy posture, token allocation,
evidence limits, output limits, pacing, timeouts, retries, and repairs. Each
supported model profile binds the metadata needed to resolve those defaults.
An unrecognized model cannot guess pricing or capabilities; it requires an
explicit advanced configuration until a supported profile exists.

The complete JSON review-run configuration remains supported for automation,
diagnosis, and advanced control. It is no longer the primary onboarding path.
`config show` presents user choices and their provenance; `config show
--resolved` presents the complete effective policy and digest.

Author explanation remains part of the normal two-stage flow. Interactive and
non-interactive entry points collect it before submission, store it separately,
and withhold it until reconciliation. A user may explicitly opt out with
`--no-author` or the corresponding setting. The CLI warns before spending.

New friendly-review contract versions represent author context as a required
discriminated state rather than an optional missing file:

- `PROVIDED` binds the digest of a separate author artifact;
- `DECLINED` binds the digest of a canonical versioned declined marker and
  forbids an author artifact.

Local inspection may show this state, but blind review and finding verification
receive neither author content nor author-presence status. After preliminary
persistence and any finding verification, one versioned
`AUTHOR_CONTEXT_RELEASED` transition exposes the supplied artifact or declined
marker to final reconciliation. A declined report records a typed, runner-owned
`authorContext` value with `status: DECLINED` and
`noteCode: AUTHOR_CONTEXT_DECLINED`, plus an empty author-claim ledger. The
renderer explains that no author claims were evaluated. This note is not a
formal `limitation`: author absence alone neither blocks `READY` nor forces
`UNABLE_TO_VERIFY`. Findings, coverage, unresolved preliminary concerns, and
formal limitations continue to determine the verdict.

Resume requires matching request, packet, prompt, result, and run-record
versions plus the same author status and digest. Existing request versions keep
their current behavior. Old and new lifecycle artifacts cannot be mixed or
silently upgraded. Detailed evidence and lifecycle rationale are retained in
the [steering and author-absence research](../research/2026-09-11-steering-and-author-absence-contract.md).

## Alternatives considered

### Keep one complete public configuration

Rejected as the default. It preserves flexibility but makes normal users manage
protocol internals and creates many invalid combinations.

### Allow repository configuration to control execution

Rejected. A reviewed branch must not increase spending, weaken privacy, or change
provider routing. Repository Markdown may guide review judgment, but it remains
untrusted evidence rather than execution policy.

### Remove advanced configuration

Rejected. CI, provider qualification, incident diagnosis, and unsupported model
experiments still need the full explicit contract.

## Consequences

- First use normally requires only model and maximum cost choices.
- Strict resolved configuration, conservative admission, and resume identity
  remain unchanged below the user interface.
- Supported model profiles become a versioned product surface and require tests.
- Advanced users retain every current control without burdening normal setup.
- Existing saved settings and explicit JSON invocations need a documented
  compatibility and migration path.
- Explicit author absence requires new digest-bound request, packet, event, and
  report versions; existing artifacts remain readable under their original
  contracts.
