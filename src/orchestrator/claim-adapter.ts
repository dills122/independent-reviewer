import { canonicalizeJson } from "../contracts/canonical-json.js";
import type { ReviewBrief } from "../contracts/neutral-review-brief.js";
import { compareUtf16 } from "../contracts/primitives.js";
import {
  assembleReviewClaimSetV1,
  identifyReviewClaimV1,
  type ReviewClaimCoreV1,
  type ReviewClaimSetV1,
  ReviewClaimSetV1Schema,
} from "../contracts/review-claims.js";
import type { ReviewPreliminary, ReviewReport } from "../contracts/standards-results.js";
import { selectedRules } from "../contracts/standards-review.js";
import { ClaimTransitionProposalV1Schema } from "../report/claim-projection.js";

function canonicalUnique<T>(values: T[]): T[] {
  return [...new Map(values.map((value) => [canonicalizeJson(value), value])).entries()]
    .sort(([a], [b]) => compareUtf16(a, b))
    .map(([, value]) => value);
}

/** Bind semantic evidence only; source identifiers and presentation are excluded. */
export function reviewClaimSetV1(brief: ReviewBrief, review: ReviewPreliminary | ReviewReport) {
  const mode = brief.schemaVersion === 1 ? "REQUIREMENTS" : "STANDARDS";
  if (
    (review.schemaVersion === 1 ? "REQUIREMENTS" : "STANDARDS") !== mode ||
    canonicalizeJson(review.snapshotDigest) !==
      canonicalizeJson(brief.snapshotManifest.snapshotDigest) ||
    canonicalizeJson(review.briefDigest) !== canonicalizeJson(brief.briefDigest)
  )
    throw new Error("Review claim binding or mode mismatch");
  const binding = { snapshotDigest: review.snapshotDigest, briefDigest: review.briefDigest };
  const owners = new Map<string, string>();
  if (brief.schemaVersion !== 1)
    for (const input of brief.canonicalInputs.standards) {
      for (const rule of selectedRules({ standards: [input] })) owners.set(rule.id, input.id);
    }
  const obligations = (ruleIds?: string[]) =>
    canonicalUnique<{ canonicalInputId: string; ruleId: string | null }>(
      mode === "REQUIREMENTS"
        ? brief.snapshotManifest.canonicalInputs.map((input) => ({
            canonicalInputId: input.id,
            ruleId: null,
          }))
        : (ruleIds ?? [...owners.keys()]).map((ruleId) => {
            const canonicalInputId = owners.get(ruleId);
            if (!canonicalInputId) throw new Error(`Unknown claim rule: ${ruleId}`);
            return { canonicalInputId, ruleId };
          }),
    );
  const cores = new Map<string, ReviewClaimCoreV1>();
  function add(core: ReviewClaimCoreV1) {
    const claim = identifyReviewClaimV1(binding, core);
    cores.set(claim.claimId, claim.core);
    return claim.claimId;
  }
  const findingClaims: Record<string, string> = {};
  for (const finding of review.findings) {
    const assertion = "scenario" in finding ? finding.scenario : finding.problem;
    findingClaims[finding.id] = add({
      mode,
      kind: "VIOLATION",
      obligations: obligations("ruleIds" in finding ? finding.ruleIds : undefined),
      scenario: {
        preconditions: "The conditions stated in the observed result hold.",
        action: "Execute the behavior described in the observed result.",
        observedResult: assertion,
        expectedResult: "Satisfy the cited canonical obligations under those conditions.",
      },
      evidence: canonicalUnique(finding.evidence.map(({ detail: _detail, ...anchor }) => anchor)),
      assertion,
      correction: finding.correction,
      effect:
        "scenario" in finding
          ? { kind: "REQUIREMENTS", severity: finding.severity }
          : { kind: "STANDARDS", enforcement: finding.severity },
    });
  }
  const concernClaims: Array<{
    kind: "EVIDENCE_GAP" | "LIMITATION";
    concernIndex: number;
    claimId: string;
  }> = [];
  function concern(kind: "EVIDENCE_GAP" | "LIMITATION", concernIndex: number, assertion: string) {
    concernClaims.push({
      kind,
      concernIndex,
      claimId: add({
        mode,
        kind: "BLOCKING_UNCERTAINTY",
        obligations: obligations(),
        scenario: null,
        evidence: [],
        assertion,
        correction: null,
        effect: { kind: "BLOCKING_UNCERTAINTY" },
      }),
    });
  }
  if (review.stage === "PRELIMINARY") {
    review.evidenceGaps.forEach((text, index) => {
      concern("EVIDENCE_GAP", index, text);
    });
    review.limitations.forEach((text, index) => {
      concern("LIMITATION", index, text);
    });
  } else
    review.preliminaryConcernDispositions.forEach((entry, index) => {
      if (entry.disposition === "REMAINS") concern(entry.kind, index, entry.preliminaryConcern);
    });
  const ruleClaims: Record<string, string> = {};
  if (review.schemaVersion !== 1)
    for (const assessment of review.ruleAssessments) {
      if (assessment.status === "ASSESSED") continue;
      ruleClaims[assessment.ruleId] = add({
        mode,
        kind: "STANDARD_STATUS",
        obligations: obligations([assessment.ruleId, ...assessment.conflictingRuleIds]),
        scenario: null,
        evidence: [],
        assertion: assessment.explanation,
        correction: null,
        effect: {
          kind: "STANDARD_STATUS",
          ruleId: assessment.ruleId,
          status: assessment.status,
          conflictingRuleIds: canonicalUnique(assessment.conflictingRuleIds),
        },
      });
    }
  return {
    set: assembleReviewClaimSetV1(binding, [...cores.values()]),
    findingClaims,
    concernClaims,
    ruleClaims,
  };
}

export function prepareClaimProposalV1(priorValue: ReviewClaimSetV1, finalValue: ReviewClaimSetV1) {
  const prior = ReviewClaimSetV1Schema.parse(priorValue);
  const final = ReviewClaimSetV1Schema.parse(finalValue);
  if (
    canonicalizeJson([prior.snapshotDigest, prior.briefDigest]) !==
    canonicalizeJson([final.snapshotDigest, final.briefDigest])
  )
    throw new Error("Claim proposal binding mismatch");
  const previous = new Set(prior.claims.map((claim) => claim.claimId));
  const next = new Set(final.claims.map((claim) => claim.claimId));
  return ClaimTransitionProposalV1Schema.parse({
    continuedClaimIds: prior.claims
      .filter((claim) => next.has(claim.claimId))
      .map((claim) => claim.claimId),
    withdrawnClaimIds: prior.claims
      .filter((claim) => !next.has(claim.claimId))
      .map((claim) => claim.claimId),
    newClaims: final.claims
      .filter((claim) => !previous.has(claim.claimId))
      .map((claim) => claim.core),
  });
}
