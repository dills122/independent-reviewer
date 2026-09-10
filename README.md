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

## Standards review

Standards mode reviews code quality against selected rules, preserving the
independent first assessment and separate author reconciliation. Supply a
standards profile and an author/agent overview upfront. A business requirements
document or implementation plan is not needed. Bug hunting, fuzzing and test
execution are outside this mode.

Build with `npm ci` and `npm run build`. Using paths to your own repository,
selected review config, profile and overview:

```sh
node dist/src/cli.js init --repo /path/to/repository \
  --config /path/to/review-config.json \
  --standards /path/to/standards.json \
  --author /path/to/author-overview.md
node dist/src/cli.js review --repo /path/to/repository --base main --dry-run
node dist/src/cli.js review --repo /path/to/repository --base main
```

Choose the actual base ref for your branch. `init` saves absolute input paths in
Git-local settings and refuses to overwrite existing settings. Linked worktrees
use their Git-resolved settings location. Flags override saved settings. The
live command requires `OPENROUTER_API_KEY` in the environment; initialization and
dry-run neither read credentials nor submit provider calls. Dry-run shows scope
counts, routing and conservative token/cost admission, then removes its temporary
packet. Reservations are not confirmed charges.

Skip initialization by passing `--standards`, `--author` and `--config` directly
to `review`. The [example profile](examples/standards.javascript-typescript.json)
contains advisory JavaScript/TypeScript rules; select or customize rules to match
your project. The [GPT-OSS 120B example config](examples/review-config.gpt-oss-120b.json)
is the budget baseline: a 16,384-token output allowance, a 240,000 total-token
and $0.20 per-review ceiling, open provider routing with CoreWeave and DeepInfra
preferred, and GLM 5.3 Flash then DeepSeek V4 Flash as fallback models.
The [pinned example](examples/review-config.pinned-endpoint.json) shows the
diagnostic shape — one endpoint, no failover, both privacy filters on — and is
not how an ordinary review should run.
Kimi K2.5 remains the directly benchmarked value challenger, with GPT-5.2 and
Claude Opus 4.6 as premium quality controls; none becomes preferred until it
passes the gates in the
[model-selection review](docs/research/2026-09-10-review-model-selection.md).
Earlier live failures attributed to those routes are re-read in
[ADR-006](docs/decisions/006-route-for-availability-not-pinning.md): most were
caused by the product disabling its own failover, not by the endpoints.
Run dry-run with your actual scope to check admission; the allowance is not a
completion guarantee. Profile fields are defined by
[standards-profile-v1](schemas/standards-profile-v1.schema.json). Rule IDs must be
unique across selected definitions. `paths` are repository-relative Node glob
patterns; paths with no applicable rule remain visibly unassessed. Duplicate
rule definitions require explicit resolution, rather than letting a model pick
which one to enforce.

Author input accepts plain text/Markdown or an existing structured author packet
JSON. Plain text makes no verification claims. The input files are excluded from
ordinary code evidence. The overview's digest is frozen before call one, and
its content is delivered only in call two. Edited author artifacts fail inspection.

Progress goes to stderr; `--quiet` suppresses it. The summary shows required or
recommended changes, rule IDs, locations and corrections. The full Markdown
report retains rule sources and reconciliation details. A passing standards
review is not a claim of bug-free code or deployment readiness. Cost output
separates provider-reported amounts from missing telemetry.

Convenience-mode runs reserve one of three instances in a Git-local flow only
after successful capture/preflight. Concurrent invocations cannot claim the same
instance. Repeated captures never overwrite an existing packet; use `inspect`
or an eligible `resume-final` for retained work. Use `--new-flow` only when
explicitly starting a distinct review. The existing `--request ... --config ...`
interface remains available for agents, including versioned
[standards requests](schemas/standards-review-request-v2.schema.json).


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

The brief declares no reviewer capabilities: the reviewer receives one fixed
payload and cannot request further reads, searches, or checks. An evidence
service is deferred (see
[ADR-005](docs/decisions/005-remove-unbuilt-reviewer-capability-declaration.md)).

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
[`schemas/review-run-config-v3.schema.json`](schemas/review-run-config-v3.schema.json),
which the runtime requires: `schemaVersion: 3`, a `providerRouting` block, and
budgets including the local spend ceiling `maxTotalCostUsd`.

Routing defaults to availability. `providerRouting.order` is an optional
preference of up to eight endpoint slugs, and OpenRouter may still route
elsewhere; set `pinToOrder` to restrict routing to that list and disable provider
failover, which is a diagnostic setting rather than a normal one. `zeroDataRetention`
and `denyDataCollection` each narrow the eligible endpoint pool and are off unless
a run opts in. `maxPrice` is always sent and is also the ceiling the local
reservation arithmetic assumes, so set it as a true ceiling rather than at the
cheapest available rate; a tight value quietly shrinks the pool.
`fallbackModels` lists up to four alternate models, sent as OpenRouter's model
fallback chain, and a response from any permitted model is accepted. Structured
output is always required of the serving endpoint.
`budgets.maxAttemptsPerCall` (default 3) bounds attempts for one logical call,
and `budgets.minimumCallIntervalMs` (default 1500) spaces calls sharing a model
so a batch stays under the account burst limit.
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

Rejected completions with a parseable envelope retain sanitized response ID,
model, provider, finish reason, and normalized usage in `CALL_FAILED.responseMetadata`
and CLI failure output. Sum usage across successful and failed calls when
accounting for a run; a rejected response can still have reported cost. Missing
or invalid telemetry is unknown, not zero. Raw private response files remain
separate from this bounded metadata. Null or truncated completions still fail;
they are never converted to successful reports or automatically replayed.

Final provider output uses `final-review-candidate-v1`: author claims reference
`claimIndex`; concerns reference `kind` and `concernIndex` in the corresponding
preliminary array. The runner inserts exact original text into the unchanged
final report format, then applies existing semantic checks. Missing, duplicate,
or unknown references fail validation. Older response protocols require a new
review rather than a final-stage resume.

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

The GitHub/GitLab adapter, arbitrary local verification workers, model
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

Read [Contributing](CONTRIBUTING.md) before proposing a change. Report defects
and oddities through the documented [bug-reporting workflow](docs/bug-reporting.md),
which requires enough Git and changeset information to replay public cases.
Report suspected vulnerabilities privately according to the
[security policy](SECURITY.md).

Changes go through pull requests and the required Repository checks job. Read
[Repository governance](docs/repository-governance.md) for branch rules and CI,
and run `python3 -B scripts/check-ai-context.py --ci` before opening a PR.
