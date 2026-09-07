# ADR-001: Use an orchestrator-mediated staged external review

## Status

Proposed

## Date

2026-09-07

## Context

The existing independent-review workflow obtains useful independence by giving
a fresh reviewer neutral repository evidence before giving it the implementing
agent's explanation. The product must preserve that sequence while using a
metered remote model, bounded evidence access, local verification, resumable
runs, and no inherited implementation conversation.

Prompt instructions alone cannot prove that author content was withheld, that a
preliminary assessment existed before reconciliation, or that a retry resumed
without leaking later-stage context. Direct agent-to-agent conversation also
makes review limits, evidence disclosure, and cost difficult to audit.

## Decision

Place a local review orchestrator between the implementation side and one fresh
external reviewer conversation.

The implementation side may submit the neutral review material and author
packet in one invocation. The orchestrator stores them as separately typed
artifacts, sends only neutral material during the blind stage, validates and
persists an immutable preliminary assessment, and then sends the author packet
to the same reviewer conversation.

The orchestrator brokers bounded snapshot evidence, configured local
verification, and no more than three post-explanation author ask-backs. It
enforces token, cost, tool, time, and review-instance limits. Exhausted limits or
incomplete evidence remain visible and cannot become a successful verdict.

## Alternatives considered

### Send everything in one model request

This is simpler and uses fewer protocol turns, but the author explanation can
anchor the review before an independent assessment exists. Prompt-delimited
sections do not create a real visibility boundary.

### Let the reviewer communicate directly with the implementing agent

This resembles the manual skill experience, but it risks implementation-history
leakage and makes author rounds, transmitted evidence, and cost harder to
control. The orchestrator can preserve the conversational experience while
enforcing the boundary.

### Use separate blind and reconciliation reviewers

This provides fresh contexts but loses the valuable requirement that the
reviewer account for changes to its own preliminary judgment. It also increases
metered usage and creates an additional adjudication problem.

### Use a second local agent for verification

An agent can choose and interpret commands, but that adds another model context,
cost, and source of judgment. A deterministic local executor for configured
named checks is narrower, cheaper, and easier to audit.

## Consequences

- Independence and author withholding become testable software properties.
- Resume requires durable state rather than reconstruction from model history.
- Preliminary and final findings can be reconciled explicitly.
- Token efficiency can be governed through deterministic initial context and
  progressive bounded evidence access.
- The protocol requires more than one provider turn and local artifact
  persistence.
- Provider conversation continuity becomes useful but cannot be the sole source
  of state.
- A separate verification isolation design is still needed for repositories
  whose dependencies cannot safely run in a disposable snapshot.

See [`docs/review-protocol-spec.md`](../review-protocol-spec.md) for the detailed
contract and acceptance criteria.
