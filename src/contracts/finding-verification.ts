import * as z from "zod";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import { DigestV1Schema } from "./snapshot-manifest.js";

const FindingVerificationJudgmentV1Schema = z.strictObject({
  status: z.enum(["CONFIRMED", "REJECTED", "INCONCLUSIVE"]),
  rationale: NonEmptyTextSchema.max(400),
});

const FindingVerificationJudgmentV2Schema = z.strictObject({
  status: z.enum(["VIOLATION_DEMONSTRATED", "NO_VIOLATION", "INCONCLUSIVE"]),
  rationale: NonEmptyTextSchema.max(400),
});

const ConcernVerificationJudgmentV3Schema = z.strictObject({
  status: z.enum(["BLOCKING_UNCERTAINTY_DEMONSTRATED", "NO_BLOCKING_UNCERTAINTY", "INCONCLUSIVE"]),
  rationale: NonEmptyTextSchema.max(400),
});

const FindingVerificationAssessmentV1Schema = z.strictObject({
  preliminaryFindingId: prefixedIdentifier("finding"),
  ...FindingVerificationJudgmentV1Schema.shape,
});

const FindingVerificationAssessmentV2Schema = z.strictObject({
  preliminaryFindingId: prefixedIdentifier("finding"),
  ...FindingVerificationJudgmentV2Schema.shape,
});

const ConcernVerificationAssessmentV3Schema = z.strictObject({
  kind: z.enum(["EVIDENCE_GAP", "LIMITATION"]),
  concernIndex: z.int().nonnegative(),
  ...ConcernVerificationJudgmentV3Schema.shape,
});

export const FindingVerificationCandidateV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  stage: z.literal("FINDING_VERIFICATION"),
  snapshotDigest: DigestV1Schema,
  briefDigest: DigestV1Schema,
  assessments: z.array(FindingVerificationJudgmentV1Schema).max(40),
});

export const FindingVerificationCandidateV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  stage: z.literal("FINDING_VERIFICATION"),
  snapshotDigest: DigestV1Schema,
  briefDigest: DigestV1Schema,
  assessments: z.array(FindingVerificationJudgmentV2Schema).max(40),
});

export const FindingVerificationCandidateV3Schema = z.strictObject({
  schemaVersion: z.literal(3),
  stage: z.literal("FINDING_VERIFICATION"),
  snapshotDigest: DigestV1Schema,
  briefDigest: DigestV1Schema,
  assessments: z.array(FindingVerificationJudgmentV2Schema).max(40),
  concernAssessments: z.array(ConcernVerificationJudgmentV3Schema).max(80),
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

export const FindingVerificationV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    stage: z.literal("FINDING_VERIFICATION"),
    snapshotDigest: DigestV1Schema,
    briefDigest: DigestV1Schema,
    assessments: z.array(FindingVerificationAssessmentV2Schema).max(40),
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

export const FindingVerificationV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    stage: z.literal("FINDING_VERIFICATION"),
    snapshotDigest: DigestV1Schema,
    briefDigest: DigestV1Schema,
    assessments: z.array(FindingVerificationAssessmentV2Schema).max(40),
    concernAssessments: z.array(ConcernVerificationAssessmentV3Schema).max(80),
  })
  .superRefine((verification, context) => {
    const findingIds = verification.assessments.map(
      (assessment) => assessment.preliminaryFindingId,
    );
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        message: "preliminary finding IDs must be unique",
        path: ["assessments"],
      });
    }
    const concernKeys = verification.concernAssessments.map(
      (assessment) => `${assessment.kind}:${assessment.concernIndex}`,
    );
    if (new Set(concernKeys).size !== concernKeys.length) {
      context.addIssue({
        code: "custom",
        message: "preliminary concern identities must be unique",
        path: ["concernAssessments"],
      });
    }
  });

export type FindingVerificationV1 = z.infer<typeof FindingVerificationV1Schema>;
export type FindingVerificationCandidateV1 = z.infer<typeof FindingVerificationCandidateV1Schema>;
export type FindingVerificationV2 = z.infer<typeof FindingVerificationV2Schema>;
export type FindingVerificationCandidateV2 = z.infer<typeof FindingVerificationCandidateV2Schema>;
export type FindingVerificationV3 = z.infer<typeof FindingVerificationV3Schema>;
export type FindingVerificationCandidateV3 = z.infer<typeof FindingVerificationCandidateV3Schema>;
export type PreliminaryConcernIdentityV3 = Pick<
  z.infer<typeof ConcernVerificationAssessmentV3Schema>,
  "kind" | "concernIndex"
>;

/** Binds ordered provider judgments to runner-owned preliminary finding identities. */
export function assembleFindingVerificationV1(
  candidate: FindingVerificationCandidateV1,
  preliminaryFindingIds: string[],
): FindingVerificationV1 {
  if (candidate.assessments.length !== preliminaryFindingIds.length) {
    throw new Error("Finding verification must return exactly one judgment per frozen finding.");
  }
  return FindingVerificationV1Schema.parse({
    ...candidate,
    assessments: candidate.assessments.map((assessment, index) => ({
      preliminaryFindingId: preliminaryFindingIds[index],
      ...assessment,
    })),
  });
}

/** Binds unambiguous ordered provider judgments to runner-owned finding identities. */
export function assembleFindingVerificationV2(
  candidate: FindingVerificationCandidateV2,
  preliminaryFindingIds: string[],
): FindingVerificationV2 {
  if (candidate.assessments.length !== preliminaryFindingIds.length) {
    throw new Error("Finding verification must return exactly one judgment per frozen finding.");
  }
  return FindingVerificationV2Schema.parse({
    ...candidate,
    assessments: candidate.assessments.map((assessment, index) => ({
      preliminaryFindingId: preliminaryFindingIds[index],
      ...assessment,
    })),
  });
}

/** Binds ordered provider judgments to runner-owned finding and concern identities. */
export function assembleFindingVerificationV3(
  candidate: FindingVerificationCandidateV3,
  preliminaryFindingIds: string[],
  preliminaryConcerns: PreliminaryConcernIdentityV3[],
): FindingVerificationV3 {
  if (candidate.assessments.length !== preliminaryFindingIds.length) {
    throw new Error("Finding verification must return exactly one judgment per frozen finding.");
  }
  if (candidate.concernAssessments.length !== preliminaryConcerns.length) {
    throw new Error("Finding verification must return exactly one judgment per frozen concern.");
  }
  return FindingVerificationV3Schema.parse({
    ...candidate,
    assessments: candidate.assessments.map((assessment, index) => ({
      preliminaryFindingId: preliminaryFindingIds[index],
      ...assessment,
    })),
    concernAssessments: candidate.concernAssessments.map((assessment, index) => ({
      ...preliminaryConcerns[index],
      ...assessment,
    })),
  });
}

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

/** Requires one V2 adversarial assessment for every persisted preliminary finding. */
export function assertFindingVerificationScopeV2(
  verification: FindingVerificationV2,
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

/** Requires one V3 judgment for every persisted preliminary finding and concern. */
export function assertFindingVerificationScopeV3(
  verification: FindingVerificationV3,
  preliminaryFindingIds: string[],
  preliminaryConcerns: PreliminaryConcernIdentityV3[],
): void {
  assertFindingVerificationScopeV2({ ...verification, schemaVersion: 2 }, preliminaryFindingIds);
  const expected = new Set(
    preliminaryConcerns.map((concern) => `${concern.kind}:${concern.concernIndex}`),
  );
  const actual = verification.concernAssessments.map(
    (assessment) => `${assessment.kind}:${assessment.concernIndex}`,
  );
  if (
    actual.length !== expected.size ||
    actual.some((concern) => !expected.has(concern)) ||
    [...expected].some((concern) => !actual.includes(concern))
  ) {
    throw new Error("Finding verification must assess every preliminary concern exactly once.");
  }
}

export const FINDING_VERIFICATION_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:finding-verification:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(FindingVerificationV1Schema, { target: "draft-2020-12", io: "output" }),
};

export const FINDING_VERIFICATION_CANDIDATE_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:finding-verification-candidate:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(FindingVerificationCandidateV1Schema, {
    target: "draft-2020-12",
    io: "output",
  }),
};

export const FINDING_VERIFICATION_V2_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:finding-verification:v2",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(FindingVerificationV2Schema, { target: "draft-2020-12", io: "output" }),
};

export const FINDING_VERIFICATION_CANDIDATE_V2_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:finding-verification-candidate:v2",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(FindingVerificationCandidateV2Schema, {
    target: "draft-2020-12",
    io: "output",
  }),
};

export const FINDING_VERIFICATION_V3_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:finding-verification:v3",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(FindingVerificationV3Schema, { target: "draft-2020-12", io: "output" }),
};

export const FINDING_VERIFICATION_CANDIDATE_V3_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:finding-verification-candidate:v3",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(FindingVerificationCandidateV3Schema, {
    target: "draft-2020-12",
    io: "output",
  }),
};
