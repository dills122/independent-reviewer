# Contributing

Contributions use GitHub issues and pull requests. Keep reports and changes
focused, reproducible, and free of credentials or private review material.

## Report a problem

Read [Reporting bugs and unexpected behavior](docs/bug-reporting.md), then use
the repository's structured bug form. It explains required Git identities,
changeset replay options, environment details, and safe diagnostics.

Report suspected vulnerabilities privately according to
[the security policy](SECURITY.md), not in a public issue.

## Propose a change

Discuss material behavior or architecture changes in an issue before investing
in a large patch. Keep implementation and affected contracts or documentation
together. Do not edit the retained upstream reference under
`docs/reference/ai-central/` or the shared skill links under `.agents/skills/`
and `.codex/skills/` as a shortcut.

Use a feature branch and a pull request; do not commit directly to `main`. Read
[Repository governance](docs/repository-governance.md) for branch protections
and merge rules.

Install and check the exact dependency graph with Node.js 24:

```sh
npm ci
npm run check
python3 -B scripts/check-ai-context.py --ci
```

Run `npm run schemas:write` after a deliberate runtime-contract change and
include the regenerated schema. Run
`python3 -B scripts/check-ai-context.py` without `--ci` when changing local AI
Central integration metadata, references, or setup scripts.

In the pull request, describe the problem, approach, test evidence, limitations,
and any behavior or contract changes. Link the issue when one exists.
