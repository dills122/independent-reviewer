import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { REVIEW_RUN_CONFIG_V2_JSON_SCHEMA, ReviewRunConfigV2Schema } from "../../src/index.js";

const validConfig = {
  schemaVersion: 2,
  configId: "config_local",
  model: "vendor/model",
  providerRouting: {
    order: ["provider-a/fp4", "provider-b/bf16"],
    maxPrice: { prompt: 0.03, completion: 0.14, request: 0 },
  },
  budgets: {
    maxInitialEvidenceBytes: 250_000,
    maxConversationBytes: 1_000_000,
    maxOutputTokensPerCall: 4_000,
    maxTotalTokens: 20_000,
    maxTotalCostUsd: 1,
    timeoutMs: 120_000,
  },
};

describe("review run configuration schemas", () => {
  it("accepts a bounded two-call configuration", () => {
    assert.equal(ReviewRunConfigV2Schema.safeParse(validConfig).success, true);
  });

  it("requires enough total capacity to reserve both mandatory outputs", () => {
    const invalid = structuredClone(validConfig);
    invalid.budgets.maxTotalTokens = 7_999;

    assert.equal(ReviewRunConfigV2Schema.safeParse(invalid).success, false);
  });

  it("accepts a pinned endpoint but rejects empty or duplicate routes and unbounded prices", () => {
    const oneEndpoint = structuredClone(validConfig);
    oneEndpoint.providerRouting.order = ["provider-a/fp4"];
    assert.equal(ReviewRunConfigV2Schema.safeParse(oneEndpoint).success, true);
    const empty = structuredClone(validConfig);
    empty.providerRouting.order = [];
    assert.equal(ReviewRunConfigV2Schema.safeParse(empty).success, false);

    const duplicateEndpoint = structuredClone(validConfig);
    duplicateEndpoint.providerRouting.order = ["provider-a/fp4", "provider-a/fp4"];
    assert.equal(ReviewRunConfigV2Schema.safeParse(duplicateEndpoint).success, false);

    const unboundedPrice = structuredClone(validConfig);
    unboundedPrice.providerRouting.maxPrice.completion = Number.POSITIVE_INFINITY;
    assert.equal(ReviewRunConfigV2Schema.safeParse(unboundedPrice).success, false);
  });

  it("matches the committed JSON Schema artifact", async () => {
    const v2Schema = JSON.parse(
      await readFile(resolve("schemas", "review-run-config-v2.schema.json"), "utf8"),
    );

    assert.deepEqual(v2Schema, REVIEW_RUN_CONFIG_V2_JSON_SCHEMA);
  });
});
