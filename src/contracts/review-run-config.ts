import * as z from "zod";

import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { prefixedIdentifier } from "./primitives.js";

const ProviderEndpointSlugV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be an OpenRouter provider endpoint slug");

export const OpenRouterProviderRoutingV1Schema = z
  .strictObject({
    order: z.array(ProviderEndpointSlugV1Schema).min(1).max(3),
    maxPrice: z.strictObject({
      prompt: z.number().nonnegative().max(1_000),
      completion: z.number().nonnegative().max(1_000),
      request: z.number().nonnegative().max(1_000),
    }),
  })
  .superRefine((routing, context) => {
    if (new Set(routing.order).size !== routing.order.length) {
      context.addIssue({
        code: "custom",
        message: "provider endpoint slugs must be unique",
        path: ["order"],
      });
    }
  });

export const ReviewRunConfigV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    configId: prefixedIdentifier("config"),
    model: z.string().trim().min(1).max(256),
    providerRouting: OpenRouterProviderRoutingV1Schema,
    budgets: z.strictObject({
      maxInitialEvidenceBytes: z.int().min(1),
      maxConversationBytes: z.int().min(1),
      maxOutputTokensPerCall: z.int().min(1),
      maxTotalTokens: z.int().min(2),
      /** Local ceiling in US dollars on the total spend of one run, across every model call. */
      maxTotalCostUsd: z.number().positive().max(1_000),
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

export type ReviewRunConfigV2 = z.infer<typeof ReviewRunConfigV2Schema>;
export type OpenRouterProviderRoutingV1 = z.infer<typeof OpenRouterProviderRoutingV1Schema>;

export const REVIEW_RUN_CONFIG_V2_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:review-run-config:v2",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ReviewRunConfigV2Schema, { target: "draft-2020-12", io: "input" }),
};
