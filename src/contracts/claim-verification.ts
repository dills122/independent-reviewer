import * as z from "zod";
import { cloneCanonicalJson, digestCanonicalJson } from "./canonical-json.js";
import {
  deriveFindingVerificationStatusV4,
  FindingVerificationBasisV4Schema,
} from "./finding-verification.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { ClaimRationaleV1Schema } from "./primitives.js";
import {
  ReviewClaimIdV1Schema,
  type ReviewClaimSetV1,
  ReviewClaimSetV1Schema,
} from "./review-claims.js";
import { DigestV1Schema } from "./snapshot-manifest.js";

const stage = z.enum(["FINDING_VERIFICATION", "FINAL_CLAIM_VERIFICATION"]);
const status = z.enum(["DEMONSTRATED", "REJECTED", "INCONCLUSIVE"]);
const correctionStatus = z.enum(["SUPPORTED", "REJECTED", "INCONCLUSIVE"]);
const duplicateReference = z
  .strictObject({ source: z.enum(["TARGET", "CARRIED"]), index: z.int().nonnegative() })
  .nullable();
const common = { duplicateOf: duplicateReference, rationale: ClaimRationaleV1Schema };
const CandidateAssessmentV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...FindingVerificationBasisV4Schema.shape,
    ...common,
    kind: z.literal("VIOLATION"),
    correctionStatus,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("BLOCKING_UNCERTAINTY"),
    status,
    correctionStatus: z.null(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("STANDARD_STATUS"),
    status,
    correctionStatus: z.null(),
  }),
]);
export const ClaimVerificationCandidateV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  stage,
  assessments: z.array(CandidateAssessmentV1Schema).max(1024),
});
export const ClaimVerificationAssessmentV1Schema = z.strictObject({
  claimId: ReviewClaimIdV1Schema,
  status,
  correctionStatus: correctionStatus.nullable(),
  duplicateOf: ReviewClaimIdV1Schema.nullable(),
  rationale: ClaimRationaleV1Schema,
});
export const ClaimVerificationV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  stage,
  snapshotDigest: DigestV1Schema,
  briefDigest: DigestV1Schema,
  targetSetDigest: DigestV1Schema,
  catalogSetDigest: DigestV1Schema,
  assessments: z.array(ClaimVerificationAssessmentV1Schema).max(1024),
});
export type ClaimVerificationV1 = z.infer<typeof ClaimVerificationV1Schema>;
export type ClaimVerificationAssessmentV1 = z.infer<typeof ClaimVerificationAssessmentV1Schema>;

function validateSets(targetInput: ReviewClaimSetV1, catalogInput: ReviewClaimSetV1) {
  const targets = ReviewClaimSetV1Schema.parse(cloneCanonicalJson(targetInput));
  const catalog = ReviewClaimSetV1Schema.parse(cloneCanonicalJson(catalogInput));
  if (
    targets.snapshotDigest.value !== catalog.snapshotDigest.value ||
    targets.briefDigest.value !== catalog.briefDigest.value
  )
    throw new Error("Claim verification bindings do not match.");
  const ids = new Set(targets.claims.map(({ claimId }) => claimId));
  if (catalog.claims.some(({ claimId }) => ids.has(claimId)))
    throw new Error("Target and carried claim sets must be disjoint.");
  return { targets, catalog };
}

/** Validate context as well as structure before consuming a persisted judgment ledger. */
export function assertClaimVerificationV1(
  value: unknown,
  targetInput: ReviewClaimSetV1,
  catalogInput: ReviewClaimSetV1,
): ClaimVerificationV1 {
  const { targets, catalog } = validateSets(targetInput, catalogInput);
  const record = ClaimVerificationV1Schema.parse(cloneCanonicalJson(value));
  if (
    record.snapshotDigest.value !== targets.snapshotDigest.value ||
    record.briefDigest.value !== targets.briefDigest.value ||
    record.targetSetDigest.value !== digestCanonicalJson(targets).value ||
    record.catalogSetDigest.value !== digestCanonicalJson(catalog).value
  )
    throw new Error("Claim verification identity or set digest mismatch.");
  if (record.assessments.length !== targets.claims.length)
    throw new Error("Claim verification must cover every target exactly once.");
  const catalogById = new Map(catalog.claims.map((claim) => [claim.claimId, claim]));
  for (const [index, assessment] of record.assessments.entries()) {
    const claim = targets.claims[index];
    if (!claim || assessment.claimId !== claim.claimId)
      throw new Error("Claim verification target order mismatch.");
    if ((claim.core.kind === "VIOLATION") !== (assessment.correctionStatus !== null))
      throw new Error("Correction judgment does not match claim kind.");
    if (!assessment.duplicateOf) continue;
    const priorIndex = targets.claims.findIndex(
      ({ claimId }) => claimId === assessment.duplicateOf,
    );
    const duplicate =
      priorIndex >= 0 ? targets.claims[priorIndex] : catalogById.get(assessment.duplicateOf);
    if (
      assessment.status !== "DEMONSTRATED" ||
      claim.core.kind !== "VIOLATION" ||
      !duplicate ||
      duplicate.core.kind !== claim.core.kind ||
      duplicate.core.mode !== claim.core.mode ||
      (priorIndex >= 0 &&
        (priorIndex >= index || record.assessments[priorIndex]?.status !== "DEMONSTRATED"))
    ) {
      throw new Error("Invalid duplicate claim relation.");
    }
  }
  return record;
}

/** Bind ordered, ID-free model output to exact targets and an immutable comparison catalog. */
export function assembleClaimVerificationV1(
  targetInput: ReviewClaimSetV1,
  catalogInput: ReviewClaimSetV1,
  value: unknown,
): ClaimVerificationV1 {
  const { targets, catalog } = validateSets(targetInput, catalogInput);
  const candidate = ClaimVerificationCandidateV1Schema.parse(cloneCanonicalJson(value));
  if (candidate.assessments.length !== targets.claims.length)
    throw new Error("Claim verification must return exactly one assessment per target.");
  const assessments = candidate.assessments.map((assessment, index) => {
    const claim = targets.claims[index];
    if (!claim || claim.core.kind !== assessment.kind)
      throw new Error("Claim verification kind does not match target.");
    const derived =
      assessment.kind === "VIOLATION" ? deriveFindingVerificationStatusV4(assessment) : null;
    const judgment =
      assessment.kind !== "VIOLATION"
        ? assessment.status
        : derived === "VIOLATION_DEMONSTRATED"
          ? "DEMONSTRATED"
          : derived === "NO_VIOLATION"
            ? "REJECTED"
            : "INCONCLUSIVE";
    const duplicateOf =
      assessment.duplicateOf === null
        ? null
        : (assessment.duplicateOf.source === "TARGET" ? targets : catalog).claims[
            assessment.duplicateOf.index
          ]?.claimId;
    if (duplicateOf === undefined)
      throw new Error("Duplicate reference is outside the supplied claim catalog.");
    return {
      claimId: claim.claimId,
      status: judgment,
      correctionStatus: assessment.correctionStatus,
      duplicateOf,
      rationale: assessment.rationale,
    };
  });
  return assertClaimVerificationV1(
    {
      schemaVersion: 1,
      stage: candidate.stage,
      snapshotDigest: targets.snapshotDigest,
      briefDigest: targets.briefDigest,
      targetSetDigest: digestCanonicalJson(targets),
      catalogSetDigest: digestCanonicalJson(catalog),
      assessments,
    },
    targets,
    catalog,
  );
}

export const CLAIM_VERIFICATION_CANDIDATE_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:claim-verification-candidate:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ClaimVerificationCandidateV1Schema, { target: "draft-2020-12", io: "output" }),
};
export const CLAIM_VERIFICATION_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:claim-verification:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ClaimVerificationV1Schema, { target: "draft-2020-12", io: "output" }),
};
