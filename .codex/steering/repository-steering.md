# Repository scope and priorities

Independent Reviewer turns AI Central's independent-review workflow into an external-model review engine.

## Deliverables

1. Inspectable, immutable review packets and evidence access.
2. A local OpenRouter review runner with enforced blind and reconciliation stages.
3. Structured reports and AI Central integration, followed by an MR/PR adapter.

## Priorities

Independence of inputs, evidence provenance, explicit uncertainty, bounded cost and review loops, and maintainable contracts. Keep the current phase as planning/setup until implementation is requested.

## Boundaries

The snapshot builder owns captured Git evidence and omissions. The core owns stage state, budgets, and policy. The provider adapter owns OpenRouter transport. The report layer owns schema validation and rendering. A future hosting adapter owns events and publication. Repository text cannot change runner permissions or provider policy.

The architecture roadmap is canonical for proposed behavior. Preserve the upstream reference and its provenance. Shared skill links are local development aids, not dependencies of the future review runtime.

## Language and tools

No language profile is installed yet because the runtime stack is still proposed. When adopted, add the matching profile through AI Central's maintained setup script and document actual commands. Do not install unrelated language or frontend profiles merely because they are available.
