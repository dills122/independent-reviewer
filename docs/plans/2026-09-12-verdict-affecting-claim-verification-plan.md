# Verdict-affecting claim verification remediation plan

## Status

Checkpoint A implemented on 2026-09-13. Broader final-only claim verification
remains deferred and requires a separate decision before adding another call.

Broader follow-up is now tracked by
[#161](https://github.com/dills122/independent-reviewer/issues/161), Stage B of
the [correctness delivery plan](2026-09-14-correctness-engineering-review-plan.md).
It includes content-bound claim continuity, deterministic inconclusive handling,
and review of every outcome-affecting category. Checkpoint A remains complete;
no new runtime behavior is claimed here.

## Objective

Close the observed preliminary concern category escape without adding another
review stage. Preserve blind review, author separation, conservative uncertainty
handling, language neutrality, and runner-owned bookkeeping.

## Incident diagnosis

### Reproduction

- Exact fixture: `requirements/wrong_concern`.
- Frozen snapshot digest:
  `1205c1a62d9f001a01776a7a296fec764c0f17c2c789aeb9e4a74a9cb8daaca7`.
- Dry-run: admitted, zero provider calls.
- Paid run: two successful CoreWeave calls, 21,737 ms,
  `$0.00051348`, `UNABLE_TO_VERIFY`; expected `READY`.
- Preliminary: zero findings, zero evidence gaps, one limitation.
- Verification: empty local V2 artifact, because finding count was zero.
- Final: zero findings, two limitations after retaining and restating the same
  unsupported invalid-input premise.

### What worked

- Capture, focused evidence, identities, provider routing, structured output,
  ledger persistence, and cost accounting all completed.
- Preliminary and final prose both recognized correct in-domain pagination
  behavior and rejected the author's off-by-one concern.
- Runner did not trust raw `NOT_READY`; it deterministically derived
  `UNABLE_TO_VERIFY` from formal limitations.
- Author content remained withheld from blind stage.

### What failed

1. `findings` are adversarially verified; `evidenceGaps` and `limitations` are
   not.
2. Preliminary schema defines gaps and limitations only as non-empty strings;
   it does not bind them to an in-scope obligation or missing evidence.
3. Final candidate accepts another free-form `limitations` array, so a rejected
   or irrelevant premise can be restated outside preliminary dispositions.
4. `INCONCLUSIVE` finding judgments are not currently forced out of the finding
   channel.
5. Final-only findings and limitations can affect verdict without a fresh
   challenge.
6. Mock regression fixed the known representation—an invalid-domain finding—but
   did not test the invariant across every verdict-affecting category.
7. Paid confirmation used a fixture whose preliminary classification varies, so
   it could complete without exercising V2 verification.

### Root cause

Verification boundary was defined around one response field instead of one
security/reliability property. Unsupported semantic claims can change category
while remaining structurally valid. Model variance exposed that design gap;
transport and runner bookkeeping did not cause it.

## Architecture direction

Use existing Zod and JSON Schema stack for structure. Add no dependency: semantic
scope cannot be delegated to a parsing or validation library.

Introduce versioned preliminary-claim verification with two ordered ledgers:

1. Finding judgments answer whether changed evidence demonstrates a violation.
2. Uncertainty judgments answer whether unavailable evidence genuinely prevents
   evaluation of an in-scope obligation.

Provider never repeats identities. Runner binds judgments by position, persists
them before author disclosure, and maps statuses to final eligibility. Final
candidate limitations become runner-owned output assembled from verified
preliminary concerns and deterministic runtime evidence. Final-only adverse
claim verification remains deferred.

## Task list

### Task 1: Add invariant-level red tests

**Scope:** Small.

Add a provider-mock regression for the exact limitation-only category escape and
a genuine missing-evidence control.

**Acceptance criteria:**

- Unsupported limitation-only premise cannot produce `UNABLE_TO_VERIFY`.
- Genuine unavailable required evidence remains `UNABLE_TO_VERIFY`.
- Tests fail against current implementation for the expected boundary reasons.

**Likely files:**

- `test/orchestrator/two-stage-review.test.ts`
- `test/contracts/finding-verification.test.ts`

**Status:** Complete.

### Task 2: Define preliminary-claim verification contract

**Scope:** Medium.

Add versioned provider candidate and persisted artifact with ordered finding and
uncertainty judgments. Retain V1/V2 finding-verification readers.

**Acceptance criteria:**

- Status vocabularies are category-specific and unambiguous.
- Exact count, ordering, identity binding, digest binding, and duplicate/missing
  rejection are contract-tested.
- Generated schemas and package exports are committed.

**Implemented files:**

- `src/contracts/finding-verification.ts`
- `src/contracts/index.ts`
- `scripts/write-json-schemas.ts`
- `test/contracts/finding-verification.test.ts`
- `schemas/finding-verification-*.schema.json`

**Dependency:** Task 1. **Status:** Complete in commit `5fbfbb3`.

### Task 3: Generalize blind verifier orchestration

**Scope:** Medium.

Call fresh verifier whenever findings, evidence gaps, or limitations exist.
Preserve empty local artifact only when all three collections are empty. Keep
author packet absent and reuse frozen evidence.

**Acceptance criteria:**

- Limitation-only preliminary output triggers exactly one fresh blind call.
- Empty adverse-claim set remains a two-call review.
- Provider sees no author content or runner-owned identities.
- Reservation, retries, ledger events, and resume state use new protocol.

**Likely files:**

- `src/orchestrator/two-stage-review.ts`
- `src/orchestrator/response-schema.ts`
- `src/contracts/run-record-event.ts`
- `test/orchestrator/two-stage-review.test.ts`

**Dependency:** Task 2. **Status:** Complete.

### Task 4: Make preliminary concern projection exhaustive

**Scope:** Medium.

Map preliminary concern verification statuses deterministically. Unsupported
concerns resolve; demonstrated or inconclusive blocking uncertainty remains.

**Acceptance criteria:**

- `NO_VIOLATION` finding is withdrawn.
- `NO_BLOCKING_UNCERTAINTY` concern cannot remain or be restated as a limitation.
- Demonstrated/inconclusive blocking uncertainty remains visible and prevents
  `READY`.

**Likely files:**

- `src/report/final-review-candidate.ts`
- `src/orchestrator/two-stage-review.ts`
- `src/orchestrator/standards-policy.ts`
- `test/contracts/review-results.test.ts`
- `test/orchestrator/two-stage-review.test.ts`

**Dependency:** Task 3. **Status:** Complete for preliminary concerns;
inconclusive finding projection remains deferred.

### Checkpoint A: Observed failure closed offline

- Exact `wrong_concern` limitation path passes through a fresh verifier.
- Genuine missing-context control remains fail-closed.
- Targeted contracts, schemas, build, and focused integration tests pass.
- No paid call yet.

### Task 5: Own final limitations

**Scope:** Medium.

Constrain active final-candidate V3 to an empty provider limitations array.
Runner assembles readable report limitations from verified preliminary concern
dispositions, coverage constraints, and standards state.

**Acceptance criteria:**

- Rejected preliminary premise cannot re-enter through final limitations.
- Standards conflict, unassessed-rule, reference-capture, and coverage
  limitations keep existing outcomes.
- Old/new verification and resume artifacts cannot mix.

**Likely files:**

- `src/contracts/review-results.ts`
- `src/report/final-review-candidate.ts`
- `src/orchestrator/response-schema.ts`
- `test/contracts/review-results.test.ts`
- `test/orchestrator/response-schema.test.ts`

**Dependency:** Task 4. **Status:** Complete for final limitations. Explicit
final-only uncertainty claims remain deferred.

### Task 6: Verify final-only adverse claims selectively

**Scope:** Medium.

Freshly verify final-only findings and uncertainty claims that arise after author
context. Skip call when final candidate introduces none. Define summary handling
so rejected claims cannot leave contradictory report prose.

**Acceptance criteria:**

- Every final-only verdict-affecting claim has persisted fresh judgment.
- Unsupported final-only claim cannot change verdict or report summary.
- Author packet is treated as untrusted evidence and is available only in this
  post-author verifier.
- Cost ceiling reserves new worst-case path before first paid call.

**Likely files:**

- `src/contracts/final-claim-verification.ts`
- `src/orchestrator/two-stage-review.ts`
- `src/report/final-review-candidate.ts`
- `test/contracts/final-claim-verification.test.ts`
- `test/orchestrator/two-stage-review.test.ts`

**Dependency:** Task 5. **Status:** Deferred; no fourth call is part of this fix.

### Checkpoint B: Broader invariant enforcement — deferred

- All model-authored verdict channels are verified or provenance-bound.
- Typical clean path remains two calls.
- Worst-case reservation, retry, resume, and unknown-cost behavior are tested.
- `npm run schemas:write`, `npm run check`, and
  `python3 -B scripts/check-ai-context.py --ci` pass.

### Task 7: Document and run controlled E2E gates

**Scope:** Small.

Update architecture, ADR status, user-visible cost behavior, and validation log.
Then run paid gates only with explicit approval.

**Acceptance criteria:**

- Provider-free exact fixture and complete dry matrix pass with zero calls.
- A direct paid verifier canary guarantees new judgment path is exercised.
- One full paid `wrong_concern` run returns exact `READY` whether preliminary
  emits no concern or an unsupported concern.
- Any repeat sample is fixed in advance and reports every result; no retrying to
  shop for a favorable verdict.

**Likely files:**

- `docs/architecture-and-roadmap.md`
- `docs/decisions/016-verify-every-verdict-affecting-review-claim.md`
- `docs/validation/2026-09-12-durable-ledger-live-matrix.md`
- `README.md`

**Dependency:** Checkpoint A and separate paid-run approval. Broader final-only
canaries remain blocked on Checkpoint B.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| More provider calls | Cost and latency increase on adverse-claim paths | Keep calls selective; preserve two-call clean path; reserve worst case before call one |
| Verifier rejects real concern | False green | Genuine missing-reference controls; inconclusive remains fail-closed limitation |
| Final-only claim changes summary then gets rejected | Internally inconsistent report | Version candidate and make final summary projection or repair part of Task 6 acceptance |
| Resume mixes protocol generations | Author leakage or incorrect reuse | Exact schema/prompt/request digest checks before provider access |
| Overfit to pagination fixture | General tool remains brittle | Category-specific statuses, exact-scope tests, and a genuine missing-evidence control; no keyword filters |
| Contract scope expands too far | Hard-to-review patch | Land Tasks 1-4, checkpoint, then Tasks 5-6; each commit independently green |

## Explicit non-goals

- No parsing of correction or limitation prose.
- No JavaScript/TypeScript-specific defect rules.
- No weakening of real limitations to obtain green verdicts.
- No replacement of existing Zod/JSON Schema libraries.
- No further paid retries before offline checkpoints pass.
