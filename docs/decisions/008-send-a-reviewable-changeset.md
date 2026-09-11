# ADR-008: Send a reviewable changeset, not a changed-file dump

## Status

Accepted; slices 1-3 implemented, slice 4 deferred; eligibility refined by ADR-011

## Date

2026-09-10

## Context

Reviewing this repository's own history exposed a defect that no fixture had.
On `4ac6afa`, an eight-path commit, initial evidence was 47,637 bytes:

| Bytes | Path | In scope for the selected profile |
| --- | --- | --- |
| 14,968 | `package-lock.json` | no |
| 6,436 | `docs/research/…-spike.md` | no |
| 4,961 | `package.json` | no |
| 4,902 | `docs/plans/…-migration-plan.md` | no |
| 4,331 | `docs/research/…-selection.md` | no |
| 2,483 | `docs/plans/…-decoder-plan.md` | no |
| 5,459 | `src/provider/openrouter-sse-decoder.ts` | yes |
| 4,097 | `test/provider/openrouter-sse-decoder.test.ts` | yes |

**Eighty percent of the payload was files no selected rule could act on.** Each
of those six raised an `UNSUPPORTED_CONTENT` coverage constraint, and
`assertFinalReport` rejects a ready verdict while any coverage constraint
remains, so the review was refused after three successful provider calls. No
commit that touches a document, a lockfile, or a config file can return a ready
verdict, which is very nearly every real commit.

Three separate defects share one cause.

Evidence is assembled as *the changed file set*, rendered whole on both sides.
A five-line change to an 800-line module costs about 28 KB, so real commits
exhaust the evidence budget on content nobody asked to review. The budget work
in ADR-006's follow-up raised ceilings to accommodate that waste rather than
removing it.

Scope is expressed twice and reconciled nowhere. A standards profile already
declares what it covers through each rule's `paths` globs, but a path no rule
matches is reported as a *coverage gap* rather than as *out of scope*, and the
verdict rules treat the two identically.

The reviewer cannot ask for anything. Its only move when it lacks context is to
record an evidence gap and stop. ADR-007 added statically captured imports as a
partial answer, but a static guess cannot cover what a reviewer decides it needs
after reading the change.

A human reviewer does none of this. They read the intent, triage the file list,
read the diff, look up whatever the diff makes them curious about, and only then
form findings. The current design performs step one and a flattened, unfocused
version of step three.

## Decision

Assemble evidence as a reviewable changeset. Four changes, in dependency order.

### 1. Classify every changed path, deterministically

Each path receives a role: `SOURCE`, `TEST`, `CONFIG`, `DOCUMENTATION`,
`GENERATED`, or `BINARY`. Classification is deterministic and derived from, in
precedence order: `.gitattributes` (`linguist-generated`, `linguist-vendored`,
`linguist-documentation`, read through `git check-attr`); a generated-file marker
in the file's opening lines (`@generated`, `DO NOT EDIT`); known path patterns
(lockfiles, `dist/`, `vendor/`, `*.min.*`, `__generated__/`, `*.snap`); and a
minified line-shape heuristic. A run may override any classification in config.

Classification must not use a model. The capture engine proves stability by
running twice and requiring `beforeStateDigest === afterStateDigest`, and every
artifact identity is a digest over captured content. A classifier that can answer
differently on two runs breaks the freeze, the race check, and resume. The
scaffolding for this already exists and is explicitly deferred: `isGenerated` is
present in `SnapshotContentV1` and always `false`, and `GENERATED_POLICY` is a
declared exclusion reason that capture never produces.

`GENERATED` and `BINARY` paths are excluded from capture with the existing
`GENERATED_POLICY` reason. They are recorded and visible; they are not evidence.

### 2. Send diffs, with whole files only where they earn it

Initial evidence becomes the unified diff of each reviewable path with bounded
context, not both full sides. Native Git renders reconstructed frozen BASE/HEAD
files with explicit algorithm and helper controls; `parse-diff` validates and
structures hunks. Manifest remains identity/status authority. Findings cite BASE/HEAD
coordinates carried by hunk headers, and validation rejects coordinates outside transmitted
hunks even when that line exists elsewhere in the frozen source.

A whole side is still sent when the file is small enough that the diff saves
nothing, or when the change touches a large enough fraction of the file that
reviewing it in isolation would be misleading. V1 uses explicit deterministic
constants; configuration is deferred until real-range measurements justify it.
This preserves the one thing whole-file evidence buys — noticing
that a new helper duplicates something further down the same file — for the cases
where it plausibly applies.

### 3. Grade what is unknown

A path no selected rule covers is **out of scope**: recorded, visible in the
report, and irrelevant to the verdict. It is not a coverage gap and must stop
being reported as one.

Coverage and limitations become three distinct states rather than one:

| State | Meaning | Effect on verdict |
| --- | --- | --- |
| Out of scope | No selected rule claims this path | None |
| Unavailable | Evidence was needed and could not be supplied | Blocks only the rules that depended on it |
| Unassessed | Should have been reviewed and was not | Blocks |

Review depth follows the class. `SOURCE` is reviewed fully; `TEST` is reviewed
for assertion quality rather than style; `CONFIG` is reviewed for a targeted set
of concerns; `DOCUMENTATION` and `GENERATED` are not reviewed. Continuous
integration status is deliberately not an input: it is external, frequently
stale, and a green build is not evidence about the defects this review looks for.

### 4. Let the reviewer request evidence

The preliminary response may return bounded evidence requests naming a path and
optionally a symbol or line range, with a reason. The runner resolves each
request **from the frozen snapshot only**, so the freeze guarantee holds and no
request can reach live disk. Requests are answered once, within their own byte
and call budget, and the review then proceeds.

An unresolvable request becomes an `Unavailable` state under (3) rather than a
silent gap, which is what finally makes "I could not check this" a reportable
outcome instead of a dead end.

This is the general form of what ADR-005 removed as unbuilt and ADR-007
approximated statically. Static import capture stays: it answers the common case
without a round trip, and the request loop covers what it cannot predict.

## Consequences

Provider-free validation on `f52f4e8..d6ba399` captured 46 reviewable paths,
classified ten documentation paths out of scope, and produced 264,489 evidence
bytes: 34 bounded-hunk items and 12 justified whole-file items. That is 38.4%
below the previous 429,629-byte whole-file packet, with no blocking coverage
constraint. This is a material reduction, but not the originally projected order
of magnitude; conservative token reservation remains a separate bottleneck.

That headroom is what makes a stronger review model affordable, which is the
change the model-selection research argues for. Model choice should not move
before this lands: a better model reading a lockfile is still reading a lockfile.

The reservation arithmetic becomes less wrong by accident. It counts one byte as
one token, roughly four times pessimistic for source; with diffs replacing whole
files the absolute error shrinks even though the ratio does not. Correcting the
ratio is deferred, not fixed here.

Ready verdicts become reachable and therefore meaningful. Today every realistic
commit returns not-ready for reasons unrelated to code quality, which trains a
reader to ignore the verdict.

Costs paid: the evidence-request loop adds a round trip and latency to any review
that uses it, and needs its own budget or it becomes an unbounded "one more file"
negotiation. Diff-based evidence gives up whole-file context except where the
thresholds restore it, so a duplication spanning a large unchanged region can be
missed. Path classification is heuristic at the edges; an unmarked generated file
in an unfamiliar format will be reviewed as source until a pattern or an override
covers it.

## Alternatives considered

**Raise the budgets further.** Already done once. It accommodates the waste
instead of removing it, and it cannot fix the ready-verdict defect, which is
about scope semantics rather than size.

**Classify paths with a small local model.** Rejected: nondeterminism is
incompatible with the content-addressed snapshot and its race check, the result
would not be auditable when someone asks why their file was skipped, and
`.gitattributes` plus markers and patterns already answer nearly all of it. A
model may later inform *depth* as advisory metadata outside the digest.

**Widen the standards profile to cover documents and configuration.** Honest, but
it requires writing and maintaining genuine rules for document and configuration
quality, and it raises cost rather than lowering it. It also does not address
whole-file evidence.
