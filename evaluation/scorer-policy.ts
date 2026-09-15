import * as z from "zod";

import { jsonDocument, sha256BytesDigestV1 } from "../src/contracts/json-document.js";
import { type DigestV1, DigestV1Schema } from "../src/contracts/snapshot-manifest.js";
import { EvaluationMetricNameV1Schema } from "./artifact-contracts.js";

export const EVALUATION_SCORER_VERSION_V1 = "evaluation-scorer-v1";

export const EvaluationScorerPolicyV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  scorerVersion: z.literal(EVALUATION_SCORER_VERSION_V1),
  metrics: z
    .array(EvaluationMetricNameV1Schema)
    .length(EvaluationMetricNameV1Schema.options.length),
  completedOutcomes: z.tuple([z.literal("DELIVERED"), z.literal("SEMANTIC_ABSTENTION")]),
  semanticRootCredit: z.literal("ONE_PER_ATTEMPT_STAGE_V1"),
  novelRootIdentity: z.literal("NON_ORACLE_ROOT_ID_V1"),
  invalidRootIdentity: z.literal("NON_ORACLE_ROOT_ID_V1"),
  duplicateIdentity: z.literal("CREDITED_SAME_STAGE_ROOT_ID_V1"),
  failedStageRetention: z.literal("UNAVAILABLE_V1"),
  aggregation: z.literal("MAGNITUDE_VALUE_UTF16_ARTIFACT_ID_ORDER_NEUMAIER_SUM_V1"),
  interval: z.strictObject({
    method: z.literal("CONSERVATIVE_BOUNDS_V1"),
    confidenceLevel: z.literal(0.95),
    lower: z.literal(0),
    upper: z.literal(1),
    globalIndependentUnit: z.literal("FAMILY"),
    breakdownIndependentUnit: z.literal("CASE"),
  }),
});

export const EVALUATION_SCORER_POLICY_V1 = EvaluationScorerPolicyV1Schema.parse({
  schemaVersion: 1,
  scorerVersion: EVALUATION_SCORER_VERSION_V1,
  metrics: EvaluationMetricNameV1Schema.options,
  completedOutcomes: ["DELIVERED", "SEMANTIC_ABSTENTION"],
  semanticRootCredit: "ONE_PER_ATTEMPT_STAGE_V1",
  novelRootIdentity: "NON_ORACLE_ROOT_ID_V1",
  invalidRootIdentity: "NON_ORACLE_ROOT_ID_V1",
  duplicateIdentity: "CREDITED_SAME_STAGE_ROOT_ID_V1",
  failedStageRetention: "UNAVAILABLE_V1",
  aggregation: "MAGNITUDE_VALUE_UTF16_ARTIFACT_ID_ORDER_NEUMAIER_SUM_V1",
  interval: {
    method: "CONSERVATIVE_BOUNDS_V1",
    confidenceLevel: 0.95,
    lower: 0,
    upper: 1,
    globalIndependentUnit: "FAMILY",
    breakdownIndependentUnit: "CASE",
  },
});

export const EVALUATION_SCORER_POLICY_DOCUMENT_V1 = jsonDocument(
  EvaluationScorerPolicyV1Schema.parse(EVALUATION_SCORER_POLICY_V1),
);

export const EVALUATION_SCORER_POLICY_DIGEST_V1: DigestV1 = sha256BytesDigestV1(
  Buffer.from(EVALUATION_SCORER_POLICY_DOCUMENT_V1, "utf8"),
);

export function assertEvaluationScorerIdentityV1(value: {
  scorerVersion: string;
  scorerPolicyDigest: z.input<typeof DigestV1Schema>;
}): void {
  if (value.scorerVersion !== EVALUATION_SCORER_VERSION_V1) {
    throw new TypeError(`unsupported scorer version ${value.scorerVersion}`);
  }
  const digest = DigestV1Schema.parse(value.scorerPolicyDigest);
  if (digest.value !== EVALUATION_SCORER_POLICY_DIGEST_V1.value) {
    throw new TypeError(`unsupported scorer policy digest ${digest.value}`);
  }
}
