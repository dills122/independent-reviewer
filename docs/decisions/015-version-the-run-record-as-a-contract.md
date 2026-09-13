# ADR-015: Version the run record as a contract

## Status

Accepted

## Date

2026-09-12

## Context

Every persisted artifact in this project is a versioned contract with a Zod
schema, a generated JSON Schema, and an entry in the package exports map. The
brief, the plan, the preliminary assessment, the finding verification, the
candidate, the report, and the report metadata are all admitted through strict
parsing before anything reads a field.

`review/run-record.jsonl` was not. It is written by `appendRunEvent`, which
stamps `schemaVersion: 1` and an ISO timestamp on every line, and it has two
readers: `resumeFinalReview`, which replays it to decide whether a failed run may
be retried, and the CLI, which reads it to report spend and to advise the user
after a failure. Both cast each line to `Record<string, unknown>`.

That made the run record the only persisted contract whose field names were
enforced by nothing. Resume eligibility performs roughly thirty field reads
across four gates, comparing `unknown` to `unknown`:

```ts
preliminarySucceeded.attemptNumber !== acceptedAttemptNumber ||
started.findingVerificationSchema !== "finding_verification_candidate_v1" ||
```

Renaming or restructuring an emitted field could not fail a type check, a lint,
or a test. The failure mode was not a crash: comparisons against a now-absent
field simply evaluate to `undefined`, every gate refuses, and resume begins
rejecting runs that should qualify — while reporting the same generic message it
reports for a genuinely ineligible run. The `schemaVersion: 1` marker was
decorative, because no reader would have rejected a version 2.

This was not hypothetical drift. The CLI's resume hint encodes the expected
event sequence as a literal array that no longer matches what the orchestrator
emits, so the hint is unreachable (#121). Nothing detected that.

## Decision

Model the run record as a versioned contract, in the same shape as every other
persisted artifact.

`RunRecordEventV1Schema` is a Zod discriminated union on `type`, with one strict
member per event the orchestrator emits. Every member repeats the `schemaVersion`
and `at` fields that `appendRunEvent` stamps, rather than assuming a base type
that readers would have to reconstruct. It generates
`schemas/run-record-event-v1.schema.json` through the existing
`scripts/write-json-schemas.ts` path and is published in the exports map.

Both readers parse. `readRunEventsV1` in the orchestrator returns
`RunRecordEventV1[]`, so the resume gates operate on narrowed union members and
the compiler checks every field they compare. The CLI reads through the same
schema, which let `formatRunCost` drop its hand-written structural probing.

Members are strict. Adding an event type, or a field on an existing one,
requires declaring it here first. A test asserts that the set of `type` literals
the schema declares equals the set `appendRunEvent` is actually called with,
scanning the orchestrator source the way the strict-JSON allowlist test scans for
`JSON.parse`. Drift in either direction fails that test.

The schema records two shapes that were previously implicit and only discoverable
by reading the writer:

- `RUN_STARTED.guidanceGraphDigest` is **optional and never null**. It is spread
  in conditionally for a guidance brief and omitted otherwise, while
  `report-metadata.json` writes the same field as an explicit `null`. Resume
  compares the two sides with `JSON.stringify`, which agrees only because one
  side omits the key. The schema now states that, so the asymmetry is a declared
  property rather than an accident.
- `FINDING_VERIFICATION_PERSISTED` has a provider-backed and a provider-free
  form, distinguished by `providerCall`; the attempt number and response artifact
  exist only in the first.

## Alternatives considered

### Leave it untyped and document the fields

Rejected. A comment does not fail a build. The specific risk here is a silent
change in resume eligibility, which reaches users as a refusal to reuse work they
already paid for — the case least likely to be caught by a reviewer reading a
diff.

### Use a permissive base object with passthrough

Rejected. A loose schema would admit a renamed field without complaint, which is
the exact failure being closed. Strictness is what makes the writer and the two
readers move together.

### Validate only the events resume actually reads

Rejected. That is the set most likely to change, and partial coverage would give
false confidence while leaving the CLI reader unchecked.

## Consequences

- A run record that does not match the contract now fails on read with a message
  naming the offending line and field, instead of silently making a run
  ineligible. This is a behaviour change for any run record that has already
  drifted, and it surfaces as a loud failure rather than a quiet one.
- Adding an event type is a contract change: the schema, the generated JSON
  Schema, and the drift test all participate. That is deliberate friction.
- The resume gates are now type-checked. They remain semantically opaque — four
  gates collapsing twenty-nine clauses into four generic messages (#124) — which
  this ADR does not address, but typed events are the prerequisite for naming the
  failing predicate.
- Third parties can consume the run record against a published schema, as they
  can every other artifact.
