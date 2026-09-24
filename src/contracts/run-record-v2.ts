import * as z from "zod";
import { RunRecordEventV1Schema } from "./run-record.js";
import { DigestV1Schema } from "./snapshot-manifest.js";
import { contractJsonSchema } from "./standards-review.js";

export const ReviewStageV2Schema = z.enum([
  "PRELIMINARY",
  "FINDING_VERIFICATION",
  "FINAL",
  "FINAL_CLAIM_VERIFICATION",
]);
const version = { schemaVersion: z.literal(2) };
const staged = { ...version, stage: ReviewStageV2Schema };
const base = { ...version, at: z.iso.datetime() };
const legacy = RunRecordEventV1Schema.options;

/** V1 remains immutable; V2 binds claim transitions, selective verification, and projection. */
export const RunRecordEventV2Schema = z.discriminatedUnion("type", [
  legacy[0].extend({
    ...version,
    claimProtocolVersion: z.literal("claim-review-v1"),
    finalClaimVerificationSchema: z.string(),
    finalClaimVerificationPromptVersion: z.string(),
    projectionPolicyVersion: z.string(),
  }),
  legacy[1].extend({
    ...version,
    wireBytesByStage: legacy[1].shape.wireBytesByStage.extend({
      finalClaimVerification: z.number(),
    }),
  }),
  legacy[2].extend(staged),
  legacy[3].extend({ ...staged, responseDigest: DigestV1Schema.optional() }),
  legacy[4].extend(staged),
  legacy[5].extend(staged),
  legacy[6].extend(staged),
  legacy[7].extend(version),
  legacy[8].extend(version),
  legacy[9].extend(version),
  legacy[10].extend(version),
  legacy[11].extend(version),
  legacy[12].extend(version),
  legacy[13].extend(version),
  legacy[14].extend(version),
  legacy[15].extend({
    ...version,
    stage: z.enum(["FINAL", "FINAL_CLAIM_VERIFICATION", "PROJECTION"]),
  }),
  legacy[16].extend(version),
  legacy[17].extend(version),
  legacy[18].extend(version),
  z.strictObject({
    ...base,
    type: z.literal("PRELIMINARY_CLAIMS_PERSISTED"),
    claimSetDigest: DigestV1Schema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("FINAL_CANDIDATE_PERSISTED"),
    candidateDigest: DigestV1Schema,
    transitionDigest: DigestV1Schema,
    targetSetDigest: DigestV1Schema,
    catalogSetDigest: DigestV1Schema,
  }),
  z.strictObject({
    ...base,
    type: z.literal("FINAL_CLAIM_VERIFICATION_PERSISTED"),
    verificationDigest: DigestV1Schema,
    providerCall: z.boolean(),
    acceptedAttemptNumber: z.number().optional(),
    responseArtifact: z.string().nullable(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("FINAL_REPORT_PERSISTED"),
    reportDigest: DigestV1Schema,
    projectionPolicyVersion: z.string(),
  }),
]);
export type RunRecordEventV2 = z.infer<typeof RunRecordEventV2Schema>;
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "schemaVersion" | "at"> : never;
export type RunRecordEventPayloadV2 = WithoutEnvelope<RunRecordEventV2>;
export type RunRecordEventOfTypeV2<T extends RunRecordEventV2["type"]> = Extract<
  RunRecordEventV2,
  { type: T }
>;
export const RUN_RECORD_EVENT_V2_JSON_SCHEMA = contractJsonSchema(
  RunRecordEventV2Schema,
  "run-record-event:v2",
);
