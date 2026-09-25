import * as z from "zod";
import { ClaimTextV1Schema, compareUtf16 } from "./primitives.js";
import { ReviewClaimIdV1Schema } from "./review-claims.js";
import {
  FinalReviewReportV1Schema,
  ReviewFindingV1Schema,
  validateReportStructure,
} from "./review-results.js";
import { DigestV1Schema } from "./snapshot-manifest.js";
import {
  ReportAuthorContextV1Schema,
  StandardsFindingV2Schema,
  StandardsRuleAssessmentV2Schema,
} from "./standards-results.js";
import { contractJsonSchema } from "./standards-review.js";

export const CLAIM_PROJECTION_POLICY_VERSION_V1 = "claim-projection-v1";
const claimIds = z
  .array(ReviewClaimIdV1Schema)
  .min(1)
  .max(1024)
  .refine(
    (ids) => ids.every((id, index) => index === 0 || compareUtf16(ids[index - 1] ?? "", id) < 0),
    "claim IDs must be sorted and unique",
  );
const findingBinding = {
  claimIds,
  representativeClaimId: ReviewClaimIdV1Schema,
  origin: z.enum(["PRELIMINARY", "FINAL_ONLY"]),
  emergenceRationale: ClaimTextV1Schema.nullable(),
};
const projection = z.strictObject({
  policyVersion: z.literal(CLAIM_PROJECTION_POLICY_VERSION_V1),
  priorClaimSetDigest: DigestV1Schema,
  priorVerificationDigest: DigestV1Schema,
  candidateDigest: DigestV1Schema,
  transitionDigest: DigestV1Schema,
  finalVerificationDigest: DigestV1Schema.nullable(),
});
const common = {
  ...FinalReviewReportV1Schema.shape,
  summary: ClaimTextV1Schema,
  // Earlier versions published model reconciliation prose. Claim ledgers now own provenance.
  preliminaryFindingDispositions:
    FinalReviewReportV1Schema.shape.preliminaryFindingDispositions.max(0),
  preliminaryConcernDispositions:
    FinalReviewReportV1Schema.shape.preliminaryConcernDispositions.max(0),
  authorClaims: z.array(
    FinalReviewReportV1Schema.shape.authorClaims.element.extend({
      status: z.literal("UNVERIFIED"),
    }),
  ),
  authorContext: ReportAuthorContextV1Schema.nullable(),
  projection,
  uncertainties: z
    .array(
      z.strictObject({
        claimId: ReviewClaimIdV1Schema,
        blocking: z.boolean(),
        assertion: ClaimTextV1Schema,
      }),
    )
    .max(1024),
};
function validateBindings(
  report: {
    findings: Array<{ claimIds: string[]; representativeClaimId: string }>;
    uncertainties: Array<{ claimId: string }>;
  },
  context: z.RefinementCtx,
) {
  const ids = report.findings.flatMap((finding) => finding.claimIds);
  if (
    new Set(ids).size !== ids.length ||
    report.findings.some((finding) => !finding.claimIds.includes(finding.representativeClaimId))
  )
    context.addIssue({
      code: "custom",
      message: "Finding groups require unique claim membership and a member representative",
    });
  const uncertaintyIds = report.uncertainties.map((item) => item.claimId);
  if (
    new Set(uncertaintyIds).size !== uncertaintyIds.length ||
    uncertaintyIds.some((id) => ids.includes(id))
  )
    context.addIssue({
      code: "custom",
      message: "Uncertainty claims must be unique and cannot also be findings",
    });
}
export const FinalReviewReportV2Schema = z
  .strictObject({
    ...common,
    schemaVersion: z.literal(2),
    mode: z.literal("REQUIREMENTS"),
    findings: z.array(ReviewFindingV1Schema.extend(findingBinding)),
  })
  .superRefine(validateReportStructure)
  .superRefine(validateBindings);
export const StandardsReportV4Schema = z
  .strictObject({
    ...common,
    schemaVersion: z.literal(4),
    mode: z.literal("STANDARDS"),
    findings: z.array(StandardsFindingV2Schema.extend(findingBinding)),
    ruleAssessments: z.array(StandardsRuleAssessmentV2Schema).min(1),
  })
  .superRefine(validateReportStructure)
  .superRefine(validateBindings)
  .superRefine((report, context) => {
    if (
      report.verdict === "READY" &&
      (report.findings.length || report.nextActions.fastFollows.length)
    )
      context.addIssue({
        code: "custom",
        message: "Satisfied standards cannot retain findings or follow-ups",
      });
    if (
      report.ruleAssessments.some((rule) => rule.status !== "ASSESSED") &&
      report.verdict !== "UNABLE_TO_VERIFY"
    )
      context.addIssue({
        code: "custom",
        message: "Adverse rule states block standards assessment",
      });
  });
export type VerifiedReviewReport =
  | z.infer<typeof FinalReviewReportV2Schema>
  | z.infer<typeof StandardsReportV4Schema>;
export const FINAL_REVIEW_REPORT_V2_JSON_SCHEMA = contractJsonSchema(
  FinalReviewReportV2Schema,
  "final-review-report:v2",
);
export const STANDARDS_REPORT_V4_JSON_SCHEMA = contractJsonSchema(
  StandardsReportV4Schema,
  "standards-report:v4",
);
