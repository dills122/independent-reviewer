import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA,
  FINAL_REVIEW_CANDIDATE_V3_JSON_SCHEMA,
  PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
} from "../../src/index.js";
import {
  constrainResponseSchemaV1,
  constrainFinalConcernScopeV1,
  constrainRepairReferencesV1,
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
  it("pins repair concern indices and counts without mutating the first-final schema", () => {
    const final = constrainResponseSchemaV1(FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA, options);
    const original = JSON.stringify(final);
    const concern = `non-owner ${"x".repeat(401)}`;
    const repair = constrainRepairReferencesV1(final, {
      findings: [],
      evidenceGaps: [concern],
      limitations: [concern],
    });
    assert.equal(JSON.stringify(final), original);
    assert.equal(rootProperty(repair.schema, "preliminaryFindingDispositions").maxItems, 0);
    assert.equal(rootProperty(repair.schema, "preliminaryConcernDispositions").maxItems, 2);
    assert.deepEqual(collectEnums(repair.schema, "concernIndex"), [[0]]);
    assert.deepEqual(collectEnums(repair.schema, "kind"), [["EVIDENCE_GAP", "LIMITATION"]]);
    assert.doesNotMatch(JSON.stringify(repair.schema), /non-owner/);
  });

  it("requests author claim indices without copied text", () => {
    const claims = [
      {
        command: "node access-check.mjs",
        outcome: "PASSED" as const,
        summary: "non-owner checks passed",
      },
      { command: "node second.mjs", outcome: "FAILED" as const, summary: "second check failed" },
    ];
    const input = { ...options, authorVerificationClaims: claims };
    const { schema } = constrainResponseSchemaV1(FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA, input);
    assert.deepEqual(collectEnums(schema, "claimIndex"), [[0, 1]]);
    assert.doesNotMatch(JSON.stringify(schema), /claimedSummary|claimedOutcome|access-check/);
    const blind = constrainResponseSchemaV1(PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA, input);
    assert.doesNotMatch(JSON.stringify(blind.schema), /non-owner|access-check/);
  });

  it("pins identities, ledgers, and evidence paths on the final schema", () => {
    const { schema } = constrainResponseSchemaV1(FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA, options);

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

  it("does not require runner-owned ledgers in the final candidate schema", () => {
    const { schema } = constrainResponseSchemaV1(FINAL_REVIEW_CANDIDATE_V3_JSON_SCHEMA, options);
    assert.equal(rootProperty(schema, "changedPathCoverage"), undefined);
    assert.equal(rootProperty(schema, "canonicalInputCoverage"), undefined);
  });

  it("applies named array limits instead of a blanket cap", () => {
    const { schema, appliedArrayLimits } = constrainResponseSchemaV1(
      FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA,
      options,
    );

    assert.equal(rootProperty(schema, "findings").maxItems, 40);
    assert.equal(rootProperty(schema, "limitations").maxItems, 12);
    assert.equal(rootProperty(schema, "preliminaryConcernDispositions").maxItems, 36);
    assert.deepEqual(
      nodesNamed(schema, "evidence").map((node) => node.maxItems),
      [8, 8],
    );
    assert.equal(appliedArrayLimits.findings, 40);
    assert.equal(appliedArrayLimits.evidence, 8);
  });

  it("keeps ledger bounds ahead of the generic array limit", () => {
    const manyPaths = Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`);
    const { schema } = constrainResponseSchemaV1(FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA, {
      ...options,
      changedPaths: manyPaths,
      evidencePaths: manyPaths,
    });

    // The blanket cap used to run first and pin this at 12, making any review of a change with
    // more than 12 files structurally impossible.
    assert.equal(rootProperty(schema, "changedPathCoverage").maxItems, 30);
    assert.equal(rootProperty(schema, "inspectedPaths"), undefined);
  });

  it("does not ask the model to reproduce long source strings", () => {
    const longCommand = `npm test -- ${"x".repeat(600)}`;
    const { schema } = constrainResponseSchemaV1(FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA, {
      ...options,
      authorVerificationClaims: [{ command: longCommand, summary: "ok", outcome: "PASSED" }],
    });

    const claims = rootProperty(schema, "authorVerificationClaims");
    const claimProperties = (claims.items as { properties: Record<string, { maxLength?: number }> })
      .properties;
    assert.equal(claimProperties.command, undefined);
    assert.equal(claimProperties.claimedSummary, undefined);
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
    const withoutEvidenceVariants = structuredClone(FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA) as {
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
    const withNewArray = structuredClone(FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA) as {
      properties: Record<string, unknown>;
    };
    withNewArray.properties.newLedger = { type: "array", items: { type: "string" } };

    assert.throws(
      () => constrainResponseSchemaV1(withNewArray, options),
      /newLedger with no configured item limit/,
    );
  });
});

it("requires every preliminary concern on the first final call within the admitted schema size", () => {
  const final = constrainResponseSchemaV1(FINAL_REVIEW_CANDIDATE_V1_JSON_SCHEMA, options);
  const original = JSON.stringify(final.schema);
  for (const [gaps, limits] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [2, 3],
    [24, 12],
  ] as const) {
    const scoped = constrainFinalConcernScopeV1(final, {
      evidenceGaps: Array(gaps).fill("gap"),
      limitations: Array(limits).fill("limitation"),
    });
    const concerns = rootProperty(scoped.schema, "preliminaryConcernDispositions");
    assert.equal(concerns.minItems, gaps + limits);
    assert.equal(concerns.maxItems, gaps + limits);
    const properties = (concerns.items as { properties: Record<string, Record<string, unknown>> })
      .properties;
    assert.equal(properties.concernIndex?.maximum, Math.max(0, gaps - 1, limits - 1));
    assert.ok(Buffer.byteLength(JSON.stringify(scoped.schema)) <= Buffer.byteLength(original));
    assert.equal(JSON.stringify(final.schema), original);
  }
});
