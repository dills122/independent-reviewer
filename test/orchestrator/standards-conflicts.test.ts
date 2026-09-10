import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewBrief } from "../../src/contracts/neutral-review-brief.js";
import type { ReviewReport } from "../../src/contracts/standards-results.js";
import { assertStandardsRuleCoverage } from "../../src/orchestrator/standards-policy.js";

// Isolate the cross-artifact guard; full schema and CLI composition are tested in standards-flow.
const brief = {
  schemaVersion: 2,
  canonicalInputs: {
    standards: [
      {
        id: "input_rules",
        content: JSON.stringify({
          schemaVersion: 1,
          name: "Naming",
          source: "Project",
          rules: ["rule_names", "rule_fixed"].map((id) => ({
            id,
            text: id,
            enforcement: "REQUIRED",
            paths: ["**/*.ts"],
            exceptions: null,
          })),
        }),
      },
    ],
  },
} as unknown as ReviewBrief;
const report = {
  schemaVersion: 2,
  stage: "FINAL",
  verdict: "UNABLE_TO_VERIFY",
  findings: [],
  limitations: ["Naming rules conflict."],
  ruleAssessments: [
    {
      ruleId: "rule_names",
      status: "CONFLICT",
      conflictingRuleIds: ["rule_fixed"],
      explanation: "Cannot satisfy both names.",
    },
    {
      ruleId: "rule_fixed",
      status: "CONFLICT",
      conflictingRuleIds: ["rule_names"],
      explanation: "Cannot satisfy both names.",
    },
  ],
} as unknown as ReviewReport;

test("conflicting standards require complete reciprocal coverage and cannot support a code violation", () => {
  assert.doesNotThrow(() => assertStandardsRuleCoverage(report, brief));
  if (report.schemaVersion !== 2) throw new Error("Fixture mode");
  for (const ruleAssessments of [
    report.ruleAssessments.slice(0, 1),
    [report.ruleAssessments[0], report.ruleAssessments[0]],
    [report.ruleAssessments[0], { ...report.ruleAssessments[1], conflictingRuleIds: [] }],
    [report.ruleAssessments[0], { ...report.ruleAssessments[1], ruleId: "rule_unknown" }],
  ]) {
    assert.throws(() =>
      assertStandardsRuleCoverage({ ...report, ruleAssessments } as ReviewReport, brief),
    );
  }
  assert.throws(
    () => assertStandardsRuleCoverage({ ...report, verdict: "READY" }, brief),
    /UNABLE_TO_VERIFY/,
  );
  assert.throws(
    () =>
      assertStandardsRuleCoverage(
        { ...report, findings: [{ ruleIds: ["rule_names"] }] } as ReviewReport,
        brief,
      ),
    /cannot support a code violation/,
  );
});

test("missing evidence cannot become a standards violation or a passing assessment", () => {
  const uncertain = {
    ...report,
    ruleAssessments: ["rule_names", "rule_fixed"].map((ruleId) => ({
      ruleId,
      status: "UNASSESSED",
      conflictingRuleIds: [],
      explanation: "API_NAMES.md was not captured.",
    })),
  } as unknown as ReviewReport;
  assert.doesNotThrow(() => assertStandardsRuleCoverage(uncertain, brief));
  assert.throws(
    () =>
      assertStandardsRuleCoverage(
        { ...uncertain, findings: [{ ruleIds: ["rule_names"] }] } as ReviewReport,
        brief,
      ),
    /Unassessed/,
  );
  assert.throws(
    () => assertStandardsRuleCoverage({ ...uncertain, verdict: "READY" }, brief),
    /UNABLE_TO_VERIFY/,
  );
  assert.throws(
    () => assertStandardsRuleCoverage({ ...uncertain, limitations: [] }, brief),
    /limitations/,
  );
});
