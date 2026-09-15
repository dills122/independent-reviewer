import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EVALUATION_CASES_V1 } from "../../evaluation/matrix-selection.js";
import {
  evaluateCaseCompletionV1,
  executeEvaluationCaseV1,
  summarizeRunRecordV1,
  validateLiveEngineStateV1,
} from "../../evaluation/run-matrix.js";
import type { RunRecordEventV1 } from "../../src/contracts/run-record.js";

const at = "2026-09-14T12:00:00.000Z";

describe("evaluation matrix run accounting", () => {
  it("separates reported usage, unknown charges, and conservative retry charges", () => {
    const events = [
      {
        schemaVersion: 1,
        at,
        type: "CALL_SUCCEEDED",
        attemptNumber: 1,
        stage: "PRELIMINARY",
        durationMs: 10,
        responseId: "response_1",
        returnedModel: "model",
        returnedProvider: "provider-a",
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cost: 0.001 },
      },
      {
        schemaVersion: 1,
        at,
        type: "CALL_FAILED",
        attemptNumber: 2,
        stage: "FINAL",
        durationMs: 12,
        error: { name: "Error", code: null, message: "transport failed" },
      },
      {
        schemaVersion: 1,
        at,
        type: "PROVIDER_RETRY_REQUESTED",
        stage: "FINAL",
        failedAttemptNumber: 2,
        retryAttemptNumber: 3,
        retriesUsed: 1,
        maxRetries: 1,
        delayMs: 0,
        chargedFailedTokens: 500,
        chargedFailedCostUsd: 0.002,
      },
    ] satisfies RunRecordEventV1[];

    assert.deepEqual(summarizeRunRecordV1(events), {
      callsStarted: 0,
      callsSucceeded: 1,
      callsFailed: 1,
      reportedPromptTokens: 100,
      reportedCompletionTokens: 20,
      reportedTotalTokens: 120,
      reportedCostUsd: 0.001,
      unknownCostAttempts: 1,
      conservativeRetryTokens: 500,
      conservativeRetryCostUsd: 0.002,
      providers: ["provider-a"],
      terminalState: null,
    });
  });

  it("requires dry admission success and live report/verdict agreement", () => {
    assert.deepEqual(
      evaluateCaseCompletionV1({
        execution: "dry",
        cliExitCode: 0,
        actualVerdict: null,
        expectedVerdict: "READY",
      }),
      { complete: true, verdictMatched: null },
    );
    assert.deepEqual(
      evaluateCaseCompletionV1({
        execution: "live",
        cliExitCode: 2,
        actualVerdict: "NOT_READY",
        expectedVerdict: "NOT_READY",
      }),
      { complete: true, verdictMatched: true },
    );
    assert.deepEqual(
      evaluateCaseCompletionV1({
        execution: "live",
        cliExitCode: 0,
        actualVerdict: "READY_WITH_FOLLOW_UPS",
        expectedVerdict: "READY",
      }),
      { complete: true, verdictMatched: false },
    );
    assert.deepEqual(
      evaluateCaseCompletionV1({
        execution: "live",
        cliExitCode: 1,
        actualVerdict: null,
        expectedVerdict: "READY",
      }),
      { complete: false, verdictMatched: false },
    );
  });

  it("refuses paid evaluation from a dirty engine revision", () => {
    assert.doesNotThrow(() => validateLiveEngineStateV1("dry", true));
    assert.doesNotThrow(() => validateLiveEngineStateV1("live", false));
    assert.throws(() => validateLiveEngineStateV1("live", true), /clean committed checkout/i);
  });

  it("persists an incomplete result when one case fails before execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-matrix-failure-"));
    const testCase = EVALUATION_CASES_V1[0];
    assert.ok(testCase);
    try {
      const result = await executeEvaluationCaseV1(
        {
          testCase,
          execution: "dry",
          runRoot: root,
          configPath: "/unused/config.json",
          configId: "config_test",
          io: { stdout: () => undefined, stderr: () => undefined },
        },
        {
          prepareCase: async () => {
            throw new Error("synthetic fixture failure");
          },
        },
      );

      assert.equal(result.complete, false);
      assert.match(result.error?.message ?? "", /synthetic fixture failure/i);
      const persisted = JSON.parse(
        await readFile(join(root, testCase.id, "matrix-result.json"), "utf8"),
      );
      assert.equal(persisted.complete, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
