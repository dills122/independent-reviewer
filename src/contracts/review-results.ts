import * as z from "zod";

import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { DigestV1Schema, SnapshotPathV1Schema } from "./snapshot-manifest.js";

const NonEmptyTextSchema = z.string().min(1);
const FindingIdSchema = z
  .string()
  .min(9)
  .max(128)
  .regex(/^finding_[A-Za-z0-9][A-Za-z0-9_-]*$/, "must use the finding_ identifier prefix");

export const ReviewFindingV1Schema = z.strictObject({
  id: FindingIdSchema,
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  title: NonEmptyTextSchema,
  scenario: NonEmptyTextSchema,
  impact: NonEmptyTextSchema,
  evidence: z
    .array(
      z.strictObject({
        path: SnapshotPathV1Schema,
        detail: NonEmptyTextSchema,
      }),
    )
    .min(1),
  correction: NonEmptyTextSchema,
});

function requireUniqueFindingIds(
  findings: Array<z.infer<typeof ReviewFindingV1Schema>>,
  context: z.RefinementCtx,
): void {
  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "finding identifiers must be unique" });
  }
}

export const PreliminaryAssessmentV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    stage: z.literal("PRELIMINARY"),
    snapshotDigest: DigestV1Schema,
    briefDigest: DigestV1Schema,
    summary: NonEmptyTextSchema,
    inspectedPaths: z.array(SnapshotPathV1Schema),
    findings: z.array(ReviewFindingV1Schema),
    evidenceGaps: z.array(NonEmptyTextSchema),
    limitations: z.array(NonEmptyTextSchema),
    nextAction: z.literal("REQUEST_AUTHOR_PACKET"),
  })
  .superRefine((assessment, context) => {
    requireUniqueFindingIds(assessment.findings, context);
    if (new Set(assessment.inspectedPaths).size !== assessment.inspectedPaths.length) {
      context.addIssue({
        code: "custom",
        message: "inspected paths must be unique",
        path: ["inspectedPaths"],
      });
    }
  });

export const FinalReviewReportV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    stage: z.literal("FINAL"),
    snapshotDigest: DigestV1Schema,
    briefDigest: DigestV1Schema,
    summary: NonEmptyTextSchema,
    findings: z.array(ReviewFindingV1Schema),
    preliminaryFindingDispositions: z.array(
      z.strictObject({
        preliminaryFindingId: FindingIdSchema,
        disposition: z.enum(["RETAINED", "REVISED", "WITHDRAWN", "MERGED"]),
        finalFindingId: FindingIdSchema.nullable(),
        rationale: NonEmptyTextSchema,
      }),
    ),
    authorClaims: z.array(
      z.strictObject({
        claim: NonEmptyTextSchema,
        status: z.enum(["CONFIRMED", "CONTRADICTED", "UNVERIFIED"]),
        explanation: NonEmptyTextSchema,
      }),
    ),
    limitations: z.array(NonEmptyTextSchema),
    verdict: z.enum(["READY", "READY_WITH_FOLLOW_UPS", "NOT_READY", "UNABLE_TO_VERIFY"]),
    nextActions: z.strictObject({
      blockers: z.array(NonEmptyTextSchema),
      fastFollows: z.array(NonEmptyTextSchema),
    }),
  })
  .superRefine((report, context) => {
    requireUniqueFindingIds(report.findings, context);
    const dispositionIds = report.preliminaryFindingDispositions.map(
      (disposition) => disposition.preliminaryFindingId,
    );
    if (new Set(dispositionIds).size !== dispositionIds.length) {
      context.addIssue({
        code: "custom",
        message: "preliminary finding dispositions must be unique",
        path: ["preliminaryFindingDispositions"],
      });
    }

    const blockingFinding = report.findings.some(
      (finding) => finding.severity === "P0" || finding.severity === "P1",
    );
    if (
      (report.verdict === "READY" || report.verdict === "READY_WITH_FOLLOW_UPS") &&
      (blockingFinding || report.nextActions.blockers.length > 0 || report.limitations.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "a ready verdict cannot retain blockers, P0/P1 findings, or limitations",
        path: ["verdict"],
      });
    }
    if (report.verdict === "READY_WITH_FOLLOW_UPS" && report.nextActions.fastFollows.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Ready with follow-ups requires at least one fast follow",
        path: ["nextActions", "fastFollows"],
      });
    }
    if (report.verdict === "NOT_READY" && report.nextActions.blockers.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Not ready requires at least one blocker",
        path: ["nextActions", "blockers"],
      });
    }
    if (report.verdict === "UNABLE_TO_VERIFY" && report.limitations.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Unable to verify requires at least one limitation",
        path: ["limitations"],
      });
    }
  });

export type ReviewFindingV1 = z.infer<typeof ReviewFindingV1Schema>;
export type PreliminaryAssessmentV1 = z.infer<typeof PreliminaryAssessmentV1Schema>;
export type FinalReviewReportV1 = z.infer<typeof FinalReviewReportV1Schema>;

export const PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:preliminary-assessment:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(PreliminaryAssessmentV1Schema, { target: "draft-2020-12", io: "output" }),
};

export const FINAL_REVIEW_REPORT_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:final-review-report:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(FinalReviewReportV1Schema, { target: "draft-2020-12", io: "output" }),
};
