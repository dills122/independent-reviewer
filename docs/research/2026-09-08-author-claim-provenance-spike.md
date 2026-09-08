# Author-claim provenance research spike

Status: proposal; awaiting repository-owner decision.

Date: 2026-09-08

Decision owner: repository owner.

## Executive conclusion

Keep the existing two-call blind-then-reconciliation flow. The gap is not a
reason to add another model, local chat, or classifier call. It is a contract
authority problem: the provider can currently write an unrestricted claim and
assign the truth-like status `CONFIRMED`, while only the separate verification
ledger is bound to the frozen author packet.

The smallest durable correction is a versioned final-report contract that:

1. binds the final report to a canonical digest of the exact author packet;
2. replaces model-authored claim text with a reference to a frozen author-packet
   value;
3. replaces the generic `CONFIRMED` status with an evidence-basis relation that
   never means a command was independently run;
4. keeps verification claims in a separate exact-coverage ledger; and
5. permits runner-backed verification statuses only when a future local
   executor supplies a validated runner-evidence reference.

Use RFC 6901 JSON Pointers for same-packet source references. Restrict them at
runtime to a small allowlist of claim-bearing author fields and reject
verification paths from the general statement ledger. Render the source text
from the stored packet rather than trusting the model to repeat it.

For the current release, every claimed command remains
`INDEPENDENTLY_UNVERIFIED`; a reviewer may still identify code conflicts as a
finding, but it cannot promote or disprove an execution event that the engine
did not observe. Add runner-confirmed or runner-contradicted variants only with
the named-check executor.

Do not build a general claim-classification system now. Arbitrary prose can
contain several kinds of assertions, so keyword filters, prompt rules, and
author/model-selected claim categories cannot create trustworthy provenance.
If later evaluations show that packet-field references are too coarse, evolve
the author packet to an explicit atomic claim catalog as a separate decision.

## Decision question

What is the smallest enforceable author-claim model that prevents
author-reported verification from being laundered through a general claim
ledger, while preserving the blind/reconciliation flow and keeping OpenRouter
calls, tokens, and implementation scope bounded?

## Scope and stop condition

This spike covers:

- the current provenance bypass;
- the identity of the author packet used during reconciliation;
- general author-statement and verification-result semantics;
- what JSON Schema and structured output can and cannot enforce;
- token/call implications;
- contract, runtime, renderer, and test changes; and
- the boundary between this correction and the deferred named-check executor.

It does not implement the correction, design the executor sandbox, select a
model, make a live provider call, or normalize every sentence of an engineer's
explanation into an ontology.

Research stopped when primary standards, current provider documentation, and a
local reproduction were sufficient to distinguish a minimal enforceable design
from the larger alternatives.

## Decision criteria

1. The provider cannot manufacture, rewrite, or upgrade source provenance.
2. Verification truth cannot exist without evidence from an identified runner.
3. Invalid references and prohibited relationships fail locally and visibly.
4. The implementing engineer can still send a natural, self-contained
   explanation after the blind assessment.
5. The correction adds no model call and avoids repeating author prose in the
   final response.
6. The first implementation remains small and leaves a clean extension point
   for named verification.

## Repository observations

### The bypass is reproducible

At commit `cb0b3bea774167a75fbf97c78adc575196d3c464`, using Node.js
`v24.19.0`, a focused parse supplied the same assertion through both ledgers:

```json
{
  "authorClaims": [
    {
      "claim": "npm test passed",
      "status": "CONFIRMED",
      "explanation": "Author said so"
    }
  ],
  "authorVerificationClaims": [
    {
      "claimIndex": 0,
      "command": "npm test",
      "claimedOutcome": "PASSED",
      "claimedSummary": "Reported by author",
      "status": "UNVERIFIED",
      "explanation": "No runner evidence"
    }
  ]
}
```

The current `FinalReviewReportV1Schema` accepted the report:

```text
{"accepted":true,"generalStatus":"CONFIRMED","verificationStatus":"UNVERIFIED"}
```

This does not require prompt failure or malformed JSON. Both values are valid
under the current schema, and runtime reconciliation checks only the indexed
verification ledger.

### The author packet is delivered by value but not report-bound

The orchestrator loads the stored author packet, sends it only after the
preliminary artifact is durable, and records a digest in the run ledger at
delivery. The final report itself identifies the snapshot and neutral brief but
not the author packet. A self-contained final artifact therefore cannot prove
which explanation its references or reconciliation describe.

### Arbitrary prose defeats semantic routing

`componentWalkthrough[*].changes`, `technicalApproach`, and other packet fields
are free text. A sentence such as "implemented retries and `npm test` passed"
contains both an implementation assertion and an execution assertion. A regex,
prompt instruction, or model-selected category cannot reliably split that
sentence or grant it a trustworthy type.

The safe design must therefore limit what each output status means. It must not
depend on perfectly classifying every sentence before validation.

## Documented facts and implications

### Provenance requires identified subjects and constrained relationships

- **Documented fact:** W3C PROV defines provenance as information about the
  entities, activities, and agents involved in producing data, used to assess
  its quality and trustworthiness. Its companion constraints specification
  distinguishes merely recording provenance from validating that its
  relationships form a consistent instance.[^prov-dm][^prov-constraints]
  **Inference:** an author statement, a review judgment, and a runner execution
  are different entities/activities and should not collapse into one generic
  truth status.
- **Documented fact:** an in-toto Statement binds a typed predicate to immutable
  subject artifacts identified by digests.[^in-toto-statement]
  **Inference:** the final reconciliation should identify the exact immutable
  author packet and refer to values within it; copying model-generated text is
  not an equivalent binding.
- **Documented fact:** SLSA's Verification Summary Attestation identifies the
  verifier, subjects, policy, and input attestations used to reach a verification
  result. A consumer relies on the result only if it trusts that verifier.
  [^slsa-vsa]
  **Inference:** `RUNNER_CONFIRMED` is meaningful only when it names evidence
  produced by the configured runner. "The reviewer agrees" is not execution
  evidence.
- **Documented fact:** the in-toto test-result predicate represents the tested
  source subject, overall result, test lists, configuration, and optional run
  location.[^in-toto-test-result]
  **Inference:** a future runner record needs a typed subject/result/evidence
  relationship. The current author's command, outcome, and summary are
  testimony and must remain distinguishable from that record.

### JSON references and schema validation solve different parts

- **Documented fact:** RFC 6901 defines a compact string syntax for resolving a
  specific value from a JSON document. Invalid syntax or a pointer that does not
  resolve is an error whose handling the application must define.[^rfc6901]
  **Inference:** a JSON Pointer is appropriate for a report that refers into the
  exact frozen author packet. This is an intra-artifact reference, so array-index
  stability is sufficient for one review instance.
- **Documented fact:** JSON Schema Draft 2020-12 can express structural and
  conditional assertions such as `if`/`then`/`else` and dependent schemas.
  [^json-schema-validation]
  **Inference:** it can require a runner-evidence field for a runner-backed
  status, but a static schema cannot resolve a pointer against a separately
  stored packet or establish that cited evidence supports the prose. Local
  semantic validation remains mandatory.
- **Documented fact:** OpenRouter structured outputs can require a compatible
  model to return JSON matching a strict JSON Schema, and recommends strict mode
  and parameter-compatible routing.[^openrouter-structured]
  **Inference:** provider enforcement reduces malformed shapes; it does not
  establish provenance or factual truth. The application must own those checks.

## Options considered

| Option | Blocks bypass | Deterministic | Review value | Token/call cost | Scope | Decision |
| --- | --- | --- | --- | --- | --- | --- |
| Prompt or keyword classification | No | No | Medium | Low | Small | Reject |
| Remove the general claim ledger | Yes | Yes | Low-medium | Lowest | Smallest | Safe fallback |
| Packet-bound, basis-specific dispositions | Yes | Yes | High | No extra call; bounded output | Small-medium | **Recommend** |
| Normalize all author prose into atomic typed claims | Potentially | Yes after authoring | High | Larger input/output | Large | Defer |
| Add another reviewer/classifier agent | No by itself | No | Unclear | Extra metered call/context | Large | Reject |

### Prompt or keyword classification

A rule such as "verification-looking text cannot be confirmed" sounds small,
but neither a keyword list nor another LLM can be the trusted authority for an
open-ended semantic distinction. False negatives recreate the bypass; false
positives suppress legitimate statements. This can remain prompt guidance, not
a security or provenance boundary.

### Remove the general ledger

Deleting `authorClaims` while retaining preliminary-finding dispositions and
the exact verification ledger completely closes the current path. This is the
best emergency fallback if the richer contract cannot be implemented safely.
It loses explicit reconciliation for useful statements such as claimed
component behavior and invariants.

### Packet-bound, basis-specific dispositions

This retains useful reconciliation without letting the model author the source
or use a generic truth label. It requires modest contract and renderer changes,
plus local pointer/evidence checks. It adds no call and avoids repeating packet
text in provider output.

### Fully normalized author claim catalog

An `authorClaims: [{id, kind, statement}]` input could make exact coverage and
stable IDs easy. It also forces the implementing agent to atomize natural prose,
increases packet size, creates category governance, and still cannot make an
untrusted category true. Defer it until evaluation demonstrates that references
to existing structured packet fields are too coarse.

## Recommended contract shape

Use a new final-report version rather than silently changing the meaning of
schema version 1. The names below are directional; exact identifiers can be
settled during implementation.

```ts
type AuthorStatementAssessmentV2 = {
  sourcePointer: string;
  relation:
    | "CONSISTENT_WITH_FROZEN_EVIDENCE"
    | "CONTRADICTED_BY_FROZEN_EVIDENCE"
    | "NOT_ESTABLISHED";
  evidence: ReviewEvidenceV1[];
  explanation: string;
};

type AuthorVerificationAssessmentV2 =
  | {
      claimIndex: number;
      status: "INDEPENDENTLY_UNVERIFIED";
      explanation: string;
    }
  | {
      claimIndex: number;
      status:
        | "MATCHED_RUNNER_RESULT"
        | "CONTRADICTED_BY_RUNNER_RESULT"
        | "RUNNER_INCONCLUSIVE";
      runnerEvidenceId: string;
      explanation: string;
    };

type AuthorReconciliationV2 = {
  authorPacketDigest: DigestV1;
  statementAssessments: AuthorStatementAssessmentV2[];
  verificationAssessments: AuthorVerificationAssessmentV2[];
};
```

Until the named-check executor exists, do not expose the runner-backed union
variants to the provider schema. The only valid verification status is
`INDEPENDENTLY_UNVERIFIED`. This keeps the current implementation honest and
avoids designing a pretend runner record.

### Allowed general statement sources

Start with these claim-bearing paths:

- `/planTraceability/<index>/implementation`
- `/componentWalkthrough/<index>/changes`
- `/decisions/<index>/decision`
- `/invariants/<index>`

Exclude these from the general statement ledger:

- `/claimedVerification/*`: exact coverage in the dedicated ledger;
- intent, technical approach, rationale, and alternatives: explanatory context;
- success criteria: canonical-requirement coverage already owns this judgment;
- risks, known gaps, and challenge points: disclosures to consider, not claims
  to certify.

This allowlist is a starting boundary, not a claim that the permitted text is
semantically atomic. Its safe status vocabulary remains necessary even for
allowed paths.

### Required local semantic checks

1. Recompute the canonical author-packet digest and match the report.
2. Parse each pointer under RFC 6901 rules; reject invalid or unresolved
   pointers.
3. Require every pointer to match the allowed path grammar and reject any path
   under `claimedVerification`.
4. Reject duplicate statement pointers.
5. Require at least one validated frozen-source evidence anchor for
   `CONSISTENT_WITH_FROZEN_EVIDENCE` and
   `CONTRADICTED_BY_FROZEN_EVIDENCE`.
6. Require exact, unique coverage of every `claimedVerification` index.
7. In the current release, require every verification assessment to be
   `INDEPENDENTLY_UNVERIFIED`.
8. Once a runner exists, require every runner-backed status to reference one
   validated result for the same snapshot, configured check, and claim.
9. Render original author text, commands, outcomes, and summaries by resolving
   the stored packet locally. The provider response contains no duplicate
   source text to drift or spoof.

An evidence anchor proves that the reviewer inspected a frozen location. It
does not, by itself, prove that the statement is true. The relation labels and
rendered headings must preserve that distinction.

## Resulting flow

The interaction remains two metered calls:

```text
prepare locally
  -> freeze snapshot + canonical author-packet digest
  -> blind OpenRouter call
  -> validate and persist preliminary assessment
  -> reconciliation OpenRouter call with the frozen author packet
  -> validate packet references, evidence basis, and verification coverage
  -> resolve source text locally and render final report
```

No local chat is needed to enforce provenance. When independent execution is
later enabled, a deterministic local named-check worker runs before or during
reconciliation and contributes a typed evidence record. It is not another LLM
and receives no provider credential.

## Token and complexity implications

- Model calls remain exactly two for the implemented release.
- The author packet is already present in the second call; a digest adds a small
  fixed field.
- Source pointers replace repeated claim prose in the response and rendered
  text is recovered locally.
- Only material general statements need entries. Verification claims retain
  exact coverage because their provenance is safety-critical.
- Do not generate a per-request JSON Schema enum containing every allowed
  pointer initially. A static pointer grammar plus local allowlist validation is
  simpler and avoids expanding the schema sent on every request.
- Do not add a classifier pass. It would spend tokens without becoming a
  trusted authority.

The recommendation modestly enlarges each useful statement assessment because
it adds evidence. That cost buys an auditable basis and is preferable to a
shorter but truth-like unevidenced status. Existing conversation and output
budgets remain the admission control.

## Implementation plan

### Slice 1: close the current authority gap

1. Add canonical author-packet identity computation and verification.
2. Introduce the versioned reconciliation contract above; remove the general
   free-text `claim` plus `CONFIRMED` path from the emitted report version.
3. Send the author-packet digest with the author message and require it in the
   final report.
4. Add pointer resolution, allowlist, uniqueness, evidence, and exact
   verification-ledger checks.
5. Change Markdown rendering to accept the stored packet and resolve source
   values locally.
6. Regenerate committed schemas and update protocol/architecture documentation.

### Slice 2: prove the invariant offline

Add focused fixtures for:

- the exact reproduced laundering attempt;
- a general pointer into `claimedVerification`;
- an invalid, missing, escaped, or duplicate pointer;
- a mismatched author-packet digest;
- a consistent/contradicted relation without frozen evidence;
- omitted or duplicate verification indexes;
- a model-authored replacement of source text, which should be impossible by
  schema;
- rendering that uses the packet's exact escaped text; and
- a clean two-call run with all verification claims independently unverified.

Then run the existing full application and repository-context gates. A live
OpenRouter smoke is useful for schema compatibility but is not required to
prove these local invariants.

### Later: add runner-backed verification deliberately

When the named-check executor is implemented, define its evidence identity and
isolation policy first. Only then expose runner-backed verification variants and
add tests that a status cannot reference a different snapshot, check, attempt,
or claim. This is a separate slice, not required to close the current bypass.

## Acceptance gates

The design is ready to implement when the repository owner accepts these
semantics:

- no generic `CONFIRMED` author-statement status;
- packet-bound references instead of provider-authored claim copies;
- general relations describe consistency with frozen evidence, not execution;
- verification claims are independently unverified until a real runner record
  exists; and
- the final artifact binds the exact author packet it reconciles.

Implementation is complete when the reproduction is rejected locally, the
valid two-call fixture still completes, committed schemas match code, all
existing gates pass, and no new provider call was introduced.

## Confidence, limitations, and unknowns

Confidence: **high** that removing generic truth authority and binding source
references locally closes the reported bypass; **moderately high** that JSON
Pointer is the smallest practical reference format for the current packet.

Limitations and unknowns:

- No live model was tested against the proposed schema.
- The useful maximum number of material statement assessments remains an
  evaluation question governed by existing output budgets.
- A single allowed packet field can still contain multiple semantic assertions.
  The proposed relation remains safe because it is evidence-basis-specific, but
  it may be too coarse for ideal review readability.
- The exact future runner-evidence contract is intentionally unspecified.
- A report signature or external attestation envelope is unnecessary for the
  local release; the recommendation adopts the subject/type/provenance lessons,
  not the full in-toto or SLSA formats.

## What would change the recommendation

- If evaluations show reviewers cannot reliably reference packet paths, add
  deterministic short IDs alongside the packet fields while retaining local
  resolution and packet identity.
- If fields regularly mix unrelated material assertions, add a bounded atomic
  `materialClaims` catalog to a new author-packet version.
- If the general ledger adds little user value, choose the safe fallback and
  remove it entirely.
- If reports must be exchanged across trust domains, consider wrapping the
  locally validated report and evidence identities in a signed attestation.
- If a real named-check runner lands, extend verification status only through a
  discriminated union that requires runner evidence.

## Recommendation and next gate

Accept packet-bound, basis-specific author reconciliation and implement it as
one focused hardening slice before relying on live review verdicts. Do not add
another agent or call, and do not wait for the verification executor.

The next gate is repository-owner approval of the five acceptance semantics
above. After approval, implement Slice 1 and Slice 2 together, run the offline
gates, and then use the already planned low-cost OpenRouter smoke only to test
provider/schema interoperability.

## Source index

Primary sources used:

1. [W3C PROV Data Model][prov-dm]
2. [W3C PROV constraints][prov-constraints]
3. [RFC 6901: JSON Pointer][rfc6901]
4. [JSON Schema Draft 2020-12 validation][json-schema-validation]
5. [in-toto Statement layer specification][in-toto-statement]
6. [in-toto test-result predicate][in-toto-test-result]
7. [SLSA v1.2 Verification Summary Attestation][slsa-vsa]
8. [OpenRouter structured outputs][openrouter-structured]

[prov-dm]: https://www.w3.org/TR/prov-dm/
[prov-constraints]: https://www.w3.org/TR/prov-constraints/
[rfc6901]: https://www.rfc-editor.org/rfc/rfc6901
[json-schema-validation]: https://json-schema.org/draft/2020-12/json-schema-validation
[in-toto-statement]: https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
[in-toto-test-result]: https://github.com/in-toto/attestation/blob/main/spec/predicates/test-result.md
[slsa-vsa]: https://slsa.dev/spec/v1.2/verification_summary
[openrouter-structured]: https://openrouter.ai/docs/guides/features/structured-outputs
