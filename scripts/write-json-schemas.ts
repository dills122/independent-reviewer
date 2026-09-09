import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA } from "../src/contracts/neutral-review-brief.js";
import { REVIEW_REQUEST_V1_JSON_SCHEMA } from "../src/contracts/review-request.js";
import {
  FINAL_REVIEW_REPORT_V1_JSON_SCHEMA,
  PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
} from "../src/contracts/review-results.js";
import { REVIEW_RUN_CONFIG_V2_JSON_SCHEMA } from "../src/contracts/review-run-config.js";
import { SNAPSHOT_MANIFEST_V1_JSON_SCHEMA } from "../src/contracts/snapshot-manifest.js";

const schemaDirectory = resolve("schemas");
await mkdir(schemaDirectory, { recursive: true });

const schemaArtifacts = [
  ["final-review-report-v1.schema.json", FINAL_REVIEW_REPORT_V1_JSON_SCHEMA],
  ["neutral-review-brief-v1.schema.json", NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA],
  ["preliminary-assessment-v1.schema.json", PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA],
  ["review-request-v1.schema.json", REVIEW_REQUEST_V1_JSON_SCHEMA],
  ["review-run-config-v2.schema.json", REVIEW_RUN_CONFIG_V2_JSON_SCHEMA],
  ["snapshot-manifest-v1.schema.json", SNAPSHOT_MANIFEST_V1_JSON_SCHEMA],
] as const;

await Promise.all(
  schemaArtifacts.map(([fileName, schema]) =>
    writeFile(resolve(schemaDirectory, fileName), `${JSON.stringify(schema, null, 2)}\n`, "utf8"),
  ),
);
