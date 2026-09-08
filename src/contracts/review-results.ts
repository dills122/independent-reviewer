import * as z from "zod";

import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { DigestV1Schema, SnapshotPathV1Schema } from "./snapshot-manifest.js";

const NonEmptyTextSchema = z.string().min(1);
const FindingIdSchema = z
  .string()
  .min(9)
  .max(128)
  .regex(/^finding_[A-Za-z0-9][A-Za-z0-9_-]*$/, "must use the finding_ identifier prefix");
const CanonicalInputIdSchema = z
  .string()
  .min(7)
  .max(128)
  .regex(/^input_[A-Za-z0-9][A-Za-z0-9_-]*$/, "must use the input_ identifier prefix");

const LineRangeEvidenceV1Schema = z
  .strictObject({
    path: SnapshotPathV1Schema,
    anchor: z.literal("LINE_RANGE"),
    side: z.enum(["BASE", "HEAD"]),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
    detail: NonEmptyTextSchema,
  })
  .superRefine((evidence, context) => {
    if (evidence.startLine > evidence.endLine) {
      context.addIssue({
        code: "custom",
        message: "must be greater than or equal to startLine",
        path: ["endLine"],
      });
    }
  });

const SymbolEvidenceV1Schema = z.strictObject({
  path: SnapshotPathV1Schema,
  anchor: z.literal("SYMBOL"),
  side: z.enum(["BASE", "HEAD"]),
  symbol: NonEmptyTextSchema,
  detail: NonEmptyTextSchema,
});

export const ReviewEvidenceV1Schema = z.union([LineRangeEvidenceV1Schema, SymbolEvidenceV1Schema]);

const CanonicalInputCoverageV1Schema = z.strictObject({
  canonicalInputId: CanonicalInputIdSchema,
  status: z.enum(["ASSESSED", "UNASSESSED"]),
  explanation: NonEmptyTextSchema,
});

const ChangedPathCoverageV1Schema = z.strictObject({
  path: SnapshotPathV1Schema,
  status: z.enum(["INSPECTED", "UNASSESSED"]),
  explanation: NonEmptyTextSchema,
});

export const ReviewFindingV1Schema = z.strictObject({
  id: FindingIdSchema,
  severity: z.enum(["P0", "P1", "P2", "P3"]),
  title: NonEmptyTextSchema,
  scenario: NonEmptyTextSchema,
  impact: NonEmptyTextSchema,
  evidence: z.array(ReviewEvidenceV1Schema).min(1),
  correction: NonEmptyTextSchema,
});

const FinalReviewFindingV1Schema = ReviewFindingV1Schema.extend({
  origin: z.enum(["PRELIMINARY", "FINAL_ONLY"]),
  emergenceRationale: NonEmptyTextSchema.nullable(),
}).superRefine((finding, context) => {
  if (finding.origin === "FINAL_ONLY" && finding.emergenceRationale === null) {
    context.addIssue({
      code: "custom",
      message: "a final-only finding must explain why it emerged after the blind stage",
      path: ["emergenceRationale"],
    });
  }
  if (finding.origin === "PRELIMINARY" && finding.emergenceRationale !== null) {
    context.addIssue({
      code: "custom",
      message: "a preliminary-origin finding must use a null emergence rationale",
      path: ["emergenceRationale"],
    });
  }
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
    inspectedPaths: z.array(SnapshotPathV1Schema).min(1),
    canonicalInputCoverage: z.array(CanonicalInputCoverageV1Schema).min(1),
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
    const canonicalInputIds = assessment.canonicalInputCoverage.map(
      (coverage) => coverage.canonicalInputId,
    );
    if (new Set(canonicalInputIds).size !== canonicalInputIds.length) {
      context.addIssue({
        code: "custom",
        message: "canonical-input coverage entries must be unique",
        path: ["canonicalInputCoverage"],
      });
    }
    for (const field of ["evidenceGaps", "limitations"] as const) {
      if (new Set(assessment[field]).size !== assessment[field].length) {
        context.addIssue({
          code: "custom",
          message: `${field} entries must be unique`,
          path: [field],
        });
      }
    }
  });

export const FinalReviewReportV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    stage: z.literal("FINAL"),
    snapshotDigest: DigestV1Schema,
    briefDigest: DigestV1Schema,
    summary: NonEmptyTextSchema,
    findings: z.array(FinalReviewFindingV1Schema),
    preliminaryFindingDispositions: z.array(
      z.strictObject({
        preliminaryFindingId: FindingIdSchema,
        disposition: z.enum(["RETAINED", "REVISED", "WITHDRAWN", "MERGED"]),
        finalFindingId: FindingIdSchema.nullable(),
        rationale: NonEmptyTextSchema,
      }),
    ),
    preliminaryConcernDispositions: z.array(
      z.strictObject({
        kind: z.enum(["EVIDENCE_GAP", "LIMITATION"]),
        preliminaryConcern: NonEmptyTextSchema,
        disposition: z.enum(["RESOLVED", "REMAINS"]),
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
    authorVerificationClaims: z.array(
      z.strictObject({
        claimIndex: z.int().nonnegative(),
        command: NonEmptyTextSchema,
        claimedOutcome: z.enum(["PASSED", "FAILED", "PARTIAL", "NOT_RUN"]),
        claimedSummary: NonEmptyTextSchema,
        status: z.enum(["CONTRADICTED", "UNVERIFIED"]),
        explanation: NonEmptyTextSchema,
      }),
    ),
    changedPathCoverage: z.array(ChangedPathCoverageV1Schema).min(1),
    canonicalInputCoverage: z.array(CanonicalInputCoverageV1Schema).min(1),
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

    const concernKeys = report.preliminaryConcernDispositions.map(
      (disposition) => `${disposition.kind}:${disposition.preliminaryConcern}`,
    );
    if (new Set(concernKeys).size !== concernKeys.length) {
      context.addIssue({
        code: "custom",
        message: "preliminary concern dispositions must be unique",
        path: ["preliminaryConcernDispositions"],
      });
    }
    const verificationIndexes = report.authorVerificationClaims.map((claim) => claim.claimIndex);
    if (new Set(verificationIndexes).size !== verificationIndexes.length) {
      context.addIssue({
        code: "custom",
        message: "author verification claim indexes must be unique",
        path: ["authorVerificationClaims"],
      });
    }
    const changedPaths = report.changedPathCoverage.map((coverage) => coverage.path);
    if (new Set(changedPaths).size !== changedPaths.length) {
      context.addIssue({
        code: "custom",
        message: "changed-path coverage entries must be unique",
        path: ["changedPathCoverage"],
      });
    }
    const canonicalInputIds = report.canonicalInputCoverage.map(
      (coverage) => coverage.canonicalInputId,
    );
    if (new Set(canonicalInputIds).size !== canonicalInputIds.length) {
      context.addIssue({
        code: "custom",
        message: "canonical-input coverage entries must be unique",
        path: ["canonicalInputCoverage"],
      });
    }

    const blockingFinding = report.findings.some(
      (finding) => finding.severity === "P0" || finding.severity === "P1",
    );
    const incompleteCoverage =
      report.changedPathCoverage.some((coverage) => coverage.status === "UNASSESSED") ||
      report.canonicalInputCoverage.some((coverage) => coverage.status === "UNASSESSED");
    const unresolvedPreliminaryConcern = report.preliminaryConcernDispositions.some(
      (disposition) => disposition.disposition === "REMAINS",
    );
    if (
      (report.verdict === "READY" || report.verdict === "READY_WITH_FOLLOW_UPS") &&
      (blockingFinding ||
        report.nextActions.blockers.length > 0 ||
        report.limitations.length > 0 ||
        incompleteCoverage ||
        unresolvedPreliminaryConcern)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "a ready verdict cannot retain blockers, P0/P1 findings, limitations, unresolved preliminary concerns, or unassessed coverage",
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
export type ReviewEvidenceV1 = z.infer<typeof ReviewEvidenceV1Schema>;
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
