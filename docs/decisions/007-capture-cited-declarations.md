# ADR-007: Capture the unchanged sources a change imports

## Status

Accepted

## Date

2026-09-10

## Context

[ADR-006](006-route-for-availability-not-pinning.md) made reviews land reliably.
The first product slice then widened standards review from selected rules alone
to selected rules plus local correctness, carried by a `rule_local_correctness`
rule whose text scopes a defect to what is demonstrable from "the changed code
together with the declarations it cites".

The evidence packet did not deliver the second half. Capture froze changed paths
only, so an imported signature and its doc comment were invisible. Live
validation showed the cost: a change adding

```ts
export const STORE_TAX_PERCENT = 8;
return subtotal + taxCents(subtotal, STORE_TAX_PERCENT);
```

returned **Standards satisfied** with `rule_local_correctness: ASSESSED` and no
limitations, because `taxCents(amountCents, rate)` documents `rate` as a
0.0-1.0 fraction in an unchanged file the reviewer never saw. The code
overcharges tax eightfold and the review was green.

Recording every unseen import as a limitation was not available as a fix.
`validateReportStructure` makes any limitation block both ready verdicts, so a
review of ordinary code that imports anything would return UNABLE_TO_VERIFY.

## Decision

Capture the unchanged files the changed code imports directly, as read-only
context.

Resolution is relative specifiers only, in TypeScript and JavaScript, at depth
one. A bare specifier names a package whose source is not the repository under
review; an absolute specifier is not portable evidence; and each additional hop
through the import graph costs transmitted bytes and buys less. Node16-style
`./tax.js` maps back to `src/tax.ts` first, and a specifier carrying a file
extension never resolves to a directory index.

Referenced sources are context, not review targets. They are:

- recorded in the manifest as `referencedSources` with the importing paths, so a
  reader can see what informed a judgement;
- excluded from `requiredCoverage`, so no coverage is owed for them;
- **not citable** — findings still anchor to changed code, because the defect is
  at the call site, not in the file being called. This keeps
  `assertFindingEvidenceAnchors` and `assertStandardsFindings` unchanged.

Budgets bound the cost. Capture stops at 128 KB of referenced content per
snapshot; transmission draws from the existing evidence budget and drops
referenced files before it ever drops the change under review. A dropped or
uncapturable file is declared — as a manifest omission, or an `EVIDENCE_BUDGET`
coverage constraint — so the reviewer knows a contract is missing. Standards
policy v6 tells it to mark the rule UNASSESSED in that case rather than assume
the call is correct.

## Consequences

`SnapshotManifestV1` gains a required `referencedSources` field, which changes
`snapshotDigest` and therefore `briefDigest` for every snapshot. Pinned identity
constants in the suite moved with it. This is a pre-release breaking change to a
published schema artifact, consistent with ADR-006.

A packet is larger. The manifest, the blob store, and the transmitted brief all
carry files that are not under review, and prompt cost rises with them: the
validated cases ran $0.0009-$0.0027 against $0.0005-$0.0010 before.

Import extraction is a regular expression, not a parser. It does not strip
comments or string literals, so a commented-out import can pull in a file the
change does not really use. The trade favours recall: a false positive costs one
extra captured file the reviewer may ignore, while a miss costs a defect. A
parser remains available if false positives become a real cost.

Only TypeScript and JavaScript resolve. Another ecosystem gets no referenced
context until it has a resolver, and its reviews behave exactly as they did
before this change.

## Validation

`docs/validation/2026-09-10-local-correctness-scope.md`. The cross-module case
that previously returned Standards satisfied now returns a REQUIRED finding
citing `src/checkout.ts:7-9` with the concrete input and wrong output, and the
same import graph used correctly returns Standards satisfied.
