# Reviewable changeset implementation plan

Sequenced delivery of [ADR-008](../decisions/008-send-a-reviewable-changeset.md).
Each slice is independently shippable and independently verifiable. Slices 1-3
unblock each other; slice 4 is the substantial one.

Live verification uses this repository's own history rather than fixtures.
Fixtures missed every defect ADR-008 records, because a fixture touches one
source file and a real commit touches a lockfile, four documents, and two source
files.

## Slice 1 — Deterministic path classification

Status: implemented.

**Objective.** Give every changed path a role, and stop treating an out-of-scope
path as a coverage gap.

- Add `PathRoleV1` (`SOURCE` / `TEST` / `CONFIG` / `DOCUMENTATION` / `GENERATED`
  / `BINARY`) to the snapshot manifest, one per changed path.
- Resolve it in capture, in precedence order: `.gitattributes` via
  `git check-attr` (`linguist-generated`, `linguist-vendored`,
  `linguist-documentation`); a generated marker in the opening lines; known path
  patterns; a minified line-shape heuristic. Config may override any path.
- Populate the existing `isGenerated` field and emit the existing
  `GENERATED_POLICY` exclusion, both currently declared and never produced.
- Stop emitting `UNSUPPORTED_CONTENT` for "no selected standard applies". Replace
  it with an out-of-scope record that the verdict rules ignore.

**Done when.** A commit touching source, docs, and a lockfile classifies each
correctly; the lockfile is excluded with `GENERATED_POLICY`; and `4ac6afa`
reaches a verdict instead of failing on a coverage constraint.

**Risk.** `git check-attr` costs one call per capture. Classification is
heuristic at the edges; the config override is the escape hatch.

## Slice 2 — Diff-based initial evidence

Status: core implemented; thresholds are deterministic V1 constants and evidence
form is carried in each evidence item's content. Configuration and budget
re-baselining remain follow-ups.

**Objective.** Send what changed, not every byte of every changed file.

- Render each reviewable path as a unified diff with bounded context.
- Send a whole side only when the file is below a size threshold, or when the
  change touches more than a fixed fraction of it. V1 constants are explicit and
  deterministic; expose configuration only after broader measurement.
- Record which form each path used, so a report can say whether a judgement saw
  the whole file or a hunk.
- Re-baseline the evidence budget downward once measured; the current 350,000
  bytes exists to absorb whole-file waste.

**Measured.** Range `f52f4e8..d6ba399` sends 34 bounded-hunk items and 12
whole-file items with correct BASE/HEAD coordinates. Evidence is 264,631 bytes,
38.4% below the previous 429,629-byte packet. Reduction is useful but below the
order-of-magnitude target, so token admission remains a follow-up.

**Risk.** Duplication spanning a large unchanged region becomes invisible. The
size and fraction thresholds are the mitigation and need measuring against real
commits, not guessing.

## Slice 3 — Graded coverage and depth

Status: implemented for out-of-scope versus unassessed paths and role-aware
prompting. Rule-specific unavailable evidence remains blocking under current
contracts and can be refined with slice 4.

**Objective.** Make a verdict mean something.

- Split today's single blocking notion into out-of-scope, unavailable, and
  unassessed, per the ADR-008 table. Only unassessed blocks unconditionally;
  unavailable blocks the rules that depended on it.
- Update `assertFinalReport` and `validateReportStructure` together — the ready
  verdict is gated in both, and fixing one alone leaves the other blocking.
- Set review depth by path role: `SOURCE` full, `TEST` assertion quality rather
  than style, `CONFIG` a targeted concern set, `DOCUMENTATION` and `GENERATED`
  none.
- Standards policy v7 carries the depth rules and the graded states.

**Done when.** A clean commit touching source plus docs returns a ready verdict;
a commit with a genuinely unreviewed source path still cannot.

**Risk.** This is verdict semantics. It needs the review-results contract change
to land in both modes at once, and requirements mode has its own gates.

## Slice 4 — Bounded evidence requests

Status: deferred.

**Objective.** Let the reviewer go and look, the way a person would.

- Extend the preliminary response with optional evidence requests: path, optional
  symbol or line range, and a reason.
- Resolve each request from the frozen snapshot only. A request naming a path
  outside the snapshot is refused and recorded, never read from disk.
- Budget requests explicitly: a maximum count, a byte ceiling, and one resolution
  round. Exhaustion is an `Unavailable` state, not a failure.
- Record every request and its outcome in the run record, so a reader can see
  what the reviewer asked for and what it received.

**Done when.** A change calling a function whose contract is neither in the
change nor in its direct imports produces a request, the request is answered from
the snapshot, and the finding cites the changed code.

**Risk.** The largest slice, and the only one that adds a round trip. Latency and
cost both rise for reviews that use it. The budget is what stops an unbounded
"one more file" negotiation, and it must exist before the loop does.

## Explicitly not in this plan

- **Model selection.** Deferred until slices 1-3 land. A stronger model reading a
  lockfile is still reading a lockfile, and the token headroom these slices free
  is what makes a stronger model affordable.
- **The one-byte-one-token reservation.** Roughly four times pessimistic for
  source. Diff evidence shrinks its absolute error without correcting the ratio.
  Worth fixing, separately, with measurement.
- **Continuous integration signals as review input.** External, frequently stale,
  and a green build is not evidence about the defects this review looks for.
- **Non-JavaScript ecosystems.** Classification patterns and the ADR-007 import
  resolver are both TypeScript and JavaScript only. Another ecosystem needs its
  own before any of this helps it.
