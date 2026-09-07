# Independent Reviewer

An independent engineering review engine using external models through OpenRouter.

The project expands AI Central's independent-review workflow into an enforceable review process: frozen repository evidence, a blind first assessment, separate author-claim reconciliation, and evidence-backed reports. Start with a local CLI; reuse the engine for a future MR/PR review bot.

## Status

Architecture and planning. No CLI or API integration has been implemented yet.

Read [Architecture and roadmap](docs/architecture-and-roadmap.md) for component boundaries, contracts, milestones, and acceptance gates.

## Proposed first release

- Frozen Git review targets and inspectable evidence packets.
- One external reviewer through OpenRouter, with controlled repository evidence access.
- Two enforced stages: blind review, then author-claim reconciliation.
- Validated JSON and Markdown reports with bounded review loops.
- AI Central skill integration.

## Next step

Settle the initial stack, snapshot scope, and model/budget configuration, then implement the contracts and packet builder described in milestone 1.

## Development context

See [AI Central integration](docs/ai-central-integration.md) for the installed bundles, refresh commands, and retained [independent-review skill](docs/reference/ai-central/independent-review/SKILL.md). Project-specific instructions live in `AGENTS.md` and `.codex/steering/`.

Verify the local setup with `python3 -B scripts/check-ai-context.py`. Application implementation and runtime tests have not started.
