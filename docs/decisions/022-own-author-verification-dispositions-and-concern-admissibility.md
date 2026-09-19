# ADR-022: Own author-verification dispositions and preliminary concern admissibility

## Status

Accepted

## Date

2026-09-18

## Context

The 2026-09-14 paid 14-case matrix matched every expected top-level verdict but
produced report-quality defects ([#168](https://github.com/dills122/independent-reviewer/issues/168)).

Two of them are runner-owned rather than semantic. First, two cases marked the
author's claimed `node checks.mjs` outcomes `CONTRADICTED`. The runner never
executed that command, and code inspection that proves a defect does not prove
that a reported command outcome was false, so no evidence supported the
disposition. Second, a preliminary limitation whose complete text was `type`
survived into verification, acquired an invented interpretation there, and
printed `LIMITATION RESOLVED: type` in the final report.

The reviewer prompt also attributed finding confirmation to "author-supplied
verification" although confirmation came from the independent
finding-verification stage.

No execution backend is implemented or supported ([ADR-019](019-use-gvisor-backed-linux-check-workers.md)),
so there is currently no path by which the runner can observe an author-reported
command outcome at all.

## Decision

`authorVerificationClaims[].status` becomes the runner-owned literal
`UNVERIFIED`. The provider candidate schema omits the field entirely, so a model
cannot return any disposition, and materialization inserts `UNVERIFIED` from the
stored author packet. `CONTRADICTED` is removed rather than reserved; isolated
named checks reintroduce a disposition vocabulary when runner-observed evidence
exists.

Preliminary evidence gaps and limitations must carry a readable statement: at
least 12 characters and at least three word tokens after trimming. Inadmissible
concerns are dropped during preliminary parsing, before the assessment is
persisted, so verification indices, final concern dispositions and rendered text
all agree on the surviving list. Dropping rather than rejecting avoids buying a
repair call for one placeholder entry.

Reviewer and standards policy state that the runner owns author-verification
dispositions, that an explanation must not assert a reported outcome was false,
and that a confirmed finding is attributed to the independent
finding-verification stage. Policy versions advance to `review-policy-v22`,
`standards-review-v19` and `standards-review-v17`.

## Consequences

- A report can no longer overstate runner-observed evidence about an author's
  commands, and the author-claim vocabulary matches what the runner can observe.
- Existing V1 final reports carrying `CONTRADICTED` no longer parse under the
  current contract. The project is pre-release and resume already pins policy
  and schema versions, so no compatibility shim is retained.
- A short but genuine concern is dropped when it cannot carry three words. The
  threshold is deliberately low, and a real evidence gap is a sentence.
- Duplicate findings that restate the same root cause remain open in #168; that
  part needs finding-level consolidation rather than contract ownership.

## Alternatives considered

### Keep `CONTRADICTED` and add a prompt rule

Rejected. The vocabulary would still be available to a model with no
runner-observed evidence behind it, which is the defect that was observed.

### Reject the whole preliminary response for a placeholder concern

Rejected. One junk entry would cost a repair call and could fail an otherwise
complete review.

### Match placeholder text against a phrase list

Rejected for the reason recorded in [ADR-020](020-derive-finding-verification-from-structured-checks.md):
text matching makes the runner perform unreliable semantic review.
