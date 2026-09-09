# Independent Reviewer

An independent engineering review engine using external models through OpenRouter.

The project expands AI Central's independent-review workflow into an enforceable review process: frozen repository evidence, a blind first assessment, separate author-claim reconciliation, and evidence-backed reports. Start with a local CLI; reuse the engine for a future MR/PR review bot.

## Status

The first local release is implemented. The exact-pinned TypeScript 6 and Node.js
24 runtime captures frozen Git evidence, enforces blind and reconciliation
stages, validates provider output and frozen evidence coordinates, and writes
private JSON, presentation-safe Markdown, and append-only run-attempt artifacts.
It rejects an insufficient conservative token reservation before making a
provider call and retains that reservation when provider usage is unavailable.
OpenRouter use remains explicit and metered: callers select the model
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

Run `independent-reviewer --help` for the command list, or
`independent-reviewer <command> --help` for one command's options. Options accept
both `--flag value` and `--flag=value`; a repeated flag is rejected rather than
silently taking the last one.

Use `--base <ref>` to override base resolution and `--output <new-directory>`
to choose the packet directory. Packets default to `<repository root>/.review-runs/<snapshot-id>`,
not a path relative to the current directory. `prepare` never overwrites an
existing packet. It stores the manifest, canonical inputs, optional author
packet, and captured blobs as separate private files. `inspect --json` prints a versioned
[`InspectionReportV1`](schemas/inspection-report-v1.schema.json) — snapshot
manifest, canonical inputs, blob count, config reference, and
`authorPacketPresent`. The author packet's *existence* is reported; its content
never is. The human-readable view is rendered from the same validated report. The request fixture and schema show the current input
shape.

Packet directories are always excluded from capture, so a previous run's blobs
and author packet never become evidence for the next review. If the packet
directory is inside the reviewed worktree and is not ignored by Git, `prepare`
and `review` warn — add it to `.gitignore`.

Capture defaults to a 512 KiB per-file limit. The following are excluded
visibly rather than silently transmitted:

- **Credential filenames and directories** — `.env` and `.env.*`, `.netrc`,
  `.npmrc`, `.pypirc`, `.dockercfg`, `.git-credentials`, `.htpasswd`,
  `.pgpass`, `credentials`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`,
  `terraform.tfvars`, `service-account*`, `secrets.y[a]ml`, the extensions
  `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore`, `.ppk`, `.kdbx`,
  `.tfstate`, and anything under `.ssh/`, `.aws/`, `.gnupg/`, or `.docker/`.
- **Credential content** — files containing a PEM or PGP private key block, an
  AWS access key id, a GitHub, Slack, Google, or OpenAI-style API key, reported
  as `SECRET_CONTENT`. Detection is marker-based, not exhaustive: it is a
  backstop, not a guarantee that nothing sensitive is transmitted.
- **Caller patterns** — `--exclude '<glob>[,<glob>]'` matches
  repository-relative paths, where `*` stays within a path segment and `**`
  crosses segments.
- Oversized files, submodules, and unsupported entry kinds.

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
[`schemas/review-run-config-v2.schema.json`](schemas/review-run-config-v2.schema.json),
which the runtime requires: `schemaVersion: 2`, a `providerRouting` block, and
budgets including the local spend ceiling `maxTotalCostUsd`.
The command prints the final report path. The adjacent `run-record.jsonl`
records prompt/schema and provider-policy versions, stage-input and
credential-free wire-request digests, exact wire-body digest and byte count,
timings, validated returned routing and usage data, sanitized failures, and
terminal state without storing API keys, wire bodies, or model-bound message
content. Exit `0` means `Ready` or `Ready with
non-blocking follow-ups`, `2` means `Not ready`, `3` means `Unable to verify`,
and `4` means the provider submission became transport-uncertain. Other input
or execution failures use exit `1`. Request and config control files are
excluded from captured review evidence even when placed inside the worktree.

If the final stage fails with a definite provider error, the one permitted retry
reuses the persisted blind assessment and the exact same configuration rather
than buying a second preliminary review:

```sh
node dist/src/cli.js resume-final \
  --packet ./.review-runs/<snapshot-id> \
  --config ./review-config.json
```

A resume is refused when the run did not reach a resumable failed final stage,
when the configuration does not match the one the run started with, when the
final outputs already exist, or when the single permitted resume has already
been claimed. A transport-uncertain submission (exit `4`) is never resumed: the
request may have been billed and its outcome is unknown.

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
