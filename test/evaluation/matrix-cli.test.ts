import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseEvaluationMatrixCommandV1 } from "../../evaluation/matrix-cli.js";

describe("evaluation matrix command", () => {
  it("keeps execution mode separate from suite selection", () => {
    assert.deepEqual(parseEvaluationMatrixCommandV1(["dry", "--run-label", "candidate-42"]), {
      command: "dry",
      selection: { execution: "dry" },
      runLabel: "candidate-42",
      configPath: undefined,
      confirmPaid: false,
      maxTotalCostUsd: undefined,
    });
    assert.deepEqual(
      parseEvaluationMatrixCommandV1([
        "live",
        "--suite",
        "standard",
        "--run-label",
        "candidate-42-live",
        "--confirm-paid",
        "--max-total-cost-usd",
        "0.16",
      ]),
      {
        command: "live",
        selection: { execution: "live", suite: "standard" },
        runLabel: "candidate-42-live",
        configPath: undefined,
        confirmPaid: true,
        maxTotalCostUsd: 0.16,
      },
    );
  });

  it("accepts repeated group or exact-case selectors", () => {
    assert.deepEqual(
      parseEvaluationMatrixCommandV1([
        "dry",
        "--group",
        "requirements",
        "--group",
        "multilingual",
        "--run-label",
        "groups",
      ]).selection,
      { execution: "dry", groups: ["requirements", "multilingual"] },
    );
    assert.deepEqual(
      parseEvaluationMatrixCommandV1([
        "dry",
        "--case",
        "case_020",
        "--case",
        "case_001",
        "--run-label",
        "cases",
      ]).selection,
      { execution: "dry", cases: ["case_020", "case_001"] },
    );
  });

  it("requires a safe run label for execution but not listing", () => {
    assert.deepEqual(parseEvaluationMatrixCommandV1(["list"]), {
      command: "list",
      selection: {},
      runLabel: undefined,
      configPath: undefined,
      confirmPaid: false,
      maxTotalCostUsd: undefined,
    });
    assert.throws(() => parseEvaluationMatrixCommandV1(["dry"]), /--run-label/i);
    assert.throws(
      () => parseEvaluationMatrixCommandV1(["dry", "--run-label", "../escape"]),
      /safe lowercase label/i,
    );
    assert.throws(
      () => parseEvaluationMatrixCommandV1(["list", "--run-label", "unused"]),
      /list does not accept/i,
    );
  });

  it("rejects paid-only flags on provider-free commands and malformed costs", () => {
    assert.throws(
      () => parseEvaluationMatrixCommandV1(["dry", "--run-label", "dry", "--confirm-paid"]),
      /live only/i,
    );
    assert.throws(
      () =>
        parseEvaluationMatrixCommandV1([
          "live",
          "--suite",
          "smoke",
          "--run-label",
          "live",
          "--confirm-paid",
          "--max-total-cost-usd",
          "nope",
        ]),
      /positive number/i,
    );
    assert.throws(
      () =>
        parseEvaluationMatrixCommandV1([
          "dry",
          "--suite",
          "smoke",
          "--suite",
          "full",
          "--run-label",
          "dry",
        ]),
      /--suite may be supplied once/i,
    );
  });
});
