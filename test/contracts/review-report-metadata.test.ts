import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  REVIEW_REPORT_METADATA_V1_JSON_SCHEMA,
  ReviewReportMetadataV1Schema,
} from "../../src/contracts/review-report-metadata.js";

const digest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

test("report metadata binds runner-owned report inputs", () => {
  const metadata = {
    schemaVersion: 1,
    snapshotDigest: digest,
    briefDigest: digest,
    guidanceGraphDigest: digest,
    reportDigest: digest,
    promptVersion: "standards-review-v15",
    preliminarySchema: "standards_preliminary_v2",
    finalSchema: "standards_candidate_v3",
  };

  assert.equal(ReviewReportMetadataV1Schema.safeParse(metadata).success, true);
  assert.equal(
    ReviewReportMetadataV1Schema.safeParse({ ...metadata, providerSupplied: true }).success,
    false,
  );
});

test("report metadata matches committed JSON Schema", async () => {
  assert.deepEqual(
    JSON.parse(await readFile("schemas/review-report-metadata-v1.schema.json", "utf8")),
    REVIEW_REPORT_METADATA_V1_JSON_SCHEMA,
  );
});
