import * as z from "zod";

import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { prefixedIdentifier } from "./primitives.js";
import { PersistedCanonicalInputsV1Schema } from "./review-request.js";
import { SnapshotManifestV1Schema } from "./snapshot-manifest.js";

/**
 * The machine-readable view of a snapshot packet, as `inspect --json` emits it.
 *
 * `authorPacketPresent` is a deliberate privacy boundary: the packet's existence is reported,
 * never its content. Both the JSON and the human-readable views are built from this one object so
 * they cannot disagree about what a packet is.
 */
export const InspectionReportV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  reviewConfigRef: prefixedIdentifier("config"),
  snapshotManifest: SnapshotManifestV1Schema,
  canonicalInputs: PersistedCanonicalInputsV1Schema,
  authorPacketPresent: z.boolean(),
  blobCount: z.int().min(0),
});

export type InspectionReportV1 = z.infer<typeof InspectionReportV1Schema>;

export interface InspectionReportInputV1 {
  manifest: z.infer<typeof SnapshotManifestV1Schema>;
  canonicalInputs: z.infer<typeof PersistedCanonicalInputsV1Schema>;
  authorPacket?: unknown;
  reviewConfigRef: string;
  blobCount: number;
}

/** Builds and validates the report, so an invalid payload never reaches a calling process. */
export function buildInspectionReportV1(input: InspectionReportInputV1): InspectionReportV1 {
  return InspectionReportV1Schema.parse({
    schemaVersion: 1,
    reviewConfigRef: input.reviewConfigRef,
    snapshotManifest: input.manifest,
    canonicalInputs: input.canonicalInputs,
    authorPacketPresent: input.authorPacket !== undefined,
    blobCount: input.blobCount,
  });
}

export const INSPECTION_REPORT_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:inspection-report:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(InspectionReportV1Schema, { target: "draft-2020-12", io: "output" }),
};
