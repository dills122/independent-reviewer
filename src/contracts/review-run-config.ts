import * as z from "zod";

import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import { prefixedIdentifier } from "./primitives.js";

const ProviderEndpointSlugV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be an OpenRouter provider endpoint slug");

export const ReviewModelSlugV1Schema = z.string().trim().min(1).max(256);

const OPENROUTER_DYNAMIC_MODEL_VARIANT_V1 =
  /(?:^|:)(latest|preview|beta|online|floor|nitro)(?=:|$)/i;
const OPENROUTER_AUTOMATIC_MODEL_ROUTERS_V1 = new Set(["openrouter/auto", "openrouter/auto-beta"]);

function isDynamicModelIdentityV1(model: string): boolean {
  const normalizedModel = model.toLowerCase();
  return (
    normalizedModel.startsWith("~") ||
    OPENROUTER_AUTOMATIC_MODEL_ROUTERS_V1.has(normalizedModel) ||
    OPENROUTER_DYNAMIC_MODEL_VARIANT_V1.test(normalizedModel)
  );
}

export const OpenRouterProviderRoutingV2Schema = z
  .strictObject({
    /**
     * Preferred endpoints, tried first. This is a preference, not a restriction: OpenRouter may
     * still route elsewhere, which is what keeps a single degraded endpoint from failing a run.
     */
    order: z.array(ProviderEndpointSlugV1Schema).min(1).max(8).optional(),
    /** Restrict routing to `order` and disable provider fallback. Diagnostic use only. */
    pinToOrder: z.boolean().default(false),
    /** Admit only zero-data-retention endpoints. Narrows the pool; opt in when required. */
    zeroDataRetention: z.boolean().default(false),
    /** Admit only endpoints that do not collect prompt data. Narrows the pool; opt in when required. */
    denyDataCollection: z.boolean().default(false),
    /**
     * Unit-price ceiling in dollars per million tokens, sent to OpenRouter and used locally to
     * bound reservations. Set it as a true ceiling, not a target: a tight value silently reduces
     * the eligible endpoint pool and is a common cause of avoidable run failures.
     */
    maxPrice: z.strictObject({
      prompt: z.number().nonnegative().max(1_000),
      completion: z.number().nonnegative().max(1_000),
      request: z.number().nonnegative().max(1_000),
    }),
  })
  .superRefine((routing, context) => {
    if (routing.order && new Set(routing.order).size !== routing.order.length) {
      context.addIssue({
        code: "custom",
        message: "provider endpoint slugs must be unique",
        path: ["order"],
      });
    }
    if (routing.pinToOrder && !routing.order) {
      context.addIssue({
        code: "custom",
        message: "pinToOrder requires an explicit order",
        path: ["pinToOrder"],
      });
    }
  });

export const ReviewRunConfigV3Schema = z
  .strictObject({
    schemaVersion: z.literal(3),
    configId: prefixedIdentifier("config"),
    /** Primary review model. Explicit identity only; aliases such as `:latest` are rejected. */
    model: ReviewModelSlugV1Schema,
    /**
     * Ordered fallback models, used when the primary is rate-limited, down, or over context.
     * A review artifact records the model that actually answered.
     */
    fallbackModels: z.array(ReviewModelSlugV1Schema).max(4).default([]),
    providerRouting: OpenRouterProviderRoutingV2Schema,
    budgets: z.strictObject({
      maxInitialEvidenceBytes: z.int().min(1),
      maxConversationBytes: z.int().min(1),
      maxOutputTokensPerCall: z.int().min(1),
      maxTotalTokens: z.int().min(2),
      /** Local ceiling in US dollars on the total spend of one run, across every model call. */
      maxTotalCostUsd: z.number().positive().max(1_000),
      timeoutMs: z.int().min(1).max(600_000),
      /** Attempts for one logical call, including the first. Transient failures only. */
      maxAttemptsPerCall: z.int().min(1).max(5).default(3),
      /** Minimum spacing between calls sharing a model, to stay under burst rate limits. */
      minimumCallIntervalMs: z.int().min(0).max(60_000).default(1_500),
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
    const models = [config.model, ...config.fallbackModels];
    if (new Set(models).size !== models.length) {
      context.addIssue({
        code: "custom",
        message: "fallback models must be distinct from each other and from the primary model",
        path: ["fallbackModels"],
      });
    }
    for (const [index, model] of models.entries()) {
      if (isDynamicModelIdentityV1(model)) {
        context.addIssue({
          code: "custom",
          message: "model must be an explicit pinned identity, not an alias or router",
          path: index === 0 ? ["model"] : ["fallbackModels", index - 1],
        });
      }
    }
  });

export type ReviewRunConfigV3 = z.infer<typeof ReviewRunConfigV3Schema>;
export type OpenRouterProviderRoutingV2 = z.infer<typeof OpenRouterProviderRoutingV2Schema>;

/** Every model this run is permitted to accept a response from, primary first. */
export function permittedModelsV1(config: ReviewRunConfigV3): string[] {
  return [config.model, ...config.fallbackModels];
}

export const REVIEW_RUN_CONFIG_V3_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:review-run-config:v3",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ReviewRunConfigV3Schema, { target: "draft-2020-12", io: "input" }),
};
