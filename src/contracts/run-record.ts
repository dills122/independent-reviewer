import * as z from "zod";

import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { DigestV1Schema } from "./snapshot-manifest.js";

/**
 * The append-only ledger one review run writes to `review/run-record.jsonl`.
 *
 * This is a contract, not a log. Final-stage resume replays it to decide whether a failed run may
 * be retried, and the CLI reads it to report spend, so the field names here are load-bearing in
 * exactly the way the persisted brief and report are. It went unschema'd while every other
 * artifact was versioned, which meant a renamed field could make every resume ineligible without
 * failing a type check, a lint, or a test (#122).
 *
 * Members are strict. A new event type, or a new field on an existing one, must be declared here
 * before it can be written, which is the point: the writer and the two readers move together.
 */
const ReviewStageV1Schema = z.enum(["PRELIMINARY", "FINDING_VERIFICATION", "FINAL"]);

const ReviewVerdictV1Schema = z.enum([
  "READY",
  "READY_WITH_FOLLOW_UPS",
  "NOT_READY",
  "UNABLE_TO_VERIFY",
]);

/** Token and cost counters as the provider reported them; null means it reported nothing. */
const ProviderUsageV1Schema = z.strictObject({
  promptTokens: z.number().nullable(),
  completionTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
  cost: z.number().nullable(),
});

const ProviderResponseMetadataV1Schema = z.strictObject({
  responseId: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  finishReason: z.string().nullable(),
  usage: ProviderUsageV1Schema,
});

const ProviderErrorDiagnosticV1Schema = z.strictObject({
  httpStatus: z.number(),
  providerErrorCode: z.string(),
  providerMessage: z.string().nullable(),
  errorType: z.string().nullable(),
  providerCode: z.string().nullable(),
  providerName: z.string().nullable(),
  model: z.string().nullable(),
  responseId: z.string().nullable(),
  retryAfter: z.string().nullable(),
  limitSource: z.string().optional(),
  previousErrors: z
    .array(z.strictObject({ provider: z.string().nullable(), code: z.string().nullable() }))
    .optional(),
});

/** The shape `normalizedError` produces; a non-Error throw still lands here. */
const NormalizedErrorV1Schema = z.strictObject({
  name: z.string(),
  code: z.string().nullable(),
  message: z.string(),
  diagnostic: ProviderErrorDiagnosticV1Schema.optional(),
});

/** Stamped on every line by `appendRunEvent`, so each member repeats it rather than assuming it. */
const eventBase = {
  schemaVersion: z.literal(1),
  at: z.iso.datetime(),
};

export const RunRecordEventV1Schema = z.discriminatedUnion("type", [
  z.strictObject({
    ...eventBase,
    type: z.literal("RUN_STARTED"),
    snapshotDigest: DigestV1Schema,
    briefDigest: DigestV1Schema,
    // Present only for a guidance (schemaVersion 3) brief; absent, never null, for the others.
    guidanceGraphDigest: DigestV1Schema.optional(),
    contextMapDigest: DigestV1Schema,
    planDigest: DigestV1Schema,
    configId: z.string().min(1),
    configDigest: DigestV1Schema,
    requestedModels: z.array(z.string()),
    promptVersion: z.string(),
    preliminarySchema: z.string(),
    finalSchema: z.string(),
    findingVerificationSchema: z.string(),
    findingVerificationPromptVersion: z.string(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("GUIDANCE_ADMISSION"),
    contentBytes: z.number(),
    wireBytesByStage: z.strictObject({
      preliminary: z.number(),
      findingVerification: z.number(),
      final: z.number(),
    }),
    capacityBytes: z.number(),
    status: z.enum(["ACCEPTED", "WARNING", "STOP"]),
    warningReasons: z.array(z.string()),
    stopReasons: z.array(z.string()),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("CALL_STARTED"),
    attemptNumber: z.number(),
    stage: ReviewStageV1Schema,
    inputDigest: DigestV1Schema,
    providerPolicyVersion: z.string(),
    preferredProviderEndpoints: z.array(z.string()).nullable(),
    excludedProviderEndpoints: z.array(z.string()).nullable(),
    wireBodyDigest: DigestV1Schema,
    wireBodyBytes: z.number(),
    credentialFreeWireRequestDigest: DigestV1Schema,
    requestedModels: z.array(z.string()),
    promptVersion: z.string(),
    responseSchemaName: z.string(),
    responseArrayLimits: z.record(z.string(), z.number()),
    maxOutputTokens: z.number(),
    timeoutMs: z.number(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("CALL_SUCCEEDED"),
    attemptNumber: z.number(),
    stage: ReviewStageV1Schema,
    durationMs: z.number(),
    responseId: z.string().nullable(),
    returnedModel: z.string().nullable(),
    returnedProvider: z.string().nullable(),
    usage: ProviderUsageV1Schema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("CALL_FAILED"),
    attemptNumber: z.number(),
    stage: ReviewStageV1Schema,
    durationMs: z.number(),
    // Spread in only when the failure carried a provider envelope.
    responseMetadata: ProviderResponseMetadataV1Schema.optional(),
    error: NormalizedErrorV1Schema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("PROVIDER_RETRY_REQUESTED"),
    stage: ReviewStageV1Schema,
    failedAttemptNumber: z.number(),
    retryAttemptNumber: z.number(),
    retriesUsed: z.number(),
    maxRetries: z.number(),
    delayMs: z.number(),
    chargedFailedTokens: z.number(),
    chargedFailedCostUsd: z.number(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("BUDGET_EXHAUSTED"),
    budget: z.literal("COST"),
    stage: ReviewStageV1Schema,
    phase: z.enum(["RESERVATION", "REPORTED"]),
    spentUsd: z.number(),
    additionalUsd: z.number(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("PRELIMINARY_CANDIDATE_REJECTED"),
    attemptNumber: z.number(),
    validationError: z.string(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("PRELIMINARY_REPAIR_REQUESTED"),
    rejectedAttemptNumber: z.number(),
    repairAttemptNumber: z.number(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("PRELIMINARY_PERSISTED"),
    preliminaryDigest: DigestV1Schema,
    acceptedAttemptNumber: z.number(),
    responseArtifact: z.string(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("FINDING_VERIFICATION_PERSISTED"),
    verificationDigest: DigestV1Schema,
    // False when the preliminary had no findings, so the stage was satisfied without a call. The
    // attempt number and artifact exist only in the provider-backed case.
    providerCall: z.boolean(),
    acceptedAttemptNumber: z.number().optional(),
    responseArtifact: z.string().nullable(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("AUTHOR_DELIVERED"),
    authorPacketDigest: DigestV1Schema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("FINAL_CANDIDATE_REJECTED"),
    attemptNumber: z.number(),
    validationError: z.string(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("FINAL_REPAIR_REQUESTED"),
    rejectedAttemptNumber: z.number(),
    repairAttemptNumber: z.number(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("RUN_RESUMED"),
    stage: z.literal("FINAL"),
    failedAttemptNumber: z.number(),
    nextAttemptNumber: z.number(),
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("RUN_COMPLETED"),
    terminalState: ReviewVerdictV1Schema,
  }),
  z.strictObject({
    ...eventBase,
    type: z.literal("RUN_FAILED"),
    terminalState: z.enum(["FAILED", "TRANSPORT_UNCERTAIN"]),
    error: NormalizedErrorV1Schema,
  }),
]);

export type RunRecordEventV1 = z.infer<typeof RunRecordEventV1Schema>;

/** Narrowed views the readers actually want, so neither has to re-discriminate by hand. */
export type RunRecordEventOfTypeV1<T extends RunRecordEventV1["type"]> = Extract<
  RunRecordEventV1,
  { type: T }
>;

export const RUN_RECORD_EVENT_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:run-record-event:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(RunRecordEventV1Schema, { target: "draft-2020-12", io: "output" }),
};
