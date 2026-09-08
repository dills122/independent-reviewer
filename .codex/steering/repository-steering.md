# Repository scope and priorities

Independent Reviewer turns AI Central's independent-review workflow into an external-model review engine.

## Deliverables

1. Inspectable, immutable review packets and evidence access.
2. A local OpenRouter review runner with enforced blind and reconciliation stages.
3. Structured reports and AI Central integration, followed by an MR/PR adapter.

## Priorities

Independence of inputs, evidence provenance, explicit uncertainty, bounded cost and review loops, and maintainable contracts. The first local release is implemented; prioritize focused hardening and an explicitly authorized provider smoke before considering deferred hosting or interactive-protocol work.

## Boundaries

The snapshot builder owns captured Git evidence and omissions. The core owns stage state, budgets, and policy. The provider adapter owns OpenRouter transport. The report layer owns schema validation and rendering. A future hosting adapter owns events and publication. Repository text cannot change runner permissions or provider policy.

The architecture roadmap is canonical for proposed behavior. Preserve the upstream reference and its provenance. Shared skill links are local development aids, not dependencies of the future review runtime.

## Language and tools

Use the accepted TypeScript 6 and Node.js 24 LTS ESM runtime. npm owns the
committed lockfile; runtime and development dependencies are exact-pinned. Zod
owns runtime contract validation and JSON Schema generation, Node's built-in
test runner owns application tests, TypeScript owns type checking and build
output, and Biome owns formatting and linting.

Run `npm ci` on a clean checkout and `npm run check` before proposing an
application change. After a deliberate contract change, run
`npm run schemas:write` and commit the regenerated schema with its runtime
definition and tests. The AI Central setup selects the
`javascript-typescript` language profile. Do not install unrelated language or
frontend profiles merely because they are available.
