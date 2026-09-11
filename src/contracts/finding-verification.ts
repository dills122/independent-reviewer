import * as z from "zod";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import { DigestV1Schema } from "./snapshot-manifest.js";

const FindingVerificationAssessmentV1Schema = z.strictObject({
  preliminaryFindingId: prefixedIdentifier("finding"),
  status: z.enum(["CONFIRMED", "REJECTED", "INCONCLUSIVE"]),
  rationale: NonEmptyTextSchema.max(400),
});

export const FindingVerificationV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    stage: z.literal("FINDING_VERIFICATION"),
    snapshotDigest: DigestV1Schema,
    briefDigest: DigestV1Schema,
    assessments: z.array(FindingVerificationAssessmentV1Schema).max(40),
  })
  .superRefine((verification, context) => {
    const ids = verification.assessments.map((assessment) => assessment.preliminaryFindingId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "preliminary finding IDs must be unique",
        path: ["assessments"],
      });
    }
  });

export type FindingVerificationV1 = z.infer<typeof FindingVerificationV1Schema>;

/** Requires one adversarial assessment for every persisted preliminary finding. */
export function assertFindingVerificationScopeV1(
  verification: FindingVerificationV1,
  preliminaryFindingIds: string[],
): void {
  const expected = new Set(preliminaryFindingIds);
  const actual = verification.assessments.map((assessment) => assessment.preliminaryFindingId);
  if (
    actual.length !== expected.size ||
    actual.some((findingId) => !expected.has(findingId)) ||
    [...expected].some((findingId) => !actual.includes(findingId))
  ) {
    throw new Error("Finding verification must assess every preliminary finding exactly once.");
  }
}

export const FINDING_VERIFICATION_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:finding-verification:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(FindingVerificationV1Schema, { target: "draft-2020-12", io: "output" }),
};
