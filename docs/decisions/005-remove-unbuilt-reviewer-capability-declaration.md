# ADR-005: Remove the unbuilt reviewer capability declaration from the brief

## Status

Accepted

## Date

2026-09-09

## Context

`NeutralReviewBriefV1` declared a `capabilities` block with two populated types:
`evidenceOperations`, an enum of `READ_SNAPSHOT_FILE`, `READ_DIFF`,
`SEARCH_SNAPSHOT`, and `READ_CANONICAL_INPUT`; and `verificationChecks`, a list
of `check_`-prefixed identifiers with titles. The schema also refined the block,
rejecting duplicate verification-check identifiers.

No code path ever populated it. The only construction site,
`buildNeutralReviewBriefV1`, hardcoded both arrays empty, so the `check_`
identifier prefix, all four evidence-operation values, and the uniqueness
refinement were unreachable. The reviewer receives one fixed payload — the brief
plus its blind evidence — and can request nothing further. The review policy
instructs the model to record unavailable context as an evidence gap or
limitation, which is the workaround for having no evidence service.

The declaration was therefore a claim the implementation did not support.
`schemas/neutral-review-brief-v1.schema.json` is a published package export, and
`docs/architecture-and-roadmap.md` listed an "Evidence service" component as a
peer of the OpenRouter adapter. A reader of either reasonably concluded that
snapshot search and verification checks exist.

Two corrections were available: keep the shape and document it as reserved, or
remove it. `capabilities` is inside the brief identity — `briefDigest` is
computed over the whole brief except that digest — so removing it changes the
digest of every brief, which is verified on read, pinned as a `const` in the
provider response schema, persisted in the run record, and recomputed during a
final-stage resume. That made removal a breaking change to a v1 contract.

## Decision

Remove `capabilities` from `NeutralReviewBriefV1` rather than reserve it.

The project is pre-release with no published versions and no external consumers,
so a breaking identity change costs nothing today and costs more with every
brief produced later. A contract that advertises capabilities the tool does not
have is worse than one that says nothing: it misleads a reader of the published
JSON Schema, and it permanently embeds two empty arrays in the identity of every
brief.

The brief schema is `strictObject`, so a payload carrying a `capabilities` block
is now rejected rather than ignored.

The evidence service moves to the deferred list in
`docs/architecture-and-roadmap.md`, alongside the hosting adapters and
verification workers. When it is built, the capability declaration returns as a
deliberate addition, shaped by what the service actually offers rather than by
this speculative draft.

## Consequences

- `briefDigest` values change. The golden identity fixture in
  `test/contracts/neutral-brief-identity.test.ts` is updated, and packets
  produced before this change cannot be resumed, since resume rebuilds the brief
  and compares digests.
- `schemas/neutral-review-brief-v1.schema.json` is regenerated. The published
  export keeps its `v1` name: the schema version is not bumped, because there is
  no released v1 for a v2 to be compatible with.
- The `check_` identifier prefix stays available in
  `src/contracts/primitives.ts` for the eventual evidence service.
- Removing declared-but-unbuilt surface is the precedent this sets: while the
  project is unreleased, prefer deleting speculative contract surface to
  reserving it.
