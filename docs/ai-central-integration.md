# AI Central integration

Source: sibling `../ai-central`, initially at `33bd2293f0682bde71938f2b2ad14a4f3289e147`. The source checkout was clean and was not pulled or modified.

## Installed context

- Profiles: `base` plus `javascript-typescript` (real project-owned AGENTS,
  repository steering, testing gates, and a machine-local language steering
  link).
- Bundles: core, orchestration, documentation, delivery, engineering, planning.
- 57 skill links under `.agents/skills/`, with `.codex/skills/` compatibility links maintained by AI Central.
- Exact local link exclusions in `.git/info/exclude`; real project guidance remains available to commit.

The engineering bundle includes some adjacent skills (browser, UI,
infrastructure) as part of its maintained selection. They are available on
demand, not mandatory workflows. No custom agent preset is selected. The
JavaScript/TypeScript profile follows the accepted TypeScript 6 and Node.js 24
runtime.

## Retained independent-review baseline

[Original skill](reference/ai-central/independent-review/SKILL.md) and its `agents/openai.yaml` metadata are copied unchanged, with the upstream license. [Provenance](reference/ai-central/provenance.json) records revision, hashes, profiles, bundles, and installed skill inventory. This copy provides a stable source for evolving the product; it is not automatically refreshed or loaded as the runtime prompt.

The installed `independent-review` skill is a live link to AI Central. Changes to that checkout appear through the link, while the retained baseline remains fixed. Never edit through shared links when intending to change only this project.

## Reproduce or refresh

The AI context setup requires Git, POSIX sh, Python 3, and an existing AI Central
checkout. It does not install application packages or require a provider key.
Application development separately requires Node.js 24 and npm.

```sh
sh scripts/setup-ai-context.sh --dry-run
sh scripts/setup-ai-context.sh
python3 -B scripts/check-ai-context.py
```

Set `AI_CENTRAL_HOME=/path/to/ai-central` to override the sibling source; its `templates` directory is also accepted. The wrapper uses AI Central's maintained non-overwriting installer, then excludes exact managed skill links locally. It does not pull the source checkout, overwrite project-owned instructions, prune skills, or refresh the retained reference.

The source checkout should use the recorded revision for exact reproduction. New upstream bundle members may be added on refresh; reconcile the recorded inventory deliberately when changing the baseline. The checker validates retained hashes, required links, compatibility paths, steering, and Git exclusions. It does not evaluate runtime review quality or assert that live source bytes still match the original revision.

To validate the source checkout:

```sh
(cd ../ai-central && ./scripts/check.sh)
```

## Runtime integration

The engine now exposes a complete local `review --request <path> --config
<path>` flow. The live AI Central skill keeps the retained reference above
unchanged, uses the external engine only when that metered disclosure is
explicitly authorized, and otherwise preserves its existing fresh-task review
workflow.
