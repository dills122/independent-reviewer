import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  FINAL_REVIEW_REPORT_V1_JSON_SCHEMA,
  FinalReviewReportV1Schema,
  PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA,
  PreliminaryAssessmentV1Schema,
} from "../../src/index.js";

const digest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

function preliminary(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    stage: "PRELIMINARY",
    snapshotDigest: digest,
    briefDigest: digest,
    summary: "The change is small and understandable.",
    inspectedPaths: ["src/example.ts"],
    findings: [],
    evidenceGaps: [],
    limitations: [],
    nextAction: "REQUEST_AUTHOR_PACKET",
  };
}

function finalReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    stage: "FINAL",
    snapshotDigest: digest,
    briefDigest: digest,
    summary: "The implementation meets the stated requirement.",
    findings: [],
    preliminaryFindingDispositions: [],
    authorClaims: [],
    limitations: [],
    verdict: "READY",
    nextActions: { blockers: [], fastFollows: [] },
  };
}

describe("review result contracts", () => {
  it("requires the preliminary stage to request the separately held author packet", () => {
    assert.equal(PreliminaryAssessmentV1Schema.safeParse(preliminary()).success, true);
    assert.equal(
      PreliminaryAssessmentV1Schema.safeParse({
        ...preliminary(),
        nextAction: "CONTINUE",
      }).success,
      false,
    );
  });

  it("does not permit a blocking finding to report Ready", () => {
    const report = finalReport();
    report.findings = [
      {
        id: "finding_blocker",
        severity: "P1",
        title: "Broken behavior",
        scenario: "The changed path is exercised.",
        impact: "The command fails.",
        evidence: [{ path: "src/example.ts", detail: "The failure is visible here." }],
        correction: "Handle the failing case.",
      },
    ];

    assert.equal(FinalReviewReportV1Schema.safeParse(report).success, false);
  });

  it("requires Unable to verify to carry a limitation", () => {
    const report = { ...finalReport(), verdict: "UNABLE_TO_VERIFY" };

    assert.equal(FinalReviewReportV1Schema.safeParse(report).success, false);
  });

  it("matches the committed provider-output schemas", async () => {
    const preliminarySchema = JSON.parse(
      await readFile(resolve("schemas", "preliminary-assessment-v1.schema.json"), "utf8"),
    );
    const finalSchema = JSON.parse(
      await readFile(resolve("schemas", "final-review-report-v1.schema.json"), "utf8"),
    );

    assert.deepEqual(preliminarySchema, PRELIMINARY_ASSESSMENT_V1_JSON_SCHEMA);
    assert.deepEqual(finalSchema, FINAL_REVIEW_REPORT_V1_JSON_SCHEMA);
  });
});
