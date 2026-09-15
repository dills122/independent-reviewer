import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  RESOLVED_SIMPLE_REVIEW_SETTINGS_V1_JSON_SCHEMA,
  RESOLVED_SIMPLE_REVIEW_SETTINGS_V2_JSON_SCHEMA,
  ResolvedSimpleReviewSettingsV2Schema,
  resolveSimpleReviewSettingsV2,
  SIMPLE_REVIEW_SETTINGS_V1_JSON_SCHEMA,
  SIMPLE_REVIEW_SETTINGS_V2_JSON_SCHEMA,
  SimpleReviewSettingsV1Schema,
  SimpleReviewSettingsV2Schema,
  supportedReviewModelsV1,
} from "../../src/index.js";

describe("simple review settings", () => {
  it("resolves CLI values over local settings and engine defaults", () => {
    const resolved = resolveSimpleReviewSettingsV2({
      local: {
        schemaVersion: 2,
        model: "openai/gpt-oss-120b",
        maxCostUsd: 0.25,
        requireAuthorExplanation: false,
        useReviewerRules: false,
      },
      cli: {
        maxCostUsd: 0.05,
        requireAuthorExplanation: true,
      },
    });

    assert.deepEqual(resolved.settings, {
      schemaVersion: 2,
      model: "openai/gpt-oss-120b",
      maxCostUsd: 0.05,
      requireAuthorExplanation: true,
      useReviewerRules: false,
    });
    assert.deepEqual(resolved.provenance, {
      model: "LOCAL",
      maxCostUsd: "CLI",
      requireAuthorExplanation: "CLI",
      useReviewerRules: "LOCAL",
    });
    assert.equal(resolved.reviewRunConfig.model, "openai/gpt-oss-120b");
    assert.equal(resolved.reviewRunConfig.budgets.maxTotalCostUsd, 0.05);
  });

  it("uses safe engine defaults for optional behavior", () => {
    const resolved = resolveSimpleReviewSettingsV2({
      cli: { model: "openai/gpt-oss-120b", maxCostUsd: 0.05 },
    });

    assert.equal(resolved.settings.requireAuthorExplanation, true);
    assert.equal(resolved.settings.useReviewerRules, true);
    assert.equal(resolved.provenance.requireAuthorExplanation, "ENGINE_DEFAULT");
    assert.equal(resolved.provenance.useReviewerRules, "ENGINE_DEFAULT");
  });

  it("requires model and maximum cost from CLI or local settings", () => {
    assert.throws(
      () => resolveSimpleReviewSettingsV2({ cli: { model: "openai/gpt-oss-120b" } }),
      /maxCostUsd/,
    );
    assert.throws(() => resolveSimpleReviewSettingsV2({ cli: { maxCostUsd: 0.05 } }), /model/);
  });

  it("rejects unsupported models instead of guessing runtime policy", () => {
    assert.throws(
      () =>
        resolveSimpleReviewSettingsV2({
          cli: { model: "vendor/unknown", maxCostUsd: 0.05 },
        }),
      /Unsupported review model vendor\/unknown/,
    );
  });

  it("enumerates only qualified model profiles", () => {
    assert.deepEqual(supportedReviewModelsV1(), ["openai/gpt-oss-120b"]);
  });

  it("matches the existing qualified runtime configuration", async () => {
    const existing = JSON.parse(
      await readFile(resolve("examples", "review-config.gpt-oss-120b.json"), "utf8"),
    ) as Record<string, unknown>;
    const resolved = resolveSimpleReviewSettingsV2({
      cli: { model: "openai/gpt-oss-120b", maxCostUsd: 0.25 },
    });

    assert.deepEqual(resolved.reviewRunConfig, {
      ...existing,
      configId: resolved.reviewRunConfig.configId,
      providerRouting: {
        ...(existing.providerRouting as object),
        pinToOrder: false,
        zeroDataRetention: false,
        denyDataCollection: false,
      },
    });
  });

  it("produces stable identities and a valid resolved contract", () => {
    const input = { cli: { model: "openai/gpt-oss-120b", maxCostUsd: 0.05 } } as const;
    const first = resolveSimpleReviewSettingsV2(input);
    const second = resolveSimpleReviewSettingsV2(input);

    assert.deepEqual(first, second);
    assert.match(first.reviewRunConfig.configId, /^config_[a-f0-9]{64}$/);
    assert.equal(SimpleReviewSettingsV2Schema.safeParse(first.settings).success, true);
    assert.equal(ResolvedSimpleReviewSettingsV2Schema.safeParse(first).success, true);
  });

  it("changes resolved identity when a user-controlled setting changes", () => {
    const low = resolveSimpleReviewSettingsV2({
      cli: { model: "openai/gpt-oss-120b", maxCostUsd: 0.05 },
    });
    const high = resolveSimpleReviewSettingsV2({
      cli: { model: "openai/gpt-oss-120b", maxCostUsd: 0.1 },
    });

    assert.notDeepEqual(low.settingsDigest, high.settingsDigest);
    assert.notEqual(low.reviewRunConfig.configId, high.reviewRunConfig.configId);
    assert.notDeepEqual(low.reviewRunConfigDigest, high.reviewRunConfigDigest);
  });

  it("rejects a self-consistent-looking resolved policy replacement", () => {
    const resolved = resolveSimpleReviewSettingsV2({
      cli: { model: "openai/gpt-oss-120b", maxCostUsd: 0.05 },
    });
    const replacement = structuredClone(resolved);
    replacement.reviewRunConfig.providerRouting.maxPrice.completion = 0.7;

    assert.equal(ResolvedSimpleReviewSettingsV2Schema.safeParse(replacement).success, false);
  });

  it("rejects unknown settings fields", () => {
    assert.equal(
      SimpleReviewSettingsV2Schema.safeParse({
        schemaVersion: 2,
        model: "openai/gpt-oss-120b",
        maxCostUsd: 0.05,
        requireAuthorExplanation: true,
        useReviewerRules: true,
        unsafeRoutingOverride: true,
      }).success,
      false,
    );
  });

  it("keeps settings v1 strict for historical reads and uses v2 for truthful writes", () => {
    assert.equal(
      SimpleReviewSettingsV1Schema.safeParse({
        schemaVersion: 1,
        model: "openai/gpt-oss-120b",
        maxCostUsd: 0.05,
        requireAuthorExplanation: true,
        discoverRepositorySteering: false,
      }).success,
      true,
    );
    assert.equal(
      SimpleReviewSettingsV1Schema.safeParse({
        schemaVersion: 1,
        model: "openai/gpt-oss-120b",
        maxCostUsd: 0.05,
        requireAuthorExplanation: true,
        useReviewerRules: false,
      }).success,
      false,
    );
  });

  it("matches the committed JSON Schema artifacts", async () => {
    const [settingsV1Schema, settingsV2Schema, resolvedV1Schema, resolvedV2Schema] =
      await Promise.all([
        readFile(resolve("schemas", "simple-review-settings-v1.schema.json"), "utf8"),
        readFile(resolve("schemas", "simple-review-settings-v2.schema.json"), "utf8"),
        readFile(resolve("schemas", "resolved-simple-review-settings-v1.schema.json"), "utf8"),
        readFile(resolve("schemas", "resolved-simple-review-settings-v2.schema.json"), "utf8"),
      ]);

    assert.deepEqual(JSON.parse(settingsV1Schema), SIMPLE_REVIEW_SETTINGS_V1_JSON_SCHEMA);
    assert.deepEqual(JSON.parse(settingsV2Schema), SIMPLE_REVIEW_SETTINGS_V2_JSON_SCHEMA);
    assert.deepEqual(JSON.parse(resolvedV1Schema), RESOLVED_SIMPLE_REVIEW_SETTINGS_V1_JSON_SCHEMA);
    assert.deepEqual(JSON.parse(resolvedV2Schema), RESOLVED_SIMPLE_REVIEW_SETTINGS_V2_JSON_SCHEMA);
  });
});
