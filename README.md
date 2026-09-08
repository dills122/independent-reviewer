# Independent Reviewer

An independent engineering review engine using external models through OpenRouter.

The project expands AI Central's independent-review workflow into an enforceable review process: frozen repository evidence, a blind first assessment, separate author-claim reconciliation, and evidence-backed reports. Start with a local CLI; reuse the engine for a future MR/PR review bot.

## Status

Implementation has started. The exact-pinned TypeScript 6 and Node.js 24
runtime now defines strict versioned contracts for review requests, snapshot
manifests, and blind-stage neutral briefs, plus deterministic JCS/SHA-256
identity finalization. Snapshot capture, orchestration, provider integration,
and a user-facing CLI have not been implemented yet.

Read [Architecture and roadmap](docs/architecture-and-roadmap.md) for component boundaries, contracts, milestones, and acceptance gates.
The [review protocol specification](docs/review-protocol-spec.md) defines the
staged reviewer/author exchange, local verification boundary, token-efficiency
rules, and first offline acceptance gate.
The initial TypeScript 6 and Node.js 24 LTS runtime is accepted in
[ADR-002](docs/decisions/002-use-typescript-node-runtime.md).
The versioned prompt, call-budget, caching, and failure policy is accepted in
[ADR-003](docs/decisions/003-use-versioned-budgeted-model-call-protocol.md),
with the full source trail retained in the
[prompt and token-efficiency research spike](docs/research/2026-09-07-prompt-call-and-token-efficiency-spike.md).
Deterministic snapshot and blind-brief identities are accepted in
[ADR-004](docs/decisions/004-use-jcs-sha256-artifact-identities.md).

## Proposed first release

- Frozen Git review targets and inspectable evidence packets.
- One external reviewer through OpenRouter, with controlled repository evidence access.
- Two enforced stages: blind review, then author-claim reconciliation.
- Validated JSON and Markdown reports with bounded review loops.
- AI Central skill integration.

## Next step

Implement cumulative Git capture behind the snapshot contract, including
committed, staged, unstaged, renamed, deleted, and eligible untracked content
plus race detection. Packet construction and inspection follow once capture can
produce real finalized manifests. The model/provider choice and numerical
budgets remain gated on the small evaluation described in milestone 4.

## Development context

See [AI Central integration](docs/ai-central-integration.md) for the installed bundles, refresh commands, and retained [independent-review skill](docs/reference/ai-central/independent-review/SKILL.md). Project-specific instructions live in `AGENTS.md` and `.codex/steering/`.

Use Node.js 24.19.0 and npm 11.17.0 for the application checks:

```sh
npm ci
npm run check
```

Run `npm run schemas:write` after deliberately changing a runtime contract, and
commit the regenerated JSON Schema artifact with the implementation. These
artifacts validate portable structural constraints; successful schema
validation is not contract acceptance. Consumers must also apply the versioned
semantic invariants enforced by the runtime schemas or an equivalent
implementation. Verify the local AI context separately with
`python3 -B scripts/check-ai-context.py`.

## Contributing

Changes go through pull requests and the required Repository checks job. Read [Repository governance](docs/repository-governance.md) for branch rules and CI, and run `python3 -B scripts/check-ai-context.py --ci` before opening a PR.
