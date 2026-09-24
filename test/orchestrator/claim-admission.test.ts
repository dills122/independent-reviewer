import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewRunConfigV3Schema } from "../../src/contracts/review-run-config.js";
import {
  assertClaimFragmentBudgetV1,
  reserveClaimCallsV1,
} from "../../src/orchestrator/claim-admission.js";

const stages = [
  "PRELIMINARY",
  "FINDING_VERIFICATION",
  "FINAL",
  "FINAL_CLAIM_VERIFICATION",
] as const;

function skeletons() {
  const skeleton = () => ({
    messages: [{ role: "user" as const, content: "Inspect frozen evidence." }],
    responseSchema: { type: "object" },
  });
  return {
    PRELIMINARY: skeleton(),
    FINDING_VERIFICATION: skeleton(),
    FINAL: skeleton(),
    FINAL_CLAIM_VERIFICATION: skeleton(),
  };
}

function config() {
  return ReviewRunConfigV3Schema.parse({
    schemaVersion: 3,
    configId: "config_claim_test",
    model: "provider/model-v1",
    providerRouting: { maxPrice: { prompt: 2, completion: 5, request: 0.03 } },
    budgets: {
      maxInitialEvidenceBytes: 100000,
      maxConversationBytes: 100000,
      maxOutputTokensPerCall: 100,
      maxTotalTokens: 100000,
      maxTotalCostUsd: 100,
      timeoutMs: 10000,
    },
  });
}

describe("four-stage claim admission", () => {
  it("refuses unknown price ceilings rather than granting a zero-cost reservation", () => {
    const settings = config();
    for (const field of ["prompt", "completion", "request"]) {
      const invalid = {
        ...settings,
        providerRouting: {
          ...settings.providerRouting,
          maxPrice: { ...settings.providerRouting.maxPrice, [field]: undefined },
        },
      } as unknown as typeof settings;
      assert.throws(() => reserveClaimCallsV1(skeletons(), invalid));
    }
  });

  it("reserves every call plus one largest retry using independently calculated byte bounds", () => {
    const input = skeletons();
    const settings = config();
    const result = reserveClaimCallsV1(input, settings);
    const output = settings.budgets.maxOutputTokensPerCall;
    const future = [0, 4 * output, 6 * output, 8 * output];
    const expected = stages.map(
      (stage, index) =>
        Buffer.byteLength(
          JSON.stringify({
            messages: input[stage].messages,
            responseSchema: input[stage].responseSchema,
          }),
          "utf8",
        ) +
        256 * input[stage].messages.length +
        output +
        (future[index] ?? 0),
    );
    assert.deepEqual(
      stages.map((stage) => result.stageReservations[stage]),
      expected,
    );
    assert.equal(
      result.requiredTokens,
      expected.reduce((sum, value) => sum + value, 0),
    );
    assert.equal(result.retryReservation, Math.max(...expected));
    assert.equal(result.requiredWithRetry, result.requiredTokens + result.retryReservation);
    assert.deepEqual(result.fragmentLimits, {
      claimSetBytes: 400,
      verificationBytes: 200,
      transitionClaimsBytes: 800,
    });
  });

  it("prices four calls and one retry with distinct prompt/output rates and five request fees", () => {
    const settings = config();
    const result = reserveClaimCallsV1(skeletons(), settings);
    const outputs = 5 * settings.budgets.maxOutputTokensPerCall;
    const expected =
      ((result.requiredWithRetry - outputs) * 2) / 1_000_000 + (outputs * 5) / 1_000_000 + 5 * 0.03;
    assert.ok(Math.abs(result.reservedCostUsd - expected) < 1e-12);
    const higherFee = {
      ...settings,
      providerRouting: {
        ...settings.providerRouting,
        maxPrice: { ...settings.providerRouting.maxPrice, request: 0.05 },
      },
    };
    assert.ok(
      Math.abs(
        reserveClaimCallsV1(skeletons(), higherFee).reservedCostUsd - result.reservedCostUsd - 0.1,
      ) < 1e-12,
    );
  });

  it("rejects budgets sufficient for three calls but insufficient for final verification and retry", () => {
    const settings = config();
    const reservation = reserveClaimCallsV1(skeletons(), settings);
    const firstThree =
      reservation.requiredTokens - reservation.stageReservations.FINAL_CLAIM_VERIFICATION;
    for (const maxTotalTokens of [
      firstThree,
      reservation.requiredTokens,
      reservation.requiredWithRetry - 1,
    ]) {
      assert.throws(() =>
        reserveClaimCallsV1(skeletons(), {
          ...settings,
          budgets: { ...settings.budgets, maxTotalTokens },
        }),
      );
    }
    assert.doesNotThrow(() =>
      reserveClaimCallsV1(skeletons(), {
        ...settings,
        budgets: { ...settings.budgets, maxTotalTokens: reservation.requiredWithRetry },
      }),
    );
  });

  it("reserves exactly one largest retry independent of configured transient-attempt count", () => {
    const settings = config();
    const first = reserveClaimCallsV1(skeletons(), {
      ...settings,
      budgets: { ...settings.budgets, maxAttemptsPerCall: 1 },
    });
    const many = reserveClaimCallsV1(skeletons(), {
      ...settings,
      budgets: { ...settings.budgets, maxAttemptsPerCall: 5 },
    });
    assert.equal(first.requiredWithRetry, many.requiredWithRetry);
    assert.equal(first.reservedCostUsd, many.reservedCostUsd);
  });

  it("increases reservations when response schemas, messages, or output caps grow", () => {
    const settings = config();
    const baseline = reserveClaimCallsV1(skeletons(), settings);
    const biggerSchema = skeletons();
    biggerSchema.FINAL.responseSchema = { type: "object", description: "x".repeat(100) } as {
      type: string;
    };
    const schemaResult = reserveClaimCallsV1(biggerSchema, settings);
    assert.ok(schemaResult.stageReservations.FINAL > baseline.stageReservations.FINAL);
    assert.equal(
      schemaResult.stageReservations.PRELIMINARY,
      baseline.stageReservations.PRELIMINARY,
    );
    const biggerMessage = skeletons();
    biggerMessage.FINAL_CLAIM_VERIFICATION.messages[0] = {
      role: "user",
      content: "😀".repeat(100),
    };
    assert.ok(
      reserveClaimCallsV1(biggerMessage, settings).requiredWithRetry > baseline.requiredWithRetry,
    );
    const biggerOutput = reserveClaimCallsV1(skeletons(), {
      ...settings,
      budgets: { ...settings.budgets, maxOutputTokensPerCall: 200 },
    });
    assert.ok(biggerOutput.requiredWithRetry > baseline.requiredWithRetry);
    assert.equal(biggerOutput.fragmentLimits.claimSetBytes, 800);
  });

  it("rejects cost or future conversation capacity exhaustion before calls", () => {
    const settings = config();
    const input = skeletons();
    const result = reserveClaimCallsV1(input, settings);
    assert.throws(() =>
      reserveClaimCallsV1(input, {
        ...settings,
        budgets: { ...settings.budgets, maxTotalCostUsd: result.reservedCostUsd / 2 },
      }),
    );
    const futureBound =
      Buffer.byteLength(JSON.stringify(input.FINAL_CLAIM_VERIFICATION.messages), "utf8") +
      result.fragmentLimits.transitionClaimsBytes;
    assert.throws(() =>
      reserveClaimCallsV1(input, {
        ...settings,
        budgets: { ...settings.budgets, maxConversationBytes: futureBound - 1 },
      }),
    );
    assert.doesNotThrow(() =>
      reserveClaimCallsV1(input, {
        ...settings,
        budgets: { ...settings.budgets, maxConversationBytes: futureBound },
      }),
    );
  });
});

describe("escaped claim fragment limits", () => {
  it("measures UTF-8 after nested JSON escaping and rejects one byte over budget", () => {
    for (const value of [
      { assertion: 'A "quoted" assertion.' },
      { assertion: "😀漢字" },
      { assertion: "line\nslash\\end" },
      ["a", "b"],
    ]) {
      const bytes = Buffer.byteLength(JSON.stringify(JSON.stringify(value)), "utf8");
      const before = JSON.stringify(value);
      assert.doesNotThrow(() => assertClaimFragmentBudgetV1(value, bytes, "claim set"));
      assert.throws(() => assertClaimFragmentBudgetV1(value, bytes - 1, "claim set"));
      assert.equal(JSON.stringify(value), before);
    }
  });

  it("does not accept raw JSON byte count as escaped fragment capacity", () => {
    const value = { assertion: '"'.repeat(100) };
    const raw = Buffer.byteLength(JSON.stringify(value), "utf8");
    const escaped = Buffer.byteLength(JSON.stringify(JSON.stringify(value)), "utf8");
    assert.ok(escaped > raw);
    assert.throws(() => assertClaimFragmentBudgetV1(value, raw, "claim set"));
    assert.doesNotThrow(() => assertClaimFragmentBudgetV1(value, escaped, "claim set"));
  });
});
