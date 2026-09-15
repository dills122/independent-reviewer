# ADR-018: Bind final claims and project verified outcomes

## Status

Proposed

## Date

2026-09-15

## Context

[ADR-016](016-verify-every-verdict-affecting-review-claim.md) gives every
preliminary adverse claim a fresh author-blind judgment and makes final
limitations runner-owned. It deliberately leaves two gaps: a final-only claim
can affect the report without fresh verification, and an inconclusive finding
can remain in the finding channel instead of becoming uncertainty.

Final reconciliation can also reuse a preliminary finding identifier after
changing its premise. Current source identifiers establish provenance, not
semantic continuity. Final candidate V3 carries free-form finding fields, rule
assessments, reconciliation rationales, author-claim dispositions, and a
summary. Several of those fields can state or imply an adverse conclusion even
when the runner derives coverage, actions, limitations, and verdict.

Paid evaluation exposed three distinct consequences:

- [#168](https://github.com/dills122/independent-reviewer/issues/168) records a
  generic guidance finding that duplicated two concrete root causes, model-owned
  `CONTRADICTED` dispositions for commands the runner never executed, and a
  meaningless one-word preliminary limitation.
- [#171](https://github.com/dills122/independent-reviewer/issues/171) records an
  out-of-domain pagination premise with incorrect JavaScript behavior that both
  preliminary review and fresh verification accepted. Existing structural
  validation correctly preserved the wrong judgment; claim identity alone
  cannot make semantic model judgment correct.
- [#161](https://github.com/dills122/independent-reviewer/issues/161) requires a
  final-only false finding, changed premise under a reused source ID,
  inconclusive projection, and category-escape canaries before Stage B ships.

Every final semantic carrier therefore needs an explicit authority:

| Carrier | Current authority | Risk | Stage B authority |
| --- | --- | --- | --- |
| Finding obligation, scenario, assertion, evidence, severity, and correction | Model candidate plus structural runner checks | New or changed premise can reach blockers and verdict unchecked | Content-bound claim plus persisted verification judgment |
| Preliminary finding disposition | Model candidate, checked by source ID | Reused ID can disguise material change | Source ID is provenance only; claim identity decides continuity |
| Preliminary gap or limitation | Blind verifier plus runner projection | Final wording can create a new premise | Existing verified claim identity or fresh final judgment |
| Standards `CONFLICT` or `UNASSESSED` status | Model candidate plus coverage checks | Category can veto outcome without equivalent claim binding | Versioned rule-state claim and verified transition |
| Summary and reconciliation prose | Model candidate | Rejected or duplicate premise can survive outside formal fields | Runner-owned factual summary; eligible claim-scoped text only |
| Author facts and claimed command outcomes | Model candidate | Model can overstate runner observation | Labeled author evidence; command outcome remains `UNVERIFIED` without runner observation |
| Snapshot and canonical-input coverage | Runner projection from blind assessment | Incomplete scope can be hidden by prose | Existing runner-owned ledgers remain authoritative |
| Blockers, fast follows, limitations, and verdict | Runner projection | Projection is only as sound as eligible semantic inputs | Pure projection from verified claims, coverage, and mode policy |

This decision defines enforceable routing and projection. It does not claim
that a verifier will always recognize an invalid domain assumption or calculate
language behavior correctly. Those remain measured semantic properties under
the Stage A evaluation protocol.

## Decision

### Use a versioned, content-bound claim identity

Introduce evaluator-independent `ReviewClaimCoreV1` and `ReviewClaimSetV1`
contracts before changing orchestration. A claim core contains only semantic
fields:

- review mode and claim kind: `VIOLATION`, `BLOCKING_UNCERTAINTY`, or
  `STANDARD_STATUS`;
- sorted obligation references to canonical-input IDs and, in standards mode,
  selected rule IDs;
- a bounded scenario containing preconditions, action, observed result, and
  expected result where applicable;
- sorted exact frozen-evidence references containing snapshot side, path, and
  line or symbol anchor;
- one normalized assertion; and
- runner-relevant effect data: implementation severity, standards enforcement,
  or the exact adverse rule state.

`claimId` is `claim_` followed by the SHA-256 digest of the RFC 8785 canonical
JSON for the strict, schema-versioned claim core plus snapshot digest and brief
digest. Use shared canonical JSON, digest, prefixed-identifier, UTF-16 ordering,
and snapshot-path primitives. Do not duplicate their validation.

“Normalized” means the contract admits one canonical representation: text is
trimmed, single-line, and retained exactly; set-like arrays are unique and
UTF-16 sorted; anchors use existing normalized snapshot paths and coordinates.
The runner rejects non-canonical input instead of silently rewriting it. It
does not lowercase, stem, Unicode-normalize, or guess that two natural-language
sentences are equivalent.

Presentation fields, including title, impact explanation, and correction, do not
participate in claim identity. A wording change cannot manufacture a material
semantic transition. Conversely, changing an obligation, scenario, assertion,
evidence anchor, severity/enforcement, or adverse standards state necessarily
produces a different claim ID. Moving a premise between finding, uncertainty,
and standards-status kinds also changes identity and requires fresh judgment.

After preliminary validation, runner assembles the first claim set from every
finding, evidence gap, limitation, and adverse standards rule state. Active
preliminary verification must advance from V3 and judge that complete set; a
`CONFLICT` or `UNASSESSED` rule state cannot gain carry-forward authority merely
because current V3 treats it as a separate rule-assessment field.

Each violation claim represents one root cause and may cite several obligations.
A generic rule restatement belongs in the same claim's obligation set rather
than in another finding. The verification artifact may relate an item to an
earlier item as `DUPLICATE_OF`; runner groups that relation into one projected
finding. Claim sets are sorted by claim ID. Runner unions obligation and evidence
references, selects strongest verified effect, then selects the lowest claim ID
at that effect as representative for correction and presentation. Duplicate
relations cannot point forward in that order, self-reference, or cross claim
kinds.

### Treat source IDs as provenance, not continuity

Final candidate V4 references every preliminary claim exactly once and declares
one of these transitions:

- `CONTINUED`: candidate repeats the exact claim ID. Existing fresh blind
  judgment carries forward.
- `WITHDRAWN`: claim leaves user-visible output. No further semantic judgment is
  needed to remove an adverse claim.
- `NEW_OR_CHANGED`: final-only claim or different claim ID. Reusing a
  preliminary finding ID does not change this classification.

Provider presentation wording is outside the claim core and cannot request a
fourth call. There is no model-authored `EQUIVALENT` escape hatch and no runner
string-similarity heuristic. If semantic fields change, fresh verification is
required. If they do not, identity proves continuity.

A prior `NO_VIOLATION` cannot be resurrected under its old claim ID. A prior
`INCONCLUSIVE` violation cannot remain a demonstrated finding; runner projects
it as uncertainty unless a new or changed claim receives a fresh demonstrated
judgment.

### Verify only new or materially changed final claims

Persist the structurally and evidentially validated final candidate and claim
set before any post-author verification. When `NEW_OR_CHANGED` adverse claims
exist, make one fresh post-author verification call over:

- canonical obligations and frozen evidence used by those claims;
- exact claim cores, ordered without provider-facing IDs;
- only relevant author statements, explicitly labeled untrusted author
  evidence; and
- trusted verifier policy, without implementation conversation or agent memory.

Original preliminary and preliminary-verification calls stay author-free. The
post-author verifier does not receive the candidate verdict, summary, blockers,
or prior model rationale. Runner binds ordered judgments to claim IDs and
persists `FinalClaimVerificationV1` before projection. Every item receives
`DEMONSTRATED`, `REJECTED`, or `INCONCLUSIVE`, plus an optional backward-only
duplicate relation and a bounded rationale.

Skip this call when all surviving claims are exact `CONTINUED` claims with
carry-forward judgments and no unverified duplicate grouping or standards-state
transition. An adverse-claim-free clean review therefore remains two provider
calls. With preliminary adverse claims but no final semantic change, current
three-call behavior remains sufficient.

The verifier policy must explicitly test declared input domains and claimed
runtime behavior. The exact #171 positive-page fixture is a mandatory canary,
alongside the real in-domain off-by-one control. This is an evaluation gate, not
a deterministic language rule in the runner. Stage B cannot be described as
fixing #171 until provider-free regressions pass and an explicitly authorized
paid canary shows the false premise rejected without losing the true defect.

### Project judgments without interpreting prose

Projection is a pure runner operation over valid artifacts:

| Claim kind and judgment | User-visible projection | Outcome effect |
| --- | --- | --- |
| Violation, `DEMONSTRATED` | One finding per verified root group | P0/P1 or `REQUIRED` blocks; P2/P3 or `RECOMMENDED` is a follow-up |
| Violation, `REJECTED` | Audit ledger only | None |
| Violation, `INCONCLUSIVE` | Explicit uncertainty, never a finding | Blocking for P0/P1 or `REQUIRED`; otherwise a verification follow-up |
| Blocking uncertainty, `DEMONSTRATED` or `INCONCLUSIVE` | Explicit limitation | Blocks assessment |
| Blocking uncertainty, `REJECTED` | Audit ledger only | None |
| Adverse standards state, `DEMONSTRATED` | Exact `CONFLICT` or `UNASSESSED` state | Blocks standards assessment |
| Adverse standards state, `REJECTED` | Retain prior verified rule state | No new adverse effect |
| Adverse standards state, `INCONCLUSIVE` | Retain prior adverse state, or project `UNASSESSED` if none exists | Blocks standards assessment |

For implementation mode, a demonstrated blocking violation yields
`NOT_READY`, even when separate uncertainty remains visible. Without such a
violation, blocking uncertainty yields `UNABLE_TO_VERIFY`. For standards mode,
any conflict or unassessed required rule yields `UNABLE_TO_VERIFY`; otherwise a
demonstrated `REQUIRED` violation yields `NOT_READY`. Demonstrated non-blocking
work or non-blocking inconclusive verification yields
`READY_WITH_FOLLOW_UPS`; an empty eligible set with complete runner coverage
yields `READY`.

Runner derives blockers from projected blocking finding corrections, fast
follows from projected non-blocking work, and limitations from projected
blocking uncertainty, coverage constraints, and standards state. Rejected
claims cannot appear in findings, limitations, actions, standards state, or
summary. Duplicate groups produce one action.

Final report summary becomes runner-owned factual status, assembled from mode,
verdict, and counts of projected findings, follow-ups, blocking uncertainties,
and unassessed scope. No free-form provider summary survives into the active
report contract. Claim-scoped presentation may describe only an eligible claim
and is rendered beside its claim ID. Reconciliation rationale remains private
audit evidence unless attached to an eligible claim.

### Keep author claims and runner observations distinct

Author statements remain labeled author evidence. A provider judgment about
code cannot prove whether an author-reported command ran or produced its claimed
output. Until Stage D supplies a digest-bound runner observation for the same
command, environment, input snapshot, and result, active Stage B reports force
author verification claims to `UNVERIFIED`.

Future runner observations may project `CONFIRMED` or `CONTRADICTED`; model
prose may not. Summary attribution says “fresh claim verification” for verifier
judgments and “runner-observed” only for bound observations. This closes the
misattribution in #168 without treating inspection as command execution.

### Bound every new provider-authored string

New claim contracts use versioned shared primitives rather than
`NonEmptyTextSchema` directly:

- labels: trimmed, single-line, at most 160 Unicode scalar values and 640 UTF-8
  bytes;
- assertions, scenarios, impacts, corrections, and explanations: trimmed,
  single-line, at most 600 Unicode scalar values and 2,400 UTF-8 bytes; and
- verification and reconciliation rationales: trimmed, single-line, at most 400
  Unicode scalar values and 1,600 UTF-8 bytes, preserving the current verifier
  rationale precedent.

Reject over-limit or multi-line provider output; never truncate identity-bound
text. Response array caps, output-token limits, and whole-artifact byte caps
remain independent controls. Stage A fixtures must prove the limits retain
useful evidence before this ADR moves to Accepted.

This is the Stage B slice of [#133](https://github.com/dills122/independent-reviewer/issues/133).
Legacy artifact readers keep their historical string behavior. Broader prose
migration remains #133 and must not silently tighten persisted V1 artifacts.

### Version artifacts, admission, failure, and resume together

Add `ReviewClaimSetV1`, provider candidate and persisted
`FinalClaimVerificationV1`, implementation final report V2, and standards final
report V3. Keep old report, candidate, preliminary-verification, and ledger
readers. Active final provider candidates advance to V4 and cannot mix with V3
during one run or resume.

Advance the run record to V2 instead of adding new meanings to V1. V2 adds
`FINAL_CLAIM_VERIFICATION` as a stage; records final-candidate and claim-set
digests before the call; records the exact verification schema, prompt, request,
and response digests; persists either provider-backed judgments or a local skip;
and records final-report persistence before terminal completion.

Preflight reserves preliminary, possible blind verification, final, possible
post-author verification, and one retry at the largest call reservation before
call one. Cost reservation prices four logical calls in the worst case even
when either selective verifier later skips. Unknown usage and uncertain
transport retain current conservative charging rules.

A failed final-claim verification never publishes or marks a successful report.
Persisted candidate and completed earlier stages remain visible; terminal state
is explicit failure or transport uncertainty. V2 resume may continue a definite
retryable final or final-claim-verification failure only when snapshot, brief,
author, candidate, claim set, configuration, schema, prompt, request, and ledger
versions match exactly. Uncertain transport remains ineligible. V1 ledgers stay
readable for diagnosis but cannot resume into V2 semantics; user starts a new
review instead.

## Alternatives considered

### Strengthen prompts and retain source-ID continuity

Rejected. Both #168 and #171 produced schema-valid outputs under policy that
already prohibited the observed behavior. A reused source ID says where a claim
came from, not whether its premise stayed the same.

### Verify the complete final response on every review

Rejected. It adds cost and latency to clean reviews and asks another model to
reassess runner-owned coverage and bookkeeping. Selective content-bound claims
provide a smaller and auditable verification surface.

### Infer equivalence with string or embedding similarity

Rejected. Similar wording can change a precondition, obligation, or negation;
different wording can express the same premise. Exact semantic cores plus
presentation separation make continuity deterministic without a hidden
threshold or another dependency.

### Keep inconclusive claims as findings

Rejected. A finding says a defect or violation is demonstrated. Preserving an
unproven claim there overstates evidence; dropping it would create a false green.
Explicit uncertainty preserves both facts.

### Let provider write summary and filter known phrases

Rejected. Category escape is open-ended and language-dependent. A factual
runner summary can state outcome without repeating unsupported premises.

### Deterministically encode language and domain rules in runner

Rejected for Stage B. Hard-coding JavaScript `slice` semantics or guessing
business-domain preconditions would make a language-neutral orchestrator another
reviewer and would not generalize. Exact canaries and scorer evidence govern
semantic promotion.

## Consequences

- Every surviving adverse final claim has either an exact carried blind
  judgment or a fresh persisted post-author judgment.
- Material premise changes cannot hide behind reused IDs; presentation-only
  wording cannot force another call.
- Inconclusive violations remain visible without being mislabeled as proven
  defects.
- Summary, actions, verdict, and standards blocking state are deterministic
  projections of eligible claims and runner facts.
- Duplicate-root handling becomes explicit and auditable, though semantic
  duplicate recognition still depends on verifier judgment.
- Typical clean reviews remain two calls. Worst-case reviews add one call and
  must reserve it before spending.
- New artifacts and run records create a deliberate resume boundary. Old
  artifacts remain readable, but an old run cannot resume under new semantics.
- Stage B adopts bounds for its new prose. Full legacy prose migration remains
  separate work under #133.
- #168 gains enforceable provenance, grouping, summary, and placeholder-concern
  boundaries. #171 remains an empirical semantic-quality gate; this ADR alone
  does not close it.

## Consumer order and acceptance

1. Land minimum Stage A canaries and deterministic scorer from #160, including
   #168 duplicate/provenance cases and #171 false/true pagination pair.
2. Add shared bounded-text primitives, claim-core identity, claim-set,
   transition, and verification contracts with generated schemas and
   compatibility readers.
3. Add a pure projection module and provider-free tests for every table row,
   duplicate grouping, runner summary, author-command provenance, and both
   modes.
4. Add selective post-author orchestration, worst-case admission, V2 durable
   events, failure paths, retry charging, and exact stage-specific resume.
5. Version report rendering and CLI readers; retain explicit legacy read paths
   and reject cross-generation resume.
6. Run `npm run schemas:write`, `npm run check`, and repository-context checks.
   Freeze any paid canary request separately and run it only with explicit
   authorization.

Status remains Proposed until steps 1–5 pass provider-free gates. A passing
paid #171 canary is required before claiming that semantic defect fixed, but it
is not required to define these contracts.
