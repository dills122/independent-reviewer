import * as z from "zod";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { NonEmptyTextSchema } from "./primitives.js";
import { DigestV1Schema } from "./snapshot-manifest.js";

/** Runner-owned binding for a completed report; provider candidates never supply these fields. */
export const ReviewReportMetadataV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  snapshotDigest: DigestV1Schema,
  briefDigest: DigestV1Schema,
  guidanceGraphDigest: DigestV1Schema.nullable(),
  reportDigest: DigestV1Schema,
  promptVersion: NonEmptyTextSchema,
  preliminarySchema: NonEmptyTextSchema,
  finalSchema: NonEmptyTextSchema,
});

export type ReviewReportMetadataV1 = z.infer<typeof ReviewReportMetadataV1Schema>;

export const REVIEW_REPORT_METADATA_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:review-report-metadata:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ReviewReportMetadataV1Schema, { target: "draft-2020-12", io: "output" }),
};
