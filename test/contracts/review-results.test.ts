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
    canonicalInputCoverage: [
      {
        canonicalInputId: "input_requirement",
        status: "ASSESSED",
        explanation: "The requirement was checked against the implementation.",
      },
      {
        canonicalInputId: "input_plan",
        status: "ASSESSED",
        explanation: "The implementation plan was checked against the changed path.",
      },
    ],
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
    preliminaryConcernDispositions: [],
    authorClaims: [],
    authorVerificationClaims: [],
    changedPathCoverage: [
      {
        path: "src/example.ts",
        status: "INSPECTED",
        explanation: "The changed implementation was inspected.",
      },
    ],
    canonicalInputCoverage: [
      {
        canonicalInputId: "input_requirement",
        status: "ASSESSED",
        explanation: "The requirement is satisfied.",
      },
      {
        canonicalInputId: "input_plan",
        status: "ASSESSED",
        explanation: "The plan is implemented.",
      },
    ],
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
        evidence: [
          {
            path: "src/example.ts",
            anchor: "LINE_RANGE",
            side: "HEAD",
            startLine: 1,
            endLine: 1,
            detail: "The failure is visible here.",
          },
        ],
        correction: "Handle the failing case.",
      },
    ];

    assert.equal(FinalReviewReportV1Schema.safeParse(report).success, false);
  });

  it("requires Unable to verify to carry a limitation", () => {
    const report = { ...finalReport(), verdict: "UNABLE_TO_VERIFY" };

    assert.equal(FinalReviewReportV1Schema.safeParse(report).success, false);
  });

  it("requires at least one inspected path in a preliminary assessment", () => {
    const value = preliminary();
    value.inspectedPaths = [];

    assert.equal(PreliminaryAssessmentV1Schema.safeParse(value).success, false);
  });

  it("rejects duplicate preliminary concerns that cannot be uniquely dispositioned", () => {
    const duplicateGaps = preliminary();
    duplicateGaps.evidenceGaps = ["Tests were not observed.", "Tests were not observed."];
    assert.equal(PreliminaryAssessmentV1Schema.safeParse(duplicateGaps).success, false);

    const duplicateLimitations = preliminary();
    duplicateLimitations.limitations = [
      "Binary content is unavailable.",
      "Binary content is unavailable.",
    ];
    assert.equal(PreliminaryAssessmentV1Schema.safeParse(duplicateLimitations).success, false);
  });

  it("requires findings to carry a source-coordinate or symbol anchor", () => {
    const report = finalReport();
    report.findings = [
      {
        id: "finding_unanchored",
        severity: "P2",
        title: "Unanchored assertion",
        scenario: "The reviewer emits only a path and prose.",
        impact: "The finding cannot be located in frozen evidence.",
        evidence: [{ path: "src/example.ts", detail: "No coordinate is provided." }],
        correction: "Supply a frozen source coordinate.",
      },
    ];

    assert.equal(FinalReviewReportV1Schema.safeParse(report).success, false);
  });

  it("does not permit Ready with unassessed implementation or canonical coverage", () => {
    const uninspectedPath = finalReport();
    uninspectedPath.changedPathCoverage = [
      {
        path: "src/example.ts",
        status: "UNASSESSED",
        explanation: "The file was not inspected.",
      },
    ];
    assert.equal(FinalReviewReportV1Schema.safeParse(uninspectedPath).success, false);

    const unassessedPlan = finalReport();
    unassessedPlan.canonicalInputCoverage = [
      {
        canonicalInputId: "input_plan",
        status: "UNASSESSED",
        explanation: "The plan was not assessed.",
      },
    ];
    assert.equal(FinalReviewReportV1Schema.safeParse(unassessedPlan).success, false);
  });

  it("does not promote author-reported verification to runner-confirmed evidence", () => {
    const report = finalReport();
    report.authorVerificationClaims = [
      {
        claimIndex: 0,
        command: "npm test",
        claimedOutcome: "PASSED",
        claimedSummary: "Reported by the author.",
        status: "CONFIRMED",
        explanation: "No independent runner evidence exists.",
      },
    ];

    assert.equal(FinalReviewReportV1Schema.safeParse(report).success, false);
  });

  it("requires final-only findings to explain why they emerged after the blind stage", () => {
    const finding = {
      id: "finding_late",
      severity: "P2",
      title: "Late finding",
      scenario: "Author testimony exposes an additional concern.",
      impact: "The concern needs explicit reconciliation provenance.",
      evidence: [
        {
          path: "src/example.ts",
          anchor: "LINE_RANGE",
          side: "HEAD",
          startLine: 1,
          endLine: 1,
          detail: "The relevant implementation is visible here.",
        },
      ],
      correction: "Record why the finding emerged after the blind assessment.",
      origin: "FINAL_ONLY",
      emergenceRationale: "The author packet identified a previously unknown invariant.",
    };
    const valid = {
      ...finalReport(),
      findings: [finding],
      verdict: "NOT_READY",
      nextActions: { blockers: ["Resolve the late finding."], fastFollows: [] },
    };
    assert.equal(FinalReviewReportV1Schema.safeParse(valid).success, true);

    const missingRationale = structuredClone(valid);
    (missingRationale.findings[0] as Record<string, unknown>).emergenceRationale = null;
    assert.equal(FinalReviewReportV1Schema.safeParse(missingRationale).success, false);
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
