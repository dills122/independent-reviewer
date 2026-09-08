# Independent Reviewer

An independent engineering review engine using external models through OpenRouter.

The project expands AI Central's independent-review workflow into an enforceable review process: frozen repository evidence, a blind first assessment, separate author-claim reconciliation, and evidence-backed reports. Start with a local CLI; reuse the engine for a future MR/PR review bot.

## Status

The first local release is implemented. The exact-pinned TypeScript 6 and Node.js
24 runtime captures frozen Git evidence, enforces blind and reconciliation
stages, validates provider output, and writes private JSON and Markdown review
artifacts. OpenRouter use remains explicit and metered: callers select the model
and budgets and provide the API key only through the environment.

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

## Local CLI

Build, prepare a request, and inspect the resulting packet:

```sh
npm run build
node dist/src/cli.js prepare --request ./request.json
node dist/src/cli.js inspect --packet ./.review-runs/<snapshot-id>
```

Use `--base <ref>` to override base resolution and `--output <new-directory>`
to choose the packet directory. `prepare` never overwrites an existing packet.
It stores the manifest, canonical inputs, optional author packet, and captured
blobs as separate private files. `inspect --json` prints the validated neutral
snapshot material but only reports whether a separate author packet exists.
The request fixture and schema show the current input shape.

Capture defaults to a 512 KiB per-file limit. Secret-like basenames (`.env`,
`.env.*`, `*.pem`, and `*.key`), oversized files, submodules, and unsupported
entry kinds are excluded visibly rather than silently transmitted.

Run the complete two-stage review with a request containing a separate author
packet and a config matching its `reviewConfigRef`:

```sh
export OPENROUTER_API_KEY='<set outside repository files>'
node dist/src/cli.js review \
  --request ./request.json \
  --config ./review-config.json \
  --output ./.review-runs/my-review
```

The review config schema is
[`schemas/review-run-config-v1.schema.json`](schemas/review-run-config-v1.schema.json).
The command prints the final report path. Exit `0` means `Ready` or `Ready with
non-blocking follow-ups`, `2` means `Not ready`, `3` means `Unable to verify`,
and `4` means the provider submission became transport-uncertain. Other input
or execution failures use exit `1`. Request and config control files are
excluded from captured review evidence even when placed inside the worktree.

## Later scope

The GitHub/GitLab adapter, arbitrary local verification workers, provider
fallback, and broader model evaluation remain deferred until requested.

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
