import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EVALUATION_CASES_V1 } from "../../evaluation/matrix-selection.js";
import {
  evaluateCaseCompletionV1,
  executeEvaluationCaseV1,
  MAX_MATRIX_ERROR_MESSAGE_LENGTH_V1,
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

  it("reads the current standards report contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-matrix-standards-v3-"));
    const testCase = EVALUATION_CASES_V1.find(({ reviewMode }) => reviewMode === "standards");
    assert.ok(testCase);
    try {
      const result = await executeEvaluationCaseV1(
        {
          testCase,
          execution: "live",
          runRoot: root,
          configPath: "/unused/config.json",
          configId: "config_test",
          io: { stdout: () => undefined, stderr: () => undefined },
        },
        {
          prepareCase: async (_testCase, caseRoot) => {
            const outputPath = join(caseRoot, "packet");
            await mkdir(join(outputPath, "review"), { recursive: true });
            await writeFile(
              join(outputPath, "review", "final.json"),
              JSON.stringify({
                schemaVersion: 3,
                stage: "FINAL",
                snapshotDigest: { algorithm: "SHA256", value: "a".repeat(64) },
                briefDigest: { algorithm: "SHA256", value: "b".repeat(64) },
                summary: "Selected standards are satisfied.",
                findings: [],
                preliminaryFindingDispositions: [],
                preliminaryConcernDispositions: [],
                authorClaims: [],
                authorVerificationClaims: [],
                changedPathCoverage: [
                  {
                    path: "code.ts",
                    status: "INSPECTED",
                    explanation: "Changed code was inspected.",
                  },
                ],
                canonicalInputCoverage: [
                  {
                    canonicalInputId: "input_standard",
                    status: "ASSESSED",
                    explanation: "Selected standard was assessed.",
                  },
                ],
                limitations: [],
                verdict: "READY",
                nextActions: { blockers: [], fastFollows: [] },
                ruleAssessments: [
                  {
                    ruleId: "rule_names",
                    status: "ASSESSED",
                    conflictingRuleIds: [],
                    explanation: "Naming rule is satisfied.",
                  },
                ],
                mode: "STANDARDS",
                authorContext: {
                  status: "PROVIDED",
                  digest: { algorithm: "SHA256", value: "c".repeat(64) },
                  noteCode: null,
                },
              }),
            );
            return {
              repositoryPath: join(caseRoot, "repo"),
              controlPath: join(caseRoot, "control.json"),
              outputPath,
              cliArguments: [],
            };
          },
          runCli: async () => 0,
          readRunRecord: async () => [
            { schemaVersion: 1, at, type: "RUN_COMPLETED", terminalState: "READY" },
          ],
        },
      );

      assert.equal(result.actualVerdict, "READY");
      assert.equal(result.complete, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("persists CLI failure diagnostics when no final report is delivered", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-matrix-cli-failure-"));
    const testCase = EVALUATION_CASES_V1[0];
    assert.ok(testCase);
    try {
      const result = await executeEvaluationCaseV1(
        {
          testCase,
          execution: "live",
          runRoot: root,
          configPath: "/unused/config.json",
          configId: "config_test",
          io: { stdout: () => undefined, stderr: () => undefined },
        },
        {
          prepareCase: async (_testCase, caseRoot) => {
            await mkdir(caseRoot);
            return {
              repositoryPath: join(caseRoot, "repo"),
              controlPath: join(caseRoot, "control.json"),
              outputPath: join(caseRoot, "packet"),
              cliArguments: [],
            };
          },
          runCli: async (_args, io) => {
            io?.stderr(
              `\u001b[2JProvider final attempt failed with HTTP 502. ${"x".repeat(1_000)}`,
            );
            return 1;
          },
        },
      );

      assert.equal(result.complete, false);
      assert.match(result.error?.message ?? "", /exited 1.*HTTP 502/i);
      assert.equal(result.error?.name, "ReviewIncomplete");
      assert.ok((result.error?.message.length ?? 0) <= MAX_MATRIX_ERROR_MESSAGE_LENGTH_V1);
      assert.equal((result.error?.message ?? "").includes("\u001b"), false);
      assert.match(result.error?.message ?? "", /\.\.\.$/);
      const persisted = JSON.parse(
        await readFile(join(root, testCase.id, "matrix-result.json"), "utf8"),
      );
      assert.match(persisted.error?.message ?? "", /exited 1.*HTTP 502/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("classifies an invalid final report as a bounded incomplete review", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-matrix-invalid-final-"));
    const testCase = EVALUATION_CASES_V1[0];
    assert.ok(testCase);
    try {
      const result = await executeEvaluationCaseV1(
        {
          testCase,
          execution: "live",
          runRoot: root,
          configPath: "/unused/config.json",
          configId: "config_test",
          io: { stdout: () => undefined, stderr: () => undefined },
        },
        {
          prepareCase: async (_testCase, caseRoot) => {
            const outputPath = join(caseRoot, "packet");
            await mkdir(join(outputPath, "review"), { recursive: true });
            await writeFile(join(outputPath, "review", "final.json"), "{");
            return {
              repositoryPath: join(caseRoot, "repo"),
              controlPath: join(caseRoot, "control.json"),
              outputPath,
              cliArguments: [],
            };
          },
          runCli: async (_args, io) => {
            io?.stderr("Final report validation failed.");
            return 0;
          },
        },
      );

      assert.equal(result.complete, false);
      assert.equal(result.error?.name, "ReviewIncomplete");
      assert.match(
        result.error?.message ?? "",
        /exited 0.*validation.*evaluation report case_001/i,
      );
      assert.match(result.error?.message ?? "", /stderr: Final report validation failed/i);
      const persisted = JSON.parse(
        await readFile(join(root, testCase.id, "matrix-result.json"), "utf8"),
      );
      assert.deepEqual(persisted.error, result.error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps validated reports distinct from bounded accounting failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-matrix-accounting-failure-"));
    const testCase = EVALUATION_CASES_V1[0];
    assert.ok(testCase);
    try {
      const result = await executeEvaluationCaseV1(
        {
          testCase,
          execution: "live",
          runRoot: root,
          configPath: "/unused/config.json",
          configId: "config_test",
          io: { stdout: () => undefined, stderr: () => undefined },
        },
        {
          prepareCase: async (_testCase, caseRoot) => {
            await mkdir(caseRoot);
            return {
              repositoryPath: join(caseRoot, "repo"),
              controlPath: join(caseRoot, "control.json"),
              outputPath: join(caseRoot, "packet"),
              cliArguments: [],
            };
          },
          runCli: async (_args, io) => {
            io?.stderr("Runner retained this final diagnostic.");
            return 0;
          },
          readVerdict: async () => "READY",
          readRunRecord: async () => {
            throw new Error(`Invalid run ledger ${"y".repeat(1_000)}`);
          },
        },
      );

      assert.equal(result.complete, false);
      assert.equal(result.actualVerdict, "READY");
      assert.equal(result.error?.name, "MatrixAccountingError");
      assert.match(result.error?.message ?? "", /validated verdict READY.*accounting failed/i);
      assert.match(result.error?.message ?? "", /accounting: Invalid run ledger.*\.\.\./i);
      assert.match(result.error?.message ?? "", /stderr: Runner retained this final diagnostic/i);
      assert.doesNotMatch(result.error?.message ?? "", /without a validated final report/i);
      assert.ok((result.error?.message.length ?? 0) <= MAX_MATRIX_ERROR_MESSAGE_LENGTH_V1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
