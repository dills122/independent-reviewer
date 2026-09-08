import * as z from "zod";

import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";

export const ReviewRunConfigV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    configId: z
      .string()
      .min(8)
      .max(128)
      .regex(/^config_[A-Za-z0-9][A-Za-z0-9_-]*$/, "must use the config_ identifier prefix"),
    model: z.string().trim().min(1).max(256),
    budgets: z.strictObject({
      maxInitialEvidenceBytes: z.int().min(1),
      maxConversationBytes: z.int().min(1),
      maxOutputTokensPerCall: z.int().min(1),
      maxTotalTokens: z.int().min(2),
      timeoutMs: z.int().min(1).max(300_000),
    }),
  })
  .superRefine((config, context) => {
    if (config.budgets.maxOutputTokensPerCall * 2 > config.budgets.maxTotalTokens) {
      context.addIssue({
        code: "custom",
        message: "must reserve the maximum output for both mandatory model calls",
        path: ["budgets", "maxTotalTokens"],
      });
    }
  });

export type ReviewRunConfigV1 = z.infer<typeof ReviewRunConfigV1Schema>;

export const REVIEW_RUN_CONFIG_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:review-run-config:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ReviewRunConfigV1Schema, { target: "draft-2020-12", io: "input" }),
};
