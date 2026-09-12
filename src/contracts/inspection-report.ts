import * as z from "zod";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { prefixedIdentifier } from "./primitives.js";
import { PersistedCanonicalInputsV1Schema } from "./review-request.js";
import { DigestV1Schema, SnapshotManifestV1Schema } from "./snapshot-manifest.js";
import {
  type ReviewCanonicalInputs,
  StandardsCanonicalInputsV2Schema,
} from "./standards-review.js";

/**
 * Whether repository-owned reviewer guidance was captured, and how much of it there is.
 *
 * `captured` distinguishes the two silences a caller could not previously tell apart: a packet
 * built by a path that never ran guidance capture reports `false`, while a packet whose repository
 * simply has no rules file reports `captured: true` with `sourceCount: 0`. Source content stays out
 * of the report, like the author packet.
 */
export const InspectedReviewerGuidanceV1Schema = z.strictObject({
  captured: z.boolean(),
  sourceCount: z.int().min(0),
  guidanceGraphDigest: DigestV1Schema.nullable(),
});

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
  reviewerGuidance: InspectedReviewerGuidanceV1Schema,
});

export type InspectionReportV1 = z.infer<typeof InspectionReportV1Schema>;

export interface InspectionReportInputV1 {
  manifest: z.infer<typeof SnapshotManifestV1Schema>;
  canonicalInputs: z.infer<typeof PersistedCanonicalInputsV1Schema>;
  authorPacket?: unknown;
  reviewConfigRef: string;
  blobCount: number;
  guidanceGraph?: { nodes: readonly unknown[] };
  guidanceGraphDigest?: z.infer<typeof DigestV1Schema>;
}

function inspectedReviewerGuidance(
  input: Pick<InspectionReportInputV1, "guidanceGraph" | "guidanceGraphDigest">,
): z.infer<typeof InspectedReviewerGuidanceV1Schema> {
  return {
    captured: input.guidanceGraph !== undefined,
    sourceCount: input.guidanceGraph?.nodes.length ?? 0,
    guidanceGraphDigest: input.guidanceGraphDigest ?? null,
  };
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
    reviewerGuidance: inspectedReviewerGuidance(input),
  });
}

export const INSPECTION_REPORT_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:inspection-report:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(InspectionReportV1Schema, { target: "draft-2020-12", io: "output" }),
};

export const StandardsInspectionReportV2Schema = InspectionReportV1Schema.extend({
  schemaVersion: z.literal(2),
  canonicalInputs: StandardsCanonicalInputsV2Schema,
});
export type InspectionReport =
  | InspectionReportV1
  | z.infer<typeof StandardsInspectionReportV2Schema>;
export function buildInspectionReport(
  input: Omit<InspectionReportInputV1, "canonicalInputs"> & {
    canonicalInputs: ReviewCanonicalInputs;
  },
): InspectionReport {
  if (!("standards" in input.canonicalInputs))
    return buildInspectionReportV1({ ...input, canonicalInputs: input.canonicalInputs });
  return StandardsInspectionReportV2Schema.parse({
    schemaVersion: 2,
    reviewConfigRef: input.reviewConfigRef,
    snapshotManifest: input.manifest,
    canonicalInputs: input.canonicalInputs,
    authorPacketPresent: input.authorPacket !== undefined,
    blobCount: input.blobCount,
    reviewerGuidance: inspectedReviewerGuidance(input),
  });
}
