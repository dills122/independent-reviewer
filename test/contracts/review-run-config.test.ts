import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { REVIEW_RUN_CONFIG_V3_JSON_SCHEMA, ReviewRunConfigV3Schema } from "../../src/index.js";

const validConfig = {
  schemaVersion: 3,
  configId: "config_local",
  model: "vendor/model",
  fallbackModels: ["vendor/fallback-model"],
  providerRouting: {
    order: ["provider-a/fp4", "provider-b/bf16"],
    maxPrice: { prompt: 0.5, completion: 1.5, request: 0 },
  },
  budgets: {
    maxInitialEvidenceBytes: 250_000,
    maxConversationBytes: 1_000_000,
    maxOutputTokensPerCall: 4_000,
    maxTotalTokens: 20_000,
    maxTotalCostUsd: 1,
    timeoutMs: 120_000,
    maxAttemptsPerCall: 3,
    minimumCallIntervalMs: 1_500,
  },
};

describe("review run configuration schemas", () => {
  it("accepts a bounded two-call configuration", () => {
    assert.equal(ReviewRunConfigV3Schema.safeParse(validConfig).success, true);
  });

  it("requires enough total capacity to reserve both mandatory outputs", () => {
    const invalid = structuredClone(validConfig);
    invalid.budgets.maxTotalTokens = 7_999;

    assert.equal(ReviewRunConfigV3Schema.safeParse(invalid).success, false);
  });

  it("defaults to open routing with failover and a paced call interval", () => {
    const openRouting = structuredClone(validConfig) as Record<string, unknown>;
    delete (openRouting.providerRouting as { order?: unknown }).order;
    const parsed = ReviewRunConfigV3Schema.safeParse(openRouting);
    assert.equal(parsed.success, true);
    assert.equal(parsed.data?.providerRouting.pinToOrder, false);
    assert.equal(parsed.data?.providerRouting.zeroDataRetention, false);
    assert.equal(parsed.data?.providerRouting.denyDataCollection, false);
    assert.equal(parsed.data?.budgets.maxAttemptsPerCall, 3);
  });

  it("rejects a duplicated model in the fallback chain", () => {
    const duplicateModel = structuredClone(validConfig);
    duplicateModel.fallbackModels = ["vendor/model"];
    assert.equal(ReviewRunConfigV3Schema.safeParse(duplicateModel).success, false);
  });

  it("rejects dynamic aliases and automatic routers case-insensitively", () => {
    const dynamicModels = [
      "vendor/model:latest",
      "vendor/model:PREVIEW",
      "vendor/model:Beta",
      "vendor/model:ONLINE",
      "vendor/model:Floor",
      "vendor/model:NITRO",
      "openrouter/auto",
      "OpenRouter/AUTO-BETA",
      "~anthropic/claude-opus-latest",
      "~Google/Gemini-Pro-LATEST:NITRO",
    ];

    for (const dynamicModel of dynamicModels) {
      const config = structuredClone(validConfig);
      config.fallbackModels = [dynamicModel];
      assert.equal(
        ReviewRunConfigV3Schema.safeParse(config).success,
        false,
        `${dynamicModel} must not pass as a pinned model identity`,
      );
    }
  });

  it("accepts pinned model slugs that contain auto as ordinary text", () => {
    for (const pinnedModel of ["vendor/automatic-reviewer-2026-09-01", "vendor/auto-model-1"]) {
      const config = structuredClone(validConfig);
      config.model = pinnedModel;
      assert.equal(
        ReviewRunConfigV3Schema.safeParse(config).success,
        true,
        `${pinnedModel} must remain eligible as an explicit model identity`,
      );
    }
  });

  it("requires an explicit order before a run may pin away its failover", () => {
    const pinnedWithoutOrder = structuredClone(validConfig) as Record<string, unknown>;
    const routing = pinnedWithoutOrder.providerRouting as Record<string, unknown>;
    delete routing.order;
    routing.pinToOrder = true;
    assert.equal(ReviewRunConfigV3Schema.safeParse(pinnedWithoutOrder).success, false);
  });

  it("rejects empty or duplicate routes and unbounded prices", () => {
    const oneEndpoint = structuredClone(validConfig);
    oneEndpoint.providerRouting.order = ["provider-a/fp4"];
    assert.equal(ReviewRunConfigV3Schema.safeParse(oneEndpoint).success, true);
    const empty = structuredClone(validConfig);
    empty.providerRouting.order = [];
    assert.equal(ReviewRunConfigV3Schema.safeParse(empty).success, false);

    const duplicateEndpoint = structuredClone(validConfig);
    duplicateEndpoint.providerRouting.order = ["provider-a/fp4", "provider-a/fp4"];
    assert.equal(ReviewRunConfigV3Schema.safeParse(duplicateEndpoint).success, false);

    const unboundedPrice = structuredClone(validConfig);
    unboundedPrice.providerRouting.maxPrice.completion = Number.POSITIVE_INFINITY;
    assert.equal(ReviewRunConfigV3Schema.safeParse(unboundedPrice).success, false);
  });

  it("matches the committed JSON Schema artifact", async () => {
    const v3Schema = JSON.parse(
      await readFile(resolve("schemas", "review-run-config-v3.schema.json"), "utf8"),
    );

    assert.deepEqual(v3Schema, REVIEW_RUN_CONFIG_V3_JSON_SCHEMA);
  });
});
