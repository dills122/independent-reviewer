import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { REVIEW_RUN_CONFIG_V1_JSON_SCHEMA, ReviewRunConfigV1Schema } from "../../src/index.js";

const validConfig = {
  schemaVersion: 1,
  configId: "config_local",
  model: "vendor/model",
  budgets: {
    maxInitialEvidenceBytes: 250_000,
    maxConversationBytes: 1_000_000,
    maxOutputTokensPerCall: 4_000,
    maxTotalTokens: 20_000,
    timeoutMs: 120_000,
  },
};

describe("ReviewRunConfigV1Schema", () => {
  it("accepts a bounded two-call configuration", () => {
    assert.equal(ReviewRunConfigV1Schema.safeParse(validConfig).success, true);
  });

  it("requires enough total capacity to reserve both mandatory outputs", () => {
    const invalid = structuredClone(validConfig);
    invalid.budgets.maxTotalTokens = 7_999;

    assert.equal(ReviewRunConfigV1Schema.safeParse(invalid).success, false);
  });

  it("matches the committed JSON Schema artifact", async () => {
    const schema = JSON.parse(
      await readFile(resolve("schemas", "review-run-config-v1.schema.json"), "utf8"),
    );

    assert.deepEqual(schema, REVIEW_RUN_CONFIG_V1_JSON_SCHEMA);
  });
});
