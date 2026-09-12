# Setup and usage guide

This guide takes a first-time user from a clean checkout to a paid review, then
covers profiles, configuration, artifacts, failures, and the lower-level
requirements workflow.

## What a review does

Independent Reviewer reviews one frozen Git changeset. Its default cumulative
working-tree scope includes committed branch changes relative to the selected
base plus staged, unstaged, and selected untracked changes.

One successful run has two mandatory model stages and one conditional stage:

1. Blind preliminary review sees frozen changes and canonical requirements or standards.
2. Fresh finding verification runs only when the preliminary contains findings.
3. Final reconciliation receives the persisted assessment, verification ledger, and author input.

The reviewer never receives the implementation conversation or local agent
memory. It cannot execute tests or read arbitrary files. Claims about commands
and results remain author claims unless separate runner evidence exists.

## 1. Install

Prerequisites:

- Git
- Node.js `>=24.0.0 <25`
- npm 11; this repository records `npm@11.17.0`
- OpenRouter account and API key for live runs

Clone, install the exact lockfile, and build:

```sh
git clone https://github.com/dills122/independent-reviewer.git
cd independent-reviewer
npm ci
npm run build
node dist/src/cli.js --help
```

Commands below assume the current directory is this checkout. You can instead
use an absolute path to `dist/src/cli.js` from any directory.

## 2. Choose a review mode

Use standards mode for normal code-quality review. It needs a selected standards
profile and an author overview, but no business requirements or implementation
plan. Its `init` and `review` flow is the shortest path to a result.

Use requirements mode when a review must trace implementation against explicit
requirements and a plan. It uses a versioned request JSON and exposes the
lower-level `prepare` and `inspect` workflow.

Both modes use the same snapshot, provider, verification, report, budget, and
failure boundaries.

## 3. Save simple model and cost settings

The recommended configuration path needs one supported model and a maximum
total review cost. Save both in the target repository's private Git metadata:

```sh
node dist/src/cli.js init \
  --repo /path/to/target-repository \
  --model openai/gpt-oss-120b \
  --max-cost 0.05
```

`init` validates the selected model profile, makes no provider call, and writes
`<git-dir>/independent-reviewer/simple-settings.json` with private permissions.
It refuses to overwrite an existing file. Inspect saved values and their source:

```sh
node dist/src/cli.js config show --repo /path/to/target-repository
node dist/src/cli.js config show --repo /path/to/target-repository --resolved
```

The resolved view exposes the complete runtime policy and stable digests, but no
credentials. `--model` and `--max-cost` can override saved values for one
`review`, `resume-final`, or `config show` command. Do not combine these flags
with `--config`.

Automatic Markdown steering discovery and interactive author input are planned
but not implemented yet. During this transition, pass `--standards` and
`--author` to each standards-mode review:

```sh
node dist/src/cli.js review \
  --repo /path/to/target-repository \
  --base main \
  --standards /absolute/path/to/standards.json \
  --author /absolute/path/to/author-overview.md \
  --dry-run
```

## 4. Prepare standards-mode inputs

Standards mode needs three files:

| Input | Purpose | Starting point |
| --- | --- | --- |
| Review config | Model, routing, privacy, size, retry, and spend limits | `examples/review-config.gpt-oss-120b.json` |
| Standards profile | Rules and repository-relative path applicability | `examples/standards.javascript-typescript.json` |
| Author input | Intent, approach, known gaps, and optional structured verification claims | Plain Markdown or structured JSON |

Keep these files outside the target repository or ensure they do not contain
secrets. The CLI excludes the selected config, standards, and author files from
ordinary changed-file evidence.

### Review configuration

Copy the availability-oriented baseline before changing it:

```sh
cp examples/review-config.gpt-oss-120b.json /absolute/path/to/review-config.json
```

Important fields:

- `configId`: stable identifier beginning with `config_`; requests bind to it.
- `model`: explicit OpenRouter model ID. Dynamic aliases and automatic routers are rejected.
- `fallbackModels`: ordered alternate model IDs for availability failures.
- `providerRouting.order`: preferred endpoints, not an allowlist by default.
- `providerRouting.pinToOrder`: disables provider failover; use only for diagnosis.
- `zeroDataRetention` and `denyDataCollection`: opt-in privacy filters that reduce eligible routes.
- `maxPrice`: real per-million-token/request ceiling used for both routing and local reservation.
- `maxTotalCostUsd`: local conservative ceiling across all attempts in one run.
- `maxAttemptsPerCall`: includes first attempt; applies to each logical model call.
- `minimumCallIntervalMs`: spaces starts sharing a model to reduce burst-rate failures.

Do not lower `maxPrice` merely to target the cheapest endpoint. A tight ceiling,
endpoint pinning, or both privacy filters can leave no healthy eligible route.
Always run dry-run against the real changeset after changing configuration.

Full structural contract:
[`review-run-config-v3.schema.json`](../schemas/review-run-config-v3.schema.json).

### Standards profile

Every rule has a stable `rule_` ID, text, enforcement, applicable path globs, and
nullable exceptions. `REQUIRED` violations block readiness;
`RECOMMENDED` findings become non-blocking follow-ups.

Minimal language-neutral shape:

```json
{
  "schemaVersion": 1,
  "name": "Project code review rules",
  "source": "Project engineering policy",
  "rules": [
    {
      "id": "rule_local_correctness",
      "text": "Changed code must produce the behavior stated by its names, types, comments, and accepted input contract.",
      "enforcement": "REQUIRED",
      "paths": ["**/*.py", "**/*.go", "**/*.java", "**/*.rs"],
      "exceptions": "Behavior requiring unavailable runtime or external-service state is unassessed, not a violation."
    }
  ]
}
```

Path patterns are repository-relative Node glob patterns: `*` stays inside one
segment and `**` crosses directories. Paths with no applicable rule remain
visible but out of selected review scope. Duplicate rule IDs are rejected.

Tool behavior is language-neutral: every reviewable text file gets deterministic
file-level coverage. JavaScript, TypeScript/TSX, Python, Go, and Java currently
receive additional Tree-sitter declaration regions. Parser support enriches
context; it does not decide whether another language can be reviewed.

Profile v2 can bind unchanged repository documents as authoritative evidence.
Each reference declares a `reference_` ID, repository path, purpose, and
`"authority": "BASE"`; `referenceBindings` connects it to one or more rules and
marks it required or optional. Classification informs handling but does not
independently decide eligibility: unchanged authoritative Markdown can be
captured as supporting context without becoming code under review. If an
authoritative reference changes in the patch, its BASE content remains authority
and the changed file becomes a review target.

Contracts:

- [`standards-profile-v1.schema.json`](../schemas/standards-profile-v1.schema.json)
- [`standards-profile-v2.schema.json`](../schemas/standards-profile-v2.schema.json)

The bundled profile covers JavaScript and TypeScript only because it is an
example policy. Copy it and change rules and paths for your project; do not infer
a product language restriction from that file.

### Author input

A plain Markdown overview is enough for a first review. Keep it factual and short:

```md
# Author overview

## Intent
Prevent duplicate job execution when two workers claim the same item.

## Approach
Move claim acquisition into the existing transaction and return the winning claim.

## Known gaps
No cross-region failover test was run locally.

## Challenge points
Check transaction boundaries and the behavior when the claim already exists.
```

Plain Markdown is converted to overview schema v2 with no claimed verification.
Use a JSON author packet only when commands and outcomes must enter the explicit
claim ledger. Structured shapes are defined in
[`standards-review-request-v2.schema.json`](../schemas/standards-review-request-v2.schema.json).

Author input is frozen before the blind call but withheld from both blind review
and fresh finding verification. It is delivered only during final reconciliation.

## 5. Advanced saved settings

The legacy advanced flow remains available when full JSON policy control is
needed. Initialize it once per target repository:

```sh
node dist/src/cli.js init \
  --repo /path/to/target-repository \
  --config /absolute/path/to/review-config.json \
  --standards /absolute/path/to/standards.json \
  --author /absolute/path/to/author-overview.md
```

`init` validates all three files, makes no provider call, and stores absolute
paths under Git-resolved private metadata at
`<git-dir>/independent-reviewer/settings.json`. Linked worktrees use their own
Git-resolved settings location. Settings are not committed, and `init` refuses
to overwrite an existing file. Edit that file deliberately or override any saved
path with the corresponding command flag.

You can skip `init` by passing `--config`, `--standards`, and `--author` on every
standards-mode `review` command.

## 6. Run dry-run

Dry-run validates the selected inputs, captures the actual scope into a temporary
packet, and checks conservative token and cost admission:

```sh
node dist/src/cli.js review \
  --repo /path/to/target-repository \
  --base main \
  --dry-run
```

It prints changed-path and exclusion counts, model fallback order, provider
preference/failover behavior, reserved tokens, and reserved cost. It makes zero
provider calls, does not require `OPENROUTER_API_KEY`, does not claim a review
instance, and removes the temporary packet.

Before live review, confirm:

- base ref is the intended comparison point;
- relevant paths are included and exclusions are expected;
- model/provider policy matches your data requirements;
- conservative reservation fits configured ceilings.

A passing dry-run proves admission and packet validity, not provider availability
or model-response validity.

## Scope and evidence selection

Capture classifies paths as source, test, configuration, steering,
documentation, generated, or binary. Source, tests, configuration, and steering
are reviewable when selected rules apply. Documentation, generated files, and
binaries stay visible as out of scope or excluded; they are not silently treated
as reviewed code.

Classification checks repository `.gitattributes` values
`linguist-generated`, `linguist-vendored`, and `linguist-documentation` before
generated markers and known path patterns. A standards-profile v2 reference is
an independent evidence role and can therefore capture authoritative Markdown
without reclassifying all documentation as source.

Reviewable changes are sent as native-Git unified hunks with three context lines.
Files of at most 40 lines, or changes affecting at least 60% of both sides, use
whole-file diff evidence. Supporting context is bounded and dropped before target
diffs; every resulting gap remains visible.

Direct unchanged import capture currently recognizes JavaScript and TypeScript
module syntax. Other languages still receive changed-file review and universal
file-level context; use profile v2 references when a specific unchanged contract
must accompany their changes.

Capture defaults to 512 KiB per file. It excludes credential-shaped filenames,
known private-key/API-key content, submodules, unsupported entry kinds, and
oversized files. Detection is a backstop, not proof that input is secret-free.
Add project-specific exclusions with one comma-separated argument:

```sh
node dist/src/cli.js review \
  --repo /path/to/target-repository \
  --base main \
  --exclude 'private/**,fixtures/customer-data/**' \
  --dry-run
```

Caller exclusions remain visible in packet metadata. Excluding evidence can
produce `UNABLE_TO_VERIFY`; never exclude relevant code merely to force a run
through admission.

## 7. Run live review

Create `.env` in the Independent Reviewer checkout or another private location:

```dotenv
OPENROUTER_API_KEY=replace-with-your-key
```

The checkout ignores `.env` and `.env.*`. If using another location, verify it is
not tracked and restrict its file permissions. Never place the key in the config,
request, author overview, command arguments, issue reports, or review artifacts.

Use Node's environment-file support so the key is loaded without shell output:

```sh
node --env-file=.env dist/src/cli.js review \
  --repo /path/to/target-repository \
  --base main
```

Progress is written to stderr. Add `--quiet` to suppress progress messages. The
command prints the result summary, provider-reported cost when available, and
final report path.

The first successful admission in standards convenience mode claims one of at
most three instances in the current Git-local flow. Use `--new-flow` only when
you intentionally start a distinct review, not to shop for a favorable verdict.

## 8. Interpret the result

| Exit | Verdict or condition | Meaning |
| --- | --- | --- |
| `0` | Ready / Ready with non-blocking follow-ups | No blocking finding under selected scope; follow-ups may remain |
| `1` | Input, validation, definite provider, or execution failure | No valid final report |
| `2` | Not ready | At least one blocking finding |
| `3` | Unable to verify | Missing or insufficient evidence blocks a reliable conclusion |
| `4` | Transport uncertain | Submission may have reached provider; outcome and cost may be unknown |

A standards verdict means satisfied, changes required, recommendations remain,
or unable to assess against selected rules. It is not a claim that code is
bug-free, system-correct, secure, or deployable.

## 9. Inspect retained artifacts

Live packets default to:

```text
<target-repository>/.review-runs/<snapshot-id>/
```

Keep `.review-runs/` in target repository `.gitignore`. The CLI excludes packet
directories from later captures and warns when an in-worktree packet location is
not ignored.

Key files include:

- `snapshot-manifest.json`: frozen Git identity, paths, exclusions, omissions, and digests.
- `review/neutral-review-brief.json`: exact blind-stage evidence contract.
- `review-context-map.json`: language-neutral context regions and relations.
- `review/review-unit-plan.json`: deterministic target/support grouping sent for review.
- `review/preliminary.json`: persisted blind result.
- `review/finding-verification.json`: one judgment per preliminary finding.
- `review/final.json`: validated final result.
- `review/report.md`: presentation-safe human report.
- `review/run-record.jsonl`: append-only stage, routing, usage, and failure ledger.
- `review/provider-response-attempt-*.raw.json`: private raw provider responses retained separately.

Exact filenames can vary by reached stage. Packets can contain proprietary source,
requirements, standards, author explanation, and raw model output. Never attach a
whole packet to a public issue without reviewing every file.

Requirements-mode packets can be checked without exposing author content:

```sh
node dist/src/cli.js inspect --packet /path/to/packet
node dist/src/cli.js inspect --packet /path/to/packet --json
```

`inspect` reports whether an author packet exists, never its content.

## Final-stage retry

When CLI explicitly prints an eligible final-only retry command after a definite
provider failure, use the same packet and exact same configuration:

```sh
node --env-file=.env dist/src/cli.js resume-final \
  --packet /path/to/packet \
  --config /absolute/path/to/review-config.json
```

Resume reuses the saved blind assessment and finding-verification ledger. It is
refused after completion, after its single claim, for a mismatched configuration,
or when required persisted state is absent. Never replay exit `4`: a
transport-uncertain request may already have been processed and billed.

## Requirements mode

Requirements mode is intended for agent workflows and explicit plan
traceability. Create a request matching
[`review-request-v1.schema.json`](../schemas/review-request-v1.schema.json):

```json
{
  "schemaVersion": 1,
  "flowId": "flow_example_change",
  "reviewInstance": { "number": 1, "maximum": 3 },
  "repository": {
    "path": "/path/to/target-repository",
    "base": "main",
    "workingTree": { "mode": "CUMULATIVE", "includeUntracked": true }
  },
  "canonicalInputs": {
    "requirements": [
      {
        "id": "input_requirements",
        "title": "Change requirements",
        "kind": "REQUIREMENTS",
        "content": "Requests for an already-claimed job must return the existing claim.",
        "provenance": { "type": "INLINE", "label": "Approved requirement" }
      }
    ],
    "implementationPlan": {
      "id": "input_plan",
      "title": "Implementation plan",
      "kind": "IMPLEMENTATION_PLAN",
      "content": "Acquire or read the claim inside one database transaction.",
      "provenance": { "type": "INLINE", "label": "Approved plan" }
    },
    "projectGuidance": []
  },
  "reviewConfigRef": "config_budget_120b"
}
```

Persist and inspect a provider-free snapshot:

```sh
node dist/src/cli.js prepare \
  --request /absolute/path/to/request.json \
  --output /absolute/path/to/new-packet

node dist/src/cli.js inspect --packet /absolute/path/to/new-packet
```

`prepare` does not make a later `review` consume that packet; it is a deliberate
capture/inspection command. Live `review` captures a new packet from the request:

```sh
node --env-file=.env dist/src/cli.js review \
  --request /absolute/path/to/request.json \
  --config /absolute/path/to/review-config.json
```

The request's `reviewConfigRef` must equal config `configId`. Request and config
files inside the worktree are excluded from changed-file evidence.

## Common failures

### Missing API key

`OPENROUTER_API_KEY is required` means live command did not receive environment
variable. Confirm `.env` contains exact name and invoke Node with
`--env-file=/absolute/path/to/.env`. Do not print file to diagnose it.

### Dry-run rejects token or cost admission

Review actual diff size and exclusions first. Then choose a model/config with
sufficient context or raise intentional budget ceilings. Do not silently drop
relevant evidence merely to pass admission.

### No eligible or healthy provider

Check endpoint pinning, privacy filters, model availability, and `maxPrice`.
Open routing with preferred endpoints and fallback models is normal production
shape; pinned example is diagnostic only.

### Packet location warning

Add `.review-runs/` or custom in-worktree output directory to target repository
`.gitignore`, or place output outside worktree. Never commit review packets.

### Invalid model output

Runner rejects malformed responses, bad evidence coordinates, incomplete
coverage, and inconsistent findings rather than manufacturing a successful
report. Preserve sanitized error and run ledger. Do not spend money repeating a
failure solely for debugging.

### Flow used all three instances

Three instances are protocol limit for one review flow. Start `--new-flow` only
when target or review objective genuinely defines a new review, with human
approval where required.

## Security and privacy checklist

- Keep API key only in environment or external secret store.
- Inspect standards, author input, diff, and exclusions before paid submission.
- Enable ZDR/data-denial only when required and accept reduced route availability.
- Treat provider-reported missing usage as unknown, not zero.
- Keep `.review-runs/` private and ignored.
- Use caller exclusions for additional sensitive paths; built-in secret detection is a backstop, not a guarantee.
- Report suspected vulnerabilities through [private security policy](../SECURITY.md), not public issues.

For reproducible non-security defects, follow
[bug-reporting guide](bug-reporting.md).
