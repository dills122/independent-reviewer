# Independent Reviewer

Independent engineering review engine using external models through OpenRouter.
It freezes a Git changeset, sends bounded diff and supporting context, persists a
blind assessment, challenges preliminary findings, then reconciles author context
into validated JSON and Markdown reports.

The current product is a local TypeScript/Node.js CLI. A future hosting adapter can
reuse the same engine for pull-request and merge-request review.

## Status

First local release is implemented and exercised with offline and paid E2E
fixtures. It supports cumulative committed, staged, unstaged, and selected
untracked changes; language-neutral file-level context; Tree-sitter enrichment
for JavaScript, TypeScript, Python, Go, and Java; bounded OpenRouter routing and
spend; durable run records; and fail-closed report validation.

This remains pre-release software. Review output is evidence for engineering
judgment, not proof of correctness or deployment readiness.

## Quick start

Requirements:

- Git
- Node.js 24
- npm 11 (the exact package manager version is recorded in `package.json`)
- OpenRouter API key for live runs only

Install and build:

```sh
git clone https://github.com/dills122/independent-reviewer.git
cd independent-reviewer
npm ci
npm run build
```

Create a non-empty author overview for the change, then save review settings for
the target repository:

```sh
node dist/src/cli.js init \
  --repo /path/to/target-repository \
  --config "$PWD/examples/review-config.gpt-oss-120b.json" \
  --standards "$PWD/examples/standards.javascript-typescript.json" \
  --author /absolute/path/to/author-overview.md
```

The bundled standards profile is an example for JavaScript and TypeScript, not a
product limitation. Copy and adapt its `paths` and rules for the languages and
standards used by your project.

Check exact scope and conservative admission without credentials or provider
calls:

```sh
node dist/src/cli.js review \
  --repo /path/to/target-repository \
  --base main \
  --dry-run
```

For a live run, keep the key in an ignored `.env` file:

```dotenv
OPENROUTER_API_KEY=replace-with-your-key
```

Then let Node load it without sourcing or printing the file:

```sh
node --env-file=.env dist/src/cli.js review \
  --repo /path/to/target-repository \
  --base main
```

Use the actual base ref for your changes. Live reports default to
`<target-repository>/.review-runs/<snapshot-id>/review/report.md`.

Read the [setup and usage guide](docs/user-guide.md) before using custom rules,
privacy restrictions, requirements mode, retries, or retained artifacts.

## Commands

| Command | Purpose | Provider call |
| --- | --- | --- |
| `init` | Validate and save Git-local standards review settings | No |
| `review --dry-run` | Capture temporarily and check scope, routing, tokens, and cost admission | No |
| `review` | Capture and run blind review, optional finding verification, and reconciliation | Yes |
| `prepare` | Persist a requirements-mode packet for inspection | No |
| `inspect` | Validate and summarize a persisted packet | No |
| `resume-final` | Retry one eligible final-stage provider failure | Yes |

Run `node dist/src/cli.js --help` or
`node dist/src/cli.js <command> --help` for exact options.

## How it protects review independence

- Freezes target evidence before review and identifies every artifact by digest.
- Withholds author explanation until a blind preliminary assessment is persisted.
- Uses a fresh author-blind verifier when preliminary findings exist.
- Treats source, documentation, author text, and provider output as untrusted data.
- Binds findings to transmitted paths, sides, coordinates, symbols, and selected rules.
- Keeps coverage, identity, verdict actions, and verification bookkeeping in runner code.
- Preserves exclusions, missing evidence, malformed responses, and unknown cost as visible uncertainty.
- Stores packets and raw responses privately under `.review-runs`, which must remain ignored.

See [Architecture and roadmap](docs/architecture-and-roadmap.md) and the
[review protocol specification](docs/review-protocol-spec.md) for full design and
trust boundaries.

## Documentation

- [Setup and usage guide](docs/user-guide.md)
- [Architecture and roadmap](docs/architecture-and-roadmap.md)
- [Review protocol specification](docs/review-protocol-spec.md)
- [Repository governance](docs/repository-governance.md)
- [Bug reporting](docs/bug-reporting.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

Versioned portable schemas live in [`schemas/`](schemas/). They validate
structural constraints; runtime validation also enforces semantic invariants.

## Development

Install the exact dependency graph and run all application gates:

```sh
npm ci
npm run check
python3 -B scripts/check-ai-context.py --ci
```

Run `npm run schemas:write` after deliberately changing a runtime contract and
commit the regenerated schema with its implementation and tests. Do not edit the
retained upstream reference under `docs/reference/ai-central/` or shared skill
links under `.agents/skills/` and `.codex/skills/`.
