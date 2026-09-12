import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewBrief } from "../../src/contracts/neutral-review-brief.js";
import {
  PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
  STANDARDS_CANDIDATE_V3_JSON_SCHEMA,
  STANDARDS_PRELIMINARY_V2_JSON_SCHEMA,
} from "../../src/index.js";
import {
  constrainResponseSchemaV1,
  ResponseSchemaShapeError,
} from "../../src/orchestrator/response-schema.js";
import {
  applyRunnerOwnedStandardsSeverityV1,
  assertStandardsFindings,
  deriveStandardsFindingSeverityV1,
} from "../../src/orchestrator/standards-policy.js";

// Isolates runner-owned enforcement; full CLI composition is covered in standards-flow.
function briefWith(
  rules: Array<{ id: string; enforcement: "REQUIRED" | "RECOMMENDED"; paths?: string[] }>,
): ReviewBrief {
  return {
    schemaVersion: 2,
    canonicalInputs: {
      standards: [
        {
          id: "input_rules",
          content: JSON.stringify({
            schemaVersion: 1,
            name: "Rules",
            source: "Project",
            rules: rules.map((rule) => ({
              id: rule.id,
              text: rule.id,
              enforcement: rule.enforcement,
              paths: rule.paths ?? ["**/*.ts"],
              exceptions: null,
            })),
          }),
        },
      ],
    },
  } as unknown as ReviewBrief;
}

const brief = briefWith([
  { id: "rule_mandatory", enforcement: "REQUIRED" },
  { id: "rule_advisory", enforcement: "RECOMMENDED" },
]);

function finding(ruleIds: string[], severity?: string) {
  return {
    id: "finding_1",
    title: "Name is unclear.",
    problem: "The exported name does not describe what it returns.",
    impact: "A reader must open the body to learn the contract.",
    correction: "Rename it.",
    ruleIds,
    ...(severity === undefined ? {} : { severity }),
    evidence: [{ kind: "SYMBOL", path: "src/a.ts", side: "HEAD", symbol: "thing" }],
  };
}

const standardsOptions = {
  evidencePaths: ["src/a.ts"],
  changedPaths: ["src/a.ts"],
  canonicalInputIds: ["input_rules"],
  identities: { snapshotDigest: "a".repeat(64), briefDigest: "b".repeat(64) },
  authorVerificationClaims: [] as never,
  ruleIds: ["rule_mandatory", "rule_advisory"],
};

describe("deriveStandardsFindingSeverityV1", () => {
  const rules = new Map([
    ["rule_mandatory", { enforcement: "REQUIRED" as const }],
    ["rule_advisory", { enforcement: "RECOMMENDED" as const }],
  ]);

  it("takes REQUIRED when any cited rule is mandatory", () => {
    assert.equal(deriveStandardsFindingSeverityV1(["rule_mandatory"], rules), "REQUIRED");
    assert.equal(
      deriveStandardsFindingSeverityV1(["rule_advisory", "rule_mandatory"], rules),
      "REQUIRED",
    );
  });

  it("takes RECOMMENDED only when every cited rule is advisory", () => {
    assert.equal(deriveStandardsFindingSeverityV1(["rule_advisory"], rules), "RECOMMENDED");
  });

  it("derives nothing from an unknown or empty rule set, leaving validation to report it", () => {
    assert.equal(deriveStandardsFindingSeverityV1(["rule_missing"], rules), undefined);
    assert.equal(
      deriveStandardsFindingSeverityV1(["rule_advisory", "rule_missing"], rules),
      undefined,
    );
    assert.equal(deriveStandardsFindingSeverityV1([], rules), undefined);
  });
});

describe("applyRunnerOwnedStandardsSeverityV1", () => {
  it("overrides a provider severity that contradicts the cited rules", () => {
    // Regression for #79: this exact disagreement previously failed the run after two paid calls.
    const applied = applyRunnerOwnedStandardsSeverityV1(
      { findings: [finding(["rule_mandatory"], "RECOMMENDED")] },
      brief,
    ) as { findings: Array<{ severity: string }> };
    assert.equal(applied.findings[0]?.severity, "REQUIRED");
  });

  it("cannot be used to escalate an advisory rule either", () => {
    const applied = applyRunnerOwnedStandardsSeverityV1(
      { findings: [finding(["rule_advisory"], "REQUIRED")] },
      brief,
    ) as { findings: Array<{ severity: string }> };
    assert.equal(applied.findings[0]?.severity, "RECOMMENDED");
  });

  it("fills severity the provider never supplied and is idempotent", () => {
    const once = applyRunnerOwnedStandardsSeverityV1(
      { findings: [finding(["rule_mandatory"])] },
      brief,
    );
    const twice = applyRunnerOwnedStandardsSeverityV1(once, brief);
    assert.equal(
      (once as { findings: Array<{ severity: string }> }).findings[0]?.severity,
      "REQUIRED",
    );
    assert.deepEqual(twice, once);
  });

  it("preserves every other field and does not mutate the raw response", () => {
    const raw = { schemaVersion: 2, stage: "PRELIMINARY", findings: [finding(["rule_mandatory"])] };
    const applied = applyRunnerOwnedStandardsSeverityV1(raw, brief) as Record<string, unknown>;
    assert.equal(applied.stage, "PRELIMINARY");
    assert.equal(applied.schemaVersion, 2);
    assert.equal(
      raw.findings.every((entry) => !("severity" in entry)),
      true,
    );
  });

  it("leaves an unresolvable rule reference untouched so reference validation reports it", () => {
    const applied = applyRunnerOwnedStandardsSeverityV1(
      { findings: [finding(["rule_missing"], "REQUIRED")] },
      brief,
    ) as { findings: Array<{ severity: string }> };
    assert.equal(applied.findings[0]?.severity, "REQUIRED");
    assert.throws(
      () => assertStandardsFindings(applied.findings as never, brief),
      /Unknown standard rule: rule_missing/,
    );
  });

  it("leaves requirements-mode responses and non-object shapes alone", () => {
    const requirementsBrief = { schemaVersion: 1 } as unknown as ReviewBrief;
    const raw = { findings: [finding(["rule_mandatory"], "P2")] };
    assert.deepEqual(applyRunnerOwnedStandardsSeverityV1(raw, requirementsBrief), raw);
    assert.equal(applyRunnerOwnedStandardsSeverityV1(null, brief), null);
    assert.equal(applyRunnerOwnedStandardsSeverityV1("text", brief), "text");
    assert.deepEqual(applyRunnerOwnedStandardsSeverityV1({ findings: "none" }, brief), {
      findings: "none",
    });
  });

  it("still leaves the enforcement guard able to reject a hand-edited assessment", () => {
    // The applier is what keeps a live run from reaching this; the guard remains the backstop for
    // a persisted preliminary someone edited before a resume.
    assert.throws(
      () => assertStandardsFindings([finding(["rule_mandatory"], "RECOMMENDED")] as never, brief),
      /Finding enforcement does not match its selected rules/,
    );
  });

  it("produces findings that satisfy the enforcement guard it replaced", () => {
    for (const ruleIds of [
      ["rule_mandatory"],
      ["rule_advisory"],
      ["rule_advisory", "rule_mandatory"],
    ]) {
      const applied = applyRunnerOwnedStandardsSeverityV1(
        { findings: [finding(ruleIds, "RECOMMENDED")] },
        brief,
      ) as { findings: unknown[] };
      assert.doesNotThrow(() => assertStandardsFindings(applied.findings as never, brief));
    }
  });
});

describe("constrainResponseSchemaV1 runner-owned severity", () => {
  for (const [name, schema] of [
    ["standards preliminary v2", STANDARDS_PRELIMINARY_V2_JSON_SCHEMA],
    ["standards candidate v3", STANDARDS_CANDIDATE_V3_JSON_SCHEMA],
  ] as const) {
    it(`removes finding severity from the ${name} request schema`, () => {
      const published = schema as unknown as {
        properties: { findings: { items: { properties: Record<string, unknown> } } };
      };
      assert.equal("severity" in published.properties.findings.items.properties, true);

      const { schema: constrained } = constrainResponseSchemaV1(schema, standardsOptions);
      const findings = (constrained as { properties: { findings: { items: unknown } } }).properties
        .findings.items as { properties: Record<string, unknown>; required: string[] };
      assert.equal("severity" in findings.properties, false);
      assert.equal(findings.required.includes("severity"), false);
      // Everything the provider still owns survives the removal.
      assert.equal("ruleIds" in findings.properties, true);
      assert.equal("problem" in findings.properties, true);
    });
  }

  it("keeps model-authored severity in requirements mode", () => {
    const { schema: constrained } = constrainResponseSchemaV1(
      PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
      {
        evidencePaths: ["src/a.ts"],
        changedPaths: ["src/a.ts"],
        canonicalInputIds: ["input_plan", "input_requirement"],
        identities: { snapshotDigest: "a".repeat(64), briefDigest: "b".repeat(64) },
        authorVerificationClaims: [] as never,
      },
    );
    const findings = (constrained as { properties: { findings: { items: unknown } } }).properties
      .findings.items as { properties: Record<string, unknown> };
    assert.equal("severity" in findings.properties, true);
  });

  it("refuses a standards schema whose findings expose no severity to take over", () => {
    const withoutSeverity = structuredClone(STANDARDS_PRELIMINARY_V2_JSON_SCHEMA) as unknown as {
      properties: { findings: { items: { properties: Record<string, unknown> } } };
    };
    delete withoutSeverity.properties.findings.items.properties.severity;
    assert.throws(
      () => constrainResponseSchemaV1(withoutSeverity, standardsOptions),
      ResponseSchemaShapeError,
    );
  });
});
