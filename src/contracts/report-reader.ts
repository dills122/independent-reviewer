import * as z from "zod";
import { FinalReviewReportV1Schema } from "./review-results.js";
import { StandardsReportV2Schema, StandardsReportV3Schema } from "./standards-results.js";
import { FinalReviewReportV2Schema, StandardsReportV4Schema } from "./verified-report.js";

/** Compatibility is explicit: persisted generations are parsed under their original contracts. */
export const ReviewReportSchema = z.union([
  FinalReviewReportV1Schema,
  StandardsReportV2Schema,
  StandardsReportV3Schema,
  FinalReviewReportV2Schema,
  StandardsReportV4Schema,
]);
export type AnyReviewReport = z.infer<typeof ReviewReportSchema>;
