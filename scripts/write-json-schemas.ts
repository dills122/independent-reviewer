import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  INSPECTION_REPORT_V1_JSON_SCHEMA,
  StandardsInspectionReportV2Schema,
} from "../src/contracts/inspection-report.js";
import {
  NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA,
  StandardsReviewBriefV2Schema,
} from "../src/contracts/neutral-review-brief.js";
import { REVIEW_REQUEST_V1_JSON_SCHEMA } from "../src/contracts/review-request.js";
import {
  FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA,
  FINAL_REVIEW_CANDIDATE_V2_JSON_SCHEMA,
  FINAL_REVIEW_REPORT_V1_JSON_SCHEMA,
  PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
} from "../src/contracts/review-results.js";
import { REVIEW_RUN_CONFIG_V2_JSON_SCHEMA } from "../src/contracts/review-run-config.js";
import { SNAPSHOT_MANIFEST_V1_JSON_SCHEMA } from "../src/contracts/snapshot-manifest.js";
import {
  STANDARDS_CANDIDATE_V2_JSON_SCHEMA,
  STANDARDS_PRELIMINARY_V2_JSON_SCHEMA,
  STANDARDS_REPORT_V2_JSON_SCHEMA,
} from "../src/contracts/standards-results.js";
import {
  contractJsonSchema,
  STANDARDS_PROFILE_V1_JSON_SCHEMA,
  STANDARDS_REVIEW_REQUEST_V2_JSON_SCHEMA,
} from "../src/contracts/standards-review.js";

const schemaDirectory = resolve("schemas");
await mkdir(schemaDirectory, { recursive: true });

const schemaArtifacts = [
  ["standards-profile-v1.schema.json", STANDARDS_PROFILE_V1_JSON_SCHEMA],
  ["standards-review-request-v2.schema.json", STANDARDS_REVIEW_REQUEST_V2_JSON_SCHEMA],
  ["standards-preliminary-v2.schema.json", STANDARDS_PRELIMINARY_V2_JSON_SCHEMA],
  ["standards-report-v2.schema.json", STANDARDS_REPORT_V2_JSON_SCHEMA],
  ["standards-candidate-v2.schema.json", STANDARDS_CANDIDATE_V2_JSON_SCHEMA],
  [
    "standards-review-brief-v2.schema.json",
    contractJsonSchema(StandardsReviewBriefV2Schema, "standards-review-brief:v2"),
  ],
  [
    "standards-inspection-report-v2.schema.json",
    contractJsonSchema(StandardsInspectionReportV2Schema, "standards-inspection-report:v2"),
  ],
  ["final-review-candidate-v2.schema.json", FINAL_REVIEW_CANDIDATE_V2_JSON_SCHEMA],
  ["final-review-candidate-v1.schema.json", FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA],
  ["final-review-report-v1.schema.json", FINAL_REVIEW_REPORT_V1_JSON_SCHEMA],
  ["neutral-review-brief-v1.schema.json", NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA],
  ["preliminary-assessment-v1.schema.json", PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA],
  ["review-request-v1.schema.json", REVIEW_REQUEST_V1_JSON_SCHEMA],
  ["review-run-config-v2.schema.json", REVIEW_RUN_CONFIG_V2_JSON_SCHEMA],
  ["inspection-report-v1.schema.json", INSPECTION_REPORT_V1_JSON_SCHEMA],
  ["snapshot-manifest-v1.schema.json", SNAPSHOT_MANIFEST_V1_JSON_SCHEMA],
] as const;

await Promise.all(
  schemaArtifacts.map(([fileName, schema]) =>
    writeFile(resolve(schemaDirectory, fileName), `${JSON.stringify(schema, null, 2)}\n`, "utf8"),
  ),
);
