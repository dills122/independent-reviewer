import * as z from "zod";
import { NonEmptyTextSchema, prefixedIdentifier } from "./primitives.js";
import {
  FinalReviewCandidateV1Schema,
  FinalReviewCandidateV2Schema,
  FinalReviewReportV1Schema,
  PreliminaryAssessmentV1Schema,
  ReviewFindingV1Schema,
  validatePreliminaryStructure,
  validateReportStructure,
} from "./review-results.js";
import { contractJsonSchema } from "./standards-review.js";

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
    findings: z.array(StandardsFindingV2Schema),
  })
  .superRefine(validatePreliminaryStructure);
/** Verdict codes retain CLI exit compatibility; mode-specific labels describe only standards. */
export const StandardsReportV2Schema = z
  .strictObject({
    ...FinalReviewReportV1Schema.shape,
    schemaVersion: z.literal(2),
    mode: z.literal("STANDARDS"),
    findings: z.array(FinalStandardsFindingSchema),
  })
  .superRefine(validateReportStructure)
  .superRefine((report, context) => {
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
  });
export const StandardsCandidateV2Schema = z.strictObject({
  ...FinalReviewCandidateV2Schema.shape,
  schemaVersion: z.literal(2),
  mode: z.literal("STANDARDS"),
  findings: z.array(
    StandardsFindingV2Schema.omit({ id: true }).extend({
      sourceFindingIds: FinalReviewCandidateV2Schema.shape.findings.element.shape.sourceFindingIds,
      reconciliationRationale: NonEmptyTextSchema,
    }),
  ),
});
export const StandardsExpandedCandidateV2Schema = z.strictObject({
  ...FinalReviewCandidateV1Schema.shape,
  schemaVersion: z.literal(2),
  mode: z.literal("STANDARDS"),
  findings: z.array(FinalStandardsFindingSchema),
});
export type ReviewPreliminary =
  | z.infer<typeof PreliminaryAssessmentV1Schema>
  | z.infer<typeof StandardsPreliminaryV2Schema>;
export type ReviewReport =
  | z.infer<typeof FinalReviewReportV1Schema>
  | z.infer<typeof StandardsReportV2Schema>;
export const STANDARDS_PRELIMINARY_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsPreliminaryV2Schema,
  "standards-preliminary:v2",
);
export const STANDARDS_REPORT_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsReportV2Schema,
  "standards-report:v2",
);
export const STANDARDS_CANDIDATE_V2_JSON_SCHEMA = contractJsonSchema(
  StandardsCandidateV2Schema,
  "standards-candidate:v2",
);
