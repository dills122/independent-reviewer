# ADR-011: Separate standards-reference selection from file classification

## Status

Accepted

## Date

2026-09-11

## Context

ADR-008 made path classification decide whether changed content entered review.
That controlled cost, but it could not represent an authoritative Markdown,
schema, registry, or fixture needed to judge changed code. ADR-007 captured
unchanged imports only, so a non-imported registry named by a standard remained
invisible. Making all documentation reviewable would restore irrelevant payload
and still miss unchanged documents.

Standards `rules[].paths` already means applicability. Treating filenames in
rule prose or applicability globs as read instructions would make untrusted text
control repository access.

## Decision

Standards profile v2 adds validated repository references and explicit bindings:

```json
{
  "references": [
    {
      "id": "reference_api_names",
      "path": "API_NAMES.md",
      "purpose": "Authoritative API registry",
      "authority": "BASE"
    }
  ],
  "referenceBindings": [
    {
      "ruleId": "rule_api_names",
      "referenceId": "reference_api_names",
      "required": true
    }
  ]
}
```

Profile v1 remains accepted. `rules[].paths` remains applicability only.
References use normalized repository-relative paths; no path is inferred from
rule text.

Classification describes artifact kind. It no longer independently decides
eligibility: a changed declared reference enters the changed-path manifest with
its original classification and receives review-target treatment. An unchanged
declared reference is captured as supporting context when a bound rule applies.

Standards brief v2 carries a digest-bound `referenceEvidence` ledger. Roles are
multi-valued (`REVIEW_TARGET`, `SUPPORTING_REFERENCE`) and separate from capture
status (`CAPTURED`, `OUT_OF_SCOPE`, `UNAVAILABLE`, `OMITTED`). Each entry names
its bound rules, requirement state, and `BASE` authority.

Captured supporting sources retain separate origin facts: `importedBy` contains
only real import relationships, while `standardReferenceIds` contains explicit
profile declarations. An explicit registry is never mislabeled as an import.

`BASE` is always normative in this version. A modified or deleted reference can
support review from its captured BASE side while its HEAD change remains a
target. An added reference is a target but has no authority in the same review;
a required binding therefore produces blocking missing evidence. HEAD authority
is not exposed until a trusted runner policy can authorize it without reading
the reviewed change.

Hard secret/content/kind/size checks and caller exclusions retain precedence.
A required conflict is recorded as unavailable or omitted. Supporting references
cannot be primary finding anchors; findings remain anchored to transmitted
changed evidence, enforced by existing runner validation.

## Consequences

- General-language standards can name Markdown, JSON, YAML, schemas, fixtures,
  or source declarations without reclassifying them.
- Ordinary unrelated documentation remains out of scope.
- Capture cost grows only for explicit applicable references.
- Profile v2 and standards brief v2 schemas change together; profile v1 requests
  produce an empty reference ledger and keep existing behavior.
- Snapshot manifest remains capture-fact and blob-identity authority.
  Rule-relative roles/status live in standards brief, preventing capture facts
  from depending on one review mode.
- Existing import capture remains a complementary heuristic. Reviewer-requested
  evidence remains deferred.

## Validation

Contract and Git integration tests cover unchanged, changed, missing,
caller-excluded, and secret-bearing references. They prove BASE capture,
documentation target promotion, blocking required omissions, and absence of
secret bytes from persisted blobs.
