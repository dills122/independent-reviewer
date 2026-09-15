import * as z from "zod";

import { canonicalizeJson, digestCanonicalJson } from "./canonical-json.js";
import { STRUCTURAL_JSON_SCHEMA_COMMENT_V1 } from "./json-schema-contract.js";
import {
  ReviewModelSlugV1Schema,
  type ReviewRunConfigV3,
  ReviewRunConfigV3Schema,
} from "./review-run-config.js";
import { DigestV1Schema } from "./snapshot-manifest.js";

const PROFILE_VERSION_V1 = 1 as const;

const REVIEW_MODEL_PROFILES_V1 = {
  "openai/gpt-oss-120b": {
    fallbackModels: ["z-ai/glm-5.3-flash", "deepseek/deepseek-v4-flash-0731"],
    providerRouting: {
      order: ["coreweave/fp4", "deepinfra/bf16"],
      maxPrice: { prompt: 0.1, completion: 0.8, request: 0 },
    },
    budgets: {
      maxInitialEvidenceBytes: 350_000,
      maxConversationBytes: 600_000,
      maxOutputTokensPerCall: 8_192,
      maxTotalTokens: 1_400_000,
      timeoutMs: 240_000,
      maxAttemptsPerCall: 3,
      minimumCallIntervalMs: 1_500,
    },
  },
} as const;

type SupportedReviewModelV1 = keyof typeof REVIEW_MODEL_PROFILES_V1;

function isSupportedReviewModelV1(model: string): model is SupportedReviewModelV1 {
  return Object.hasOwn(REVIEW_MODEL_PROFILES_V1, model);
}

export function supportedReviewModelsV1(): readonly SupportedReviewModelV1[] {
  return (Object.keys(REVIEW_MODEL_PROFILES_V1) as SupportedReviewModelV1[]).sort();
}

export const SupportedReviewModelV1Schema = ReviewModelSlugV1Schema.refine(
  isSupportedReviewModelV1,
  "must name a supported review model profile",
);

const MaxReviewCostUsdV1Schema = z.number().positive().max(1_000);

export const SimpleReviewSettingsV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  model: SupportedReviewModelV1Schema,
  maxCostUsd: MaxReviewCostUsdV1Schema,
  requireAuthorExplanation: z.boolean(),
  discoverRepositorySteering: z.boolean(),
});

export const SimpleReviewSettingsV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  model: SupportedReviewModelV1Schema,
  maxCostUsd: MaxReviewCostUsdV1Schema,
  requireAuthorExplanation: z.boolean(),
  useReviewerRules: z.boolean(),
});

/** @deprecated Use `SimpleReviewSettingsOverridesV2Schema`. Kept for v1 API compatibility. */
export const SimpleReviewSettingsOverridesV1Schema = z.strictObject({
  model: ReviewModelSlugV1Schema.optional(),
  maxCostUsd: MaxReviewCostUsdV1Schema.optional(),
  requireAuthorExplanation: z.boolean().optional(),
  discoverRepositorySteering: z.boolean().optional(),
});

export const SimpleReviewSettingsOverridesV2Schema = z.strictObject({
  model: ReviewModelSlugV1Schema.optional(),
  maxCostUsd: MaxReviewCostUsdV1Schema.optional(),
  requireAuthorExplanation: z.boolean().optional(),
  useReviewerRules: z.boolean().optional(),
});

const SimpleReviewSettingSourceV1Schema = z.enum(["CLI", "LOCAL", "ENGINE_DEFAULT"]);
export const SimpleReviewSettingsProvenanceV1Schema = z.strictObject({
  model: SimpleReviewSettingSourceV1Schema,
  maxCostUsd: SimpleReviewSettingSourceV1Schema,
  requireAuthorExplanation: SimpleReviewSettingSourceV1Schema,
  discoverRepositorySteering: SimpleReviewSettingSourceV1Schema,
});
export const SimpleReviewSettingsProvenanceV2Schema = z.strictObject({
  model: SimpleReviewSettingSourceV1Schema,
  maxCostUsd: SimpleReviewSettingSourceV1Schema,
  requireAuthorExplanation: SimpleReviewSettingSourceV1Schema,
  useReviewerRules: SimpleReviewSettingSourceV1Schema,
});

const ReviewModelProfileRefV1Schema = z.strictObject({
  schemaVersion: z.literal(PROFILE_VERSION_V1),
  model: SupportedReviewModelV1Schema,
});

function reviewRunConfigIdV1(config: Omit<ReviewRunConfigV3, "configId">): string {
  return `config_${digestCanonicalJson({ profileVersion: PROFILE_VERSION_V1, config }).value}`;
}

function reviewRunConfigForSettingsV1(
  settings: Pick<z.infer<typeof SimpleReviewSettingsV2Schema>, "model" | "maxCostUsd">,
): ReviewRunConfigV3 {
  if (!isSupportedReviewModelV1(settings.model)) {
    throw new Error(`Unsupported review model ${settings.model}.`);
  }
  const profile = REVIEW_MODEL_PROFILES_V1[settings.model];
  const profileConfig = {
    schemaVersion: 3 as const,
    model: settings.model,
    fallbackModels: [...profile.fallbackModels],
    providerRouting: {
      order: [...profile.providerRouting.order],
      maxPrice: { ...profile.providerRouting.maxPrice },
    },
    budgets: {
      ...profile.budgets,
      maxTotalCostUsd: settings.maxCostUsd,
    },
  };
  const parsedProfileConfig = ReviewRunConfigV3Schema.parse({
    ...profileConfig,
    configId: "config_pending",
  });
  const { configId: _pendingId, ...configWithoutId } = parsedProfileConfig;
  return ReviewRunConfigV3Schema.parse({
    ...configWithoutId,
    configId: reviewRunConfigIdV1(configWithoutId),
  });
}

function validateResolvedSimpleReviewSettingsV1(
  resolved: {
    settings: Pick<z.infer<typeof SimpleReviewSettingsV2Schema>, "model" | "maxCostUsd">;
    profile: z.infer<typeof ReviewModelProfileRefV1Schema>;
    settingsDigest: z.infer<typeof DigestV1Schema>;
    reviewRunConfig: ReviewRunConfigV3;
    reviewRunConfigDigest: z.infer<typeof DigestV1Schema>;
  },
  context: z.RefinementCtx,
) {
  const expectedConfig = reviewRunConfigForSettingsV1(resolved.settings);
  const expectedSettingsDigest = digestCanonicalJson(resolved.settings);
  const expectedConfigDigest = digestCanonicalJson(expectedConfig);
  if (canonicalizeJson(resolved.settingsDigest) !== canonicalizeJson(expectedSettingsDigest)) {
    context.addIssue({
      code: "custom",
      message: "settings digest does not match",
      path: ["settingsDigest"],
    });
  }
  if (resolved.profile.model !== resolved.settings.model) {
    context.addIssue({
      code: "custom",
      message: "profile does not match selected model",
      path: ["profile", "model"],
    });
  }
  if (canonicalizeJson(resolved.reviewRunConfig) !== canonicalizeJson(expectedConfig)) {
    context.addIssue({
      code: "custom",
      message: "resolved review policy does not match settings and profile",
      path: ["reviewRunConfig"],
    });
  }
  if (canonicalizeJson(resolved.reviewRunConfigDigest) !== canonicalizeJson(expectedConfigDigest)) {
    context.addIssue({
      code: "custom",
      message: "review policy digest does not match",
      path: ["reviewRunConfigDigest"],
    });
  }
}

export const ResolvedSimpleReviewSettingsV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    settings: SimpleReviewSettingsV1Schema,
    provenance: SimpleReviewSettingsProvenanceV1Schema,
    profile: ReviewModelProfileRefV1Schema,
    settingsDigest: DigestV1Schema,
    reviewRunConfig: ReviewRunConfigV3Schema,
    reviewRunConfigDigest: DigestV1Schema,
  })
  .superRefine(validateResolvedSimpleReviewSettingsV1);

export const ResolvedSimpleReviewSettingsV2Schema = z
  .strictObject({
    schemaVersion: z.literal(2),
    settings: SimpleReviewSettingsV2Schema,
    provenance: SimpleReviewSettingsProvenanceV2Schema,
    profile: ReviewModelProfileRefV1Schema,
    settingsDigest: DigestV1Schema,
    reviewRunConfig: ReviewRunConfigV3Schema,
    reviewRunConfigDigest: DigestV1Schema,
  })
  .superRefine(validateResolvedSimpleReviewSettingsV1);

export type SimpleReviewSettingsV1 = z.infer<typeof SimpleReviewSettingsV1Schema>;
export type SimpleReviewSettingsV2 = z.infer<typeof SimpleReviewSettingsV2Schema>;
export type ResolvedSimpleReviewSettingsV1 = z.infer<typeof ResolvedSimpleReviewSettingsV1Schema>;
export type ResolvedSimpleReviewSettingsV2 = z.infer<typeof ResolvedSimpleReviewSettingsV2Schema>;

/** Strictly decodes historical local settings and translates their renamed field into v2. */
export function translateSimpleReviewSettingsV1ToV2(value: unknown): SimpleReviewSettingsV2 {
  const historical = SimpleReviewSettingsV1Schema.parse(value);
  return SimpleReviewSettingsV2Schema.parse({
    schemaVersion: 2,
    model: historical.model,
    maxCostUsd: historical.maxCostUsd,
    requireAuthorExplanation: historical.requireAuthorExplanation,
    useReviewerRules: historical.discoverRepositorySteering,
  });
}

export interface ResolveSimpleReviewSettingsInputV2 {
  local?: unknown;
  cli?: unknown;
}

/** @deprecated Use `ResolveSimpleReviewSettingsInputV2`. */
export interface ResolveSimpleReviewSettingsInputV1 {
  local?: unknown;
  cli?: unknown;
}

function settingSourceV1(
  name: keyof z.infer<typeof SimpleReviewSettingsOverridesV2Schema>,
  cli: z.infer<typeof SimpleReviewSettingsOverridesV2Schema>,
  local: SimpleReviewSettingsV2 | undefined,
): z.infer<typeof SimpleReviewSettingSourceV1Schema> {
  if (cli[name] !== undefined) return "CLI";
  if (local?.[name] !== undefined) return "LOCAL";
  return "ENGINE_DEFAULT";
}

export function resolveSimpleReviewSettingsV2(
  input: ResolveSimpleReviewSettingsInputV2,
): ResolvedSimpleReviewSettingsV2 {
  const cli = SimpleReviewSettingsOverridesV2Schema.parse(input.cli ?? {});
  const local =
    input.local === undefined ? undefined : SimpleReviewSettingsV2Schema.parse(input.local);
  const selectedModel = cli.model ?? local?.model;
  if (selectedModel !== undefined && !isSupportedReviewModelV1(selectedModel)) {
    throw new Error(`Unsupported review model ${selectedModel}.`);
  }
  const settings = SimpleReviewSettingsV2Schema.parse({
    schemaVersion: 2,
    model: selectedModel,
    maxCostUsd: cli.maxCostUsd ?? local?.maxCostUsd,
    requireAuthorExplanation:
      cli.requireAuthorExplanation ?? local?.requireAuthorExplanation ?? true,
    useReviewerRules: cli.useReviewerRules ?? local?.useReviewerRules ?? true,
  });
  const reviewRunConfig = reviewRunConfigForSettingsV1(settings);
  return ResolvedSimpleReviewSettingsV2Schema.parse({
    schemaVersion: 2,
    settings,
    provenance: {
      model: settingSourceV1("model", cli, local),
      maxCostUsd: settingSourceV1("maxCostUsd", cli, local),
      requireAuthorExplanation: settingSourceV1("requireAuthorExplanation", cli, local),
      useReviewerRules: settingSourceV1("useReviewerRules", cli, local),
    },
    profile: { schemaVersion: PROFILE_VERSION_V1, model: settings.model },
    settingsDigest: digestCanonicalJson(settings),
    reviewRunConfig,
    reviewRunConfigDigest: digestCanonicalJson(reviewRunConfig),
  });
}

/**
 * @deprecated Use `resolveSimpleReviewSettingsV2`.
 *
 * Preserves the public v1 field name at both input and output boundaries while delegating policy
 * resolution through the current implementation. No v1 input is accepted by the v2 resolver.
 */
export function resolveSimpleReviewSettingsV1(
  input: ResolveSimpleReviewSettingsInputV1,
): ResolvedSimpleReviewSettingsV1 {
  const historicalCli = SimpleReviewSettingsOverridesV1Schema.parse(input.cli ?? {});
  const historicalLocal =
    input.local === undefined ? undefined : SimpleReviewSettingsV1Schema.parse(input.local);
  const local =
    historicalLocal === undefined
      ? undefined
      : translateSimpleReviewSettingsV1ToV2(historicalLocal);
  const current = resolveSimpleReviewSettingsV2({
    ...(local ? { local } : {}),
    cli: {
      ...(historicalCli.model !== undefined ? { model: historicalCli.model } : {}),
      ...(historicalCli.maxCostUsd !== undefined ? { maxCostUsd: historicalCli.maxCostUsd } : {}),
      ...(historicalCli.requireAuthorExplanation !== undefined
        ? { requireAuthorExplanation: historicalCli.requireAuthorExplanation }
        : {}),
      ...(historicalCli.discoverRepositorySteering !== undefined
        ? { useReviewerRules: historicalCli.discoverRepositorySteering }
        : {}),
    },
  });
  const settings = SimpleReviewSettingsV1Schema.parse({
    schemaVersion: 1,
    model: current.settings.model,
    maxCostUsd: current.settings.maxCostUsd,
    requireAuthorExplanation: current.settings.requireAuthorExplanation,
    discoverRepositorySteering: current.settings.useReviewerRules,
  });
  return ResolvedSimpleReviewSettingsV1Schema.parse({
    schemaVersion: 1,
    settings,
    provenance: {
      model: current.provenance.model,
      maxCostUsd: current.provenance.maxCostUsd,
      requireAuthorExplanation: current.provenance.requireAuthorExplanation,
      discoverRepositorySteering: current.provenance.useReviewerRules,
    },
    profile: current.profile,
    settingsDigest: digestCanonicalJson(settings),
    reviewRunConfig: current.reviewRunConfig,
    reviewRunConfigDigest: current.reviewRunConfigDigest,
  });
}

export const SIMPLE_REVIEW_SETTINGS_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:simple-review-settings:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(SimpleReviewSettingsV1Schema, { target: "draft-2020-12", io: "input" }),
};

export const SIMPLE_REVIEW_SETTINGS_V2_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:simple-review-settings:v2",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(SimpleReviewSettingsV2Schema, { target: "draft-2020-12", io: "input" }),
};

export const RESOLVED_SIMPLE_REVIEW_SETTINGS_V1_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:resolved-simple-review-settings:v1",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ResolvedSimpleReviewSettingsV1Schema, {
    target: "draft-2020-12",
    io: "input",
  }),
};

export const RESOLVED_SIMPLE_REVIEW_SETTINGS_V2_JSON_SCHEMA = {
  $id: "urn:independent-reviewer:schema:resolved-simple-review-settings:v2",
  $comment: STRUCTURAL_JSON_SCHEMA_COMMENT_V1,
  ...z.toJSONSchema(ResolvedSimpleReviewSettingsV2Schema, {
    target: "draft-2020-12",
    io: "input",
  }),
};
