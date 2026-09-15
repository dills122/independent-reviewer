import * as z from "zod";
import { NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import {
  FinalReviewCandidateV1Schema,
  FinalReviewCandidateV2Schema,
  FinalReviewCandidateV3Schema,
  FinalReviewReportV1Schema,
  PreliminaryAssessmentV1Schema,
  ReviewFindingV1Schema,
  validatePreliminaryStructure,
  validateReportStructure,
} from "./review-results.js";
import { DigestV1Schema } from "./snapshot-manifest.js";
import { contractJsonSchema } from "./standards-review.js";

export const StandardsRuleAssessmentV2Schema = z.strictObject({
  ruleId: prefixedIdentifier("rule"),
  status: z.enum(["ASSESSED", "CONFLICT", "UNASSESSED"]),
  conflictingRuleIds: z.array(prefixedIdentifier("rule")),
  explanation: NonEmptyTextSchema,
});
const ruleAssessments = z.array(StandardsRuleAssessmentV2Schema).min(1);

export const StandardsFindingV2Schema = ReviewFindingV1Schema.omit({
  scenario: true,
  severity: true,
}).extend({
  ruleIds: z.array(prefixedIdentifier("rule")).min(1),
  severity: z.enum(["REQUIRED", "RECOMMENDED"]),
  problem: NonEmptyTextSchema,
});
const FinalStandardsFindingSchema = z.discriminatedUnion("origin", [
  StandardsFindingV2Schema.extend({
    origin: z.literal("PRELIMINARY"),
    emergenceRationale: z.null(),
  }),
  StandardsFindingV2Schema.extend({
    origin: z.literal("FINAL_ONLY"),
    emergenceRationale: NonEmptyTextSchema,
  }),
]);
export const StandardsPreliminaryV2Schema = z
  .strictObject({
    ...PreliminaryAssessmentV1Schema.shape,
    schemaVersion: z.literal(2),
    ruleAssessments,
    findings: z.array(StandardsFindingV2Schema),
  })
  .superRefine(validatePreliminaryStructure);
/** Verdict codes retain CLI exit compatibility; mode-specific labels describe only standards. */
const StandardsReportBaseV2Schema = z.strictObject({
  ...FinalReviewReportV1Schema.shape,
  schemaVersion: z.literal(2),
  ruleAssessments,
  mode: z.literal("STANDARDS"),
  findings: z.array(FinalStandardsFindingSchema),
});

function validateStandardsReport(
  report: Pick<z.infer<typeof StandardsReportBaseV2Schema>, "verdict" | "findings" | "nextActions">,
  context: z.RefinementCtx,
) {
  if (
    report.verdict === "READY" &&
    (report.findings.length || report.nextActions.fastFollows.length)
  )
    context.addIssue({
      code: "custom",
      message: "Standards satisfied cannot retain findings or recommendations.",
    });
  if (
    report.verdict === "NOT_READY" &&
    !report.findings.some((finding) => finding.severity === "REQUIRED")
  )
    context.addIssue({
      code: "custom",
      message: "Changes requested requires a mandatory standards finding.",
    });
}

export const StandardsReportV2Schema =
  StandardsReportBaseV2Schema.superRefine(validateReportStructure).superRefine(
    validateStandardsReport,
  );

export const ReportAuthorContextV1Schema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("PROVIDED"),
    digest: DigestV1Schema,
    noteCode: z.null(),
  }),
  z.strictObject({
    status: z.literal("DECLINED"),
    digest: DigestV1Schema,
    noteCode: z.literal("AUTHOR_CONTEXT_DECLINED"),
  }),
]);

export const StandardsReportV3Schema = z
  .strictObject({
    ...StandardsReportBaseV2Schema.shape,
    schemaVersion: z.literal(3),
    authorContext: ReportAuthorContextV1Schema,
  })
  .superRefine(validateReportStructure)
  .superRefine(validateStandardsReport)
  .superRefine((report, context) => {
    if (
      report.authorContext.status === "DECLINED" &&
      (report.authorClaims.length > 0 || report.authorVerificationClaims.length > 0)
    )
      context.addIssue({
        code: "custom",
        message: "Declined author context requires empty author-claim ledgers.",
      });
  });
export const StandardsCandidateV2Schema = z.strictObject({
  ...FinalReviewCandidateV2Schema.shape,
  schemaVersion: z.literal(2),
  ruleAssessments,
  mode: z.literal("STANDARDS"),
  findings: z.array(
    StandardsFindingV2Schema.omit({ id: true }).extend({
      sourceFindingIds: FinalReviewCandidateV2Schema.shape.findings.element.shape.sourceFindingIds,
      reconciliationRationale: NonEmptyTextSchema,
    }),
  ),
});
export const StandardsCandidateV3Schema = z.strictObject({
  ...FinalReviewCandidateV3Schema.shape,
  schemaVersion: z.literal(3),
  ruleAssessments,
  mode: z.literal("STANDARDS"),
  findings: StandardsCandidateV2Schema.shape.findings,
});
export const StandardsExpandedCandidateV2Schema = z.strictObject({
  ...FinalReviewCandidateV1Schema.shape,
  schemaVersion: z.literal(2),
  ruleAssessments,
  mode: z.literal("STANDARDS"),
  findings: z.array(FinalStandardsFindingSchema),
});
export type ReviewPreliminary =
  | z.infer<typeof PreliminaryAssessmentV1Schema>
  | z.infer<typeof StandardsPreliminaryV2Schema>;
export type ReviewReport =
  | z.infer<typeof FinalReviewReportV1Schema>
  | z.infer<typeof StandardsReportV2Schema>
  | z.infer<typeof StandardsReportV3Schema>;
export const STANDARDS_PRELIMINARY_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsPreliminaryV2Schema,
  "standards-preliminary:v2",
);
export const STANDARDS_REPORT_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsReportV2Schema,
  "standards-report:v2",
);
export const STANDARDS_REPORT_V3_JSON_SCHEMA = contractJsonSchema(
  StandardsReportV3Schema,
  "standards-report:v3",
);
export const STANDARDS_CANDIDATE_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsCandidateV2Schema,
  "standards-candidate:v2",
);
export const STANDARDS_CANDIDATE_V3_JSON_SCHEMA = contractJsonSchema(
  StandardsCandidateV3Schema,
  "standards-candidate:v3",
);
