# Independent Reviewer

Independent engineering review engine using external models through OpenRouter.
It freezes a Git changeset, sends bounded diff and supporting context, persists a
blind assessment, challenges preliminary adverse claims, then reconciles author
context into validated JSON and Markdown reports.

The current product is a local TypeScript/Node.js CLI. A future hosting adapter can
reuse the same engine for pull-request and merge-request review.

## Status

First local release is implemented and exercised with offline and paid E2E
fixtures. It supports cumulative committed, staged, unstaged, and selected
untracked changes; language-neutral file-level context; Tree-sitter enrichment
for JavaScript, TypeScript, Python, Go, and Java; bounded OpenRouter routing and
spend; durable run records; and fail-closed report validation.
Simple settings reduce initial configuration to model and maximum cost. An
optional BASE-owned `.independent-reviewer/rules.md` supplies highest-priority
review guidance. The same frozen-BASE discovery now understands repository
guidance used by Codex, Claude, Gemini, Kiro, GitHub Copilot, and Cursor.
Digest-bound source windows give reviewers bounded context around changed lines.

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

Save simple review settings for the target repository:

```sh
node dist/src/cli.js init \
  --repo /path/to/target-repository \
  --model openai/gpt-oss-120b \
  --max-cost 0.05
```

Create a non-empty Markdown author overview for the change. Automatic repository
guidance discovery is active; interactive author collection is not yet shipped,
so the simple flow still takes an explicit standards profile and author file.
The bundled profile is an example, not a product language limitation.

Check exact scope and conservative admission without credentials or provider
calls:

```sh
node dist/src/cli.js review \
  --repo /path/to/target-repository \
  --base main \
  --standards "$PWD/examples/standards.javascript-typescript.json" \
  --author /absolute/path/to/author-overview.md \
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
  --base main \
  --standards "$PWD/examples/standards.javascript-typescript.json" \
  --author /absolute/path/to/author-overview.md
```

Repository guidance is selected from the frozen BASE tree, never from an
untrusted HEAD-only addition. Supported sources include ancestor
`AGENTS.md`/`AGENTS.override.md` and `CLAUDE.md`; Gemini context files; Kiro
steering; Copilot repository and path-scoped instructions; Cursor project rules;
and optional `.independent-reviewer/rules.md`. Matching and import behavior is
family-specific, bounded, secret-checked, and fail-closed. See
[Repository guidance discovery](docs/user-guide.md#repository-guidance-discovery)
for exact supported locations and exclusions.

Use the actual base ref for your changes. Live reports default to
`<target-repository>/.review-runs/<snapshot-id>/review/report.md`.

Read the [setup and usage guide](docs/user-guide.md) before using custom rules,
privacy restrictions, requirements mode, retries, or retained artifacts.

## Current boundaries

- Local, source-built CLI; no package-registry release or hosted PR bot yet.
- Static review of captured evidence; provider cannot run repository tests or
  request arbitrary files.
- Standards and author files remain explicit inputs in the simple flow until
  interactive author collection ships.
- Dedicated guidance lint and budget-inspection UX remains planned; dry-run
  already enforces pre-call secret, byte, token, and cost admission.

## Commands

| Command | Purpose | Provider call |
| --- | --- | --- |
| `init` | Validate and save Git-local standards review settings | No |
| `config show` | Show saved simple settings or resolved runtime policy | No |
| `review --dry-run` | Capture temporarily and check scope, routing, tokens, and cost admission | No |
| `review` | Capture and run blind review, selective adverse-claim verification, and reconciliation | Yes |
| `prepare` | Persist a requirements-mode packet for inspection | No |
| `inspect` | Validate and summarize a persisted packet | No |
| `resume-final` | Retry one eligible final-stage provider failure | Yes |

Run `node dist/src/cli.js --help` or
`node dist/src/cli.js <command> --help` for exact options.

## How it protects review independence

- Freezes target evidence before review and identifies every artifact by digest.
- Withholds author explanation until a blind preliminary assessment is persisted.
- Uses a fresh author-blind verifier when preliminary findings, evidence gaps,
  or limitations exist.
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

Bundled examples:

- [`examples/review-config.gpt-oss-120b.json`](examples/review-config.gpt-oss-120b.json): availability-oriented advanced OpenRouter policy.
- [`examples/review-config.pinned-endpoint.json`](examples/review-config.pinned-endpoint.json): deliberately pinned diagnostic policy with reduced failover.
- [`examples/standards.javascript-typescript.json`](examples/standards.javascript-typescript.json): example JavaScript/TypeScript standards profile, not a language limit.

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
