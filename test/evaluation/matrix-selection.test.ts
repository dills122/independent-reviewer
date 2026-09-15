import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EVALUATION_CASES_V1,
  selectEvaluationCasesV1,
  validatePaidMatrixAdmissionV1,
} from "../../evaluation/matrix-selection.js";

const ids = (cases: readonly { id: string }[]): string[] => cases.map(({ id }) => id);

describe("evaluation matrix selection", () => {
  it("keeps the 30-case corpus and stable bounded suites explicit", () => {
    assert.equal(EVALUATION_CASES_V1.length, 30);
    assert.equal(new Set(ids(EVALUATION_CASES_V1)).size, 30);
    assert.ok(EVALUATION_CASES_V1.every(({ id }) => /^case_\d{3}$/.test(id)));

    assert.deepEqual(ids(selectEvaluationCasesV1({ suite: "smoke" })), [
      "case_001",
      "case_002",
      "case_006",
      "case_012",
    ]);
    assert.deepEqual(ids(selectEvaluationCasesV1({ suite: "standard" })), [
      "case_001",
      "case_002",
      "case_003",
      "case_005",
      "case_006",
      "case_008",
      "case_010",
      "case_012",
    ]);
    assert.deepEqual(ids(selectEvaluationCasesV1({ suite: "full" })), ids(EVALUATION_CASES_V1));
  });

  it("defaults provider-free runs to standard but requires an explicit live selector", () => {
    assert.deepEqual(
      ids(selectEvaluationCasesV1({ execution: "dry" })),
      ids(selectEvaluationCasesV1({ suite: "standard" })),
    );
    assert.throws(
      () => selectEvaluationCasesV1({ execution: "live" }),
      /live runs require an explicit suite, group, or case selector/i,
    );
  });

  it("selects stable unions by group and exact case", () => {
    assert.equal(selectEvaluationCasesV1({ groups: ["requirements"] }).length, 19);
    assert.equal(selectEvaluationCasesV1({ groups: ["standards"] }).length, 11);
    assert.equal(selectEvaluationCasesV1({ groups: ["multilingual"] }).length, 6);
    assert.deepEqual(ids(selectEvaluationCasesV1({ cases: ["case_020", "case_001"] })), [
      "case_001",
      "case_020",
    ]);
  });

  it("rejects ambiguous, duplicate, unknown, and empty selections", () => {
    assert.throws(
      () => selectEvaluationCasesV1({ suite: "smoke", groups: ["requirements"] }),
      /choose only one selector kind/i,
    );
    assert.throws(
      () => selectEvaluationCasesV1({ cases: ["case_001", "case_001"] }),
      /duplicate case selector/i,
    );
    assert.throws(() => selectEvaluationCasesV1({ cases: ["case_999"] }), /unknown case/i);
    assert.throws(() => selectEvaluationCasesV1({ groups: ["unknown"] }), /unknown group/i);
    assert.throws(() => selectEvaluationCasesV1({ groups: [] }), /selection is empty/i);
  });
});

describe("paid matrix admission", () => {
  it("requires confirmation and an aggregate ceiling covering every selected case", () => {
    const selected = selectEvaluationCasesV1({ suite: "standard" });

    assert.throws(
      () =>
        validatePaidMatrixAdmissionV1({
          selected,
          perCaseMaxCostUsd: 0.02,
          confirmed: false,
          operatorMaxTotalCostUsd: 0.16,
        }),
      /--confirm-paid/i,
    );
    assert.throws(
      () =>
        validatePaidMatrixAdmissionV1({
          selected,
          perCaseMaxCostUsd: 0.02,
          confirmed: true,
          operatorMaxTotalCostUsd: 0.159,
        }),
      /below.*\$0\.160000/i,
    );

    assert.deepEqual(
      validatePaidMatrixAdmissionV1({
        selected,
        perCaseMaxCostUsd: 0.02,
        confirmed: true,
        operatorMaxTotalCostUsd: 0.16,
      }),
      { selectedCaseCount: 8, admittedMaxTotalCostUsd: 0.16 },
    );
  });

  it("does not round a tiny aggregate reservation down during admission", () => {
    const selected = selectEvaluationCasesV1({ cases: ["case_001", "case_002"] });
    assert.throws(
      () =>
        validatePaidMatrixAdmissionV1({
          selected,
          perCaseMaxCostUsd: 0.0000001,
          confirmed: true,
          operatorMaxTotalCostUsd: 0.0000001,
        }),
      /below/i,
    );
  });
});
