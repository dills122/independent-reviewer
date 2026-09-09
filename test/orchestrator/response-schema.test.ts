import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FINAL_REVIEW_REPORT_V1_JSON_SCHEMA,
  PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
} from "../../src/index.js";
import {
  constrainResponseSchemaV1,
  ResponseSchemaShapeError,
} from "../../src/orchestrator/response-schema.js";

const options = {
  evidencePaths: ["src/a.ts", "src/b.ts"],
  changedPaths: ["src/a.ts", "src/b.ts"],
  canonicalInputIds: ["input_plan", "input_requirement"],
  identities: { snapshotDigest: "a".repeat(64), briefDigest: "b".repeat(64) },
  authorVerificationClaims: [
    { command: "npm test", summary: "All suites pass.", exitCode: 0 },
  ] as never,
};

function nodesNamed(schema: unknown, propertyName: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (value: unknown, name?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, name);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const node = value as Record<string, unknown>;
    if (name === propertyName && node.type === "array") {
      found.push(node);
    }
    const properties = node.properties;
    if (properties && typeof properties === "object") {
      for (const [key, child] of Object.entries(properties)) {
        visit(child, key);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "properties") {
        visit(child, name);
      }
    }
  };
  visit(schema);
  return found;
}

function collectEnums(schema: unknown, propertyName: string): unknown[][] {
  const found: unknown[][] = [];
  const visit = (value: unknown, name?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, name);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const node = value as Record<string, unknown>;
    if (name === propertyName && Array.isArray(node.enum)) {
      found.push(node.enum);
    }
    const properties = node.properties;
    if (properties && typeof properties === "object") {
      for (const [key, child] of Object.entries(properties)) {
        visit(child, key);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "properties") {
        visit(child, name);
      }
    }
  };
  visit(schema);
  return found;
}

function rootProperty(schema: unknown, name: string): Record<string, unknown> {
  const properties = (schema as { properties: Record<string, unknown> }).properties;
  return properties[name] as Record<string, unknown>;
}

describe("constrainResponseSchemaV1", () => {
  it("pins identities, ledgers, and evidence paths on the final schema", () => {
    const { schema } = constrainResponseSchemaV1(FINAL_REVIEW_REPORT_V1_JSON_SCHEMA, options);

    const snapshotDigestValue = (
      rootProperty(schema, "snapshotDigest").properties as Record<string, { const?: string }>
    ).value;
    assert.equal(snapshotDigestValue?.const, options.identities.snapshotDigest);
    const changedPathCoverage = rootProperty(schema, "changedPathCoverage");
    assert.equal(changedPathCoverage.minItems, 2);
    assert.equal(changedPathCoverage.maxItems, 2);
    const pinnedEvidencePaths = collectEnums(schema, "path");
    assert.ok(pinnedEvidencePaths.length >= 2);
    for (const values of pinnedEvidencePaths) {
      assert.deepEqual(values, options.evidencePaths);
    }
  });

  it("applies named array limits instead of a blanket cap", () => {
    const { schema, appliedArrayLimits } = constrainResponseSchemaV1(
      FINAL_REVIEW_REPORT_V1_JSON_SCHEMA,
      options,
    );

    assert.equal(rootProperty(schema, "findings").maxItems, 40);
    assert.equal(rootProperty(schema, "limitations").maxItems, 12);
    assert.equal(rootProperty(schema, "preliminaryConcernDispositions").maxItems, 24);
    assert.deepEqual(
      nodesNamed(schema, "evidence").map((node) => node.maxItems),
      [8, 8],
    );
    assert.equal(appliedArrayLimits.findings, 40);
    assert.equal(appliedArrayLimits.evidence, 8);
  });

  it("keeps ledger bounds ahead of the generic array limit", () => {
    const manyPaths = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`);
    const { schema } = constrainResponseSchemaV1(FINAL_REVIEW_REPORT_V1_JSON_SCHEMA, {
      ...options,
      changedPaths: manyPaths,
      evidencePaths: manyPaths,
    });

    // The blanket cap used to run first and pin this at 12, making any review of a change with
    // more than 12 files structurally impossible.
    assert.equal(rootProperty(schema, "changedPathCoverage").maxItems, 30);
    assert.equal(rootProperty(schema, "inspectedPaths"), undefined);
  });

  it("widens author claim text past the generic prose ceiling", () => {
    const longCommand = `npm test -- ${"x".repeat(600)}`;
    const { schema } = constrainResponseSchemaV1(FINAL_REVIEW_REPORT_V1_JSON_SCHEMA, {
      ...options,
      authorVerificationClaims: [{ command: longCommand, summary: "ok", exitCode: 0 }] as never,
    });

    const claims = rootProperty(schema, "authorVerificationClaims");
    const claimProperties = (claims.items as { properties: Record<string, { maxLength?: number }> })
      .properties;
    assert.equal(claimProperties.command?.maxLength, longCommand.length);
    assert.equal(claimProperties.claimedSummary?.maxLength, 400);
  });

  it("bounds the preliminary schema and its inspected-path list", () => {
    const { schema } = constrainResponseSchemaV1(PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA, options);

    assert.equal(rootProperty(schema, "findings").maxItems, 40);
    assert.equal(rootProperty(schema, "inspectedPaths").maxItems, 2);
    assert.deepEqual(
      nodesNamed(schema, "evidence").map((node) => node.maxItems),
      [8],
    );
  });

  it("fails loudly when the schema no longer exposes the expected shape", () => {
    const withoutEvidenceVariants = structuredClone(FINAL_REVIEW_REPORT_V1_JSON_SCHEMA) as {
      properties: Record<string, unknown>;
    };
    withoutEvidenceVariants.properties.findings = { type: "array", items: { type: "string" } };

    assert.throws(
      () => constrainResponseSchemaV1(withoutEvidenceVariants, options),
      ResponseSchemaShapeError,
    );
    assert.throws(
      () => constrainResponseSchemaV1({ type: "object" }, options),
      ResponseSchemaShapeError,
    );
  });

  it("refuses an array the limit table does not name", () => {
    const withNewArray = structuredClone(FINAL_REVIEW_REPORT_V1_JSON_SCHEMA) as {
      properties: Record<string, unknown>;
    };
    withNewArray.properties.newLedger = { type: "array", items: { type: "string" } };

    assert.throws(
      () => constrainResponseSchemaV1(withNewArray, options),
      /newLedger with no configured item limit/,
    );
  });
});
