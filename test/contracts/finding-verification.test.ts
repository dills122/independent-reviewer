import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  assembleFindingVerificationV1,
  assembleFindingVerificationV2,
  assembleFindingVerificationV3,
  assertFindingVerificationScopeV1,
  assertFindingVerificationScopeV2,
  assertFindingVerificationScopeV3,
  FINDING_VERIFICATION_CANDIDATE_V1_JSON_SCHEMA,
  FINDING_VERIFICATION_CANDIDATE_V2_JSON_SCHEMA,
  FINDING_VERIFICATION_CANDIDATE_V3_JSON_SCHEMA,
  FindingVerificationCandidateV1Schema,
  FindingVerificationCandidateV2Schema,
  FindingVerificationCandidateV3Schema,
  FINDING_VERIFICATION_V1_JSON_SCHEMA,
  FINDING_VERIFICATION_V2_JSON_SCHEMA,
  FINDING_VERIFICATION_V3_JSON_SCHEMA,
  FindingVerificationV1Schema,
} from "../../src/contracts/finding-verification.js";

const digest = { algorithm: "SHA256" as const, value: "a".repeat(64) };

function verification() {
  return {
    schemaVersion: 1 as const,
    stage: "FINDING_VERIFICATION" as const,
    snapshotDigest: digest,
    briefDigest: digest,
    assessments: [
      {
        preliminaryFindingId: "finding_boundary",
        status: "REJECTED" as const,
        rationale:
          "The scenario uses page zero even though the canonical input defines positive page numbers as the valid domain.",
      },
    ],
  };
}

describe("finding verification contract", () => {
  it("binds provider judgments to frozen finding IDs without asking provider to repeat IDs", () => {
    const candidate = FindingVerificationCandidateV1Schema.parse({
      schemaVersion: 1,
      stage: "FINDING_VERIFICATION",
      snapshotDigest: digest,
      briefDigest: digest,
      assessments: [
        { status: "CONFIRMED", rationale: "First finding is supported." },
        { status: "REJECTED", rationale: "Second finding is outside the valid domain." },
      ],
    });

    const assembled = assembleFindingVerificationV1(candidate, ["finding_first", "finding_second"]);

    assert.deepEqual(
      assembled.assessments.map(({ preliminaryFindingId, status }) => ({
        preliminaryFindingId,
        status,
      })),
      [
        { preliminaryFindingId: "finding_first", status: "CONFIRMED" },
        { preliminaryFindingId: "finding_second", status: "REJECTED" },
      ],
    );
    assert.doesNotMatch(JSON.stringify(candidate), /preliminaryFindingId/);
    assert.throws(
      () => assembleFindingVerificationV1(candidate, ["finding_first"]),
      /exactly one judgment/i,
    );
  });

  it("accepts one bounded assessment for every preliminary finding", () => {
    const parsed = FindingVerificationV1Schema.parse(verification());
    assert.doesNotThrow(() => assertFindingVerificationScopeV1(parsed, ["finding_boundary"]));
  });

  it("uses violation-specific V2 judgments and rejects the ambiguous V1 labels", () => {
    const candidate = FindingVerificationCandidateV2Schema.parse({
      schemaVersion: 2,
      stage: "FINDING_VERIFICATION",
      snapshotDigest: digest,
      briefDigest: digest,
      assessments: [
        {
          status: "VIOLATION_DEMONSTRATED",
          rationale: "Changed evidence demonstrates the requirement violation.",
        },
        {
          status: "NO_VIOLATION",
          rationale: "The changed behavior complies with the selected rule.",
        },
      ],
    });

    const assembled = assembleFindingVerificationV2(candidate, [
      "finding_supported",
      "finding_compliant",
    ]);

    assert.deepEqual(
      assembled.assessments.map(({ preliminaryFindingId, status }) => ({
        preliminaryFindingId,
        status,
      })),
      [
        { preliminaryFindingId: "finding_supported", status: "VIOLATION_DEMONSTRATED" },
        { preliminaryFindingId: "finding_compliant", status: "NO_VIOLATION" },
      ],
    );
    assert.doesNotThrow(() =>
      assertFindingVerificationScopeV2(assembled, ["finding_supported", "finding_compliant"]),
    );
    assert.throws(
      () => assertFindingVerificationScopeV2(assembled, ["finding_supported"]),
      /exactly once/i,
    );
    assert.throws(() =>
      FindingVerificationCandidateV2Schema.parse({
        ...candidate,
        assessments: [{ status: "CONFIRMED", rationale: "The code complies." }],
      }),
    );
  });

  it("binds V3 judgments to findings and preliminary concerns without provider-owned identities", () => {
    const candidate = FindingVerificationCandidateV3Schema.parse({
      schemaVersion: 3,
      stage: "FINDING_VERIFICATION",
      snapshotDigest: digest,
      briefDigest: digest,
      assessments: [
        {
          status: "NO_VIOLATION",
          rationale: "The scenario is outside the stated valid input domain.",
        },
      ],
      concernAssessments: [
        {
          status: "NO_BLOCKING_UNCERTAINTY",
          rationale: "Out-of-domain behavior is not required evidence.",
        },
        {
          status: "BLOCKING_UNCERTAINTY_DEMONSTRATED",
          rationale: "The required dependency contract is unavailable.",
        },
      ],
    });
    const concerns = [
      { kind: "EVIDENCE_GAP" as const, concernIndex: 0 },
      { kind: "LIMITATION" as const, concernIndex: 0 },
    ];

    const assembled = assembleFindingVerificationV3(candidate, ["finding_domain"], concerns);

    assert.deepEqual(assembled.assessments[0], {
      preliminaryFindingId: "finding_domain",
      status: "NO_VIOLATION",
      rationale: "The scenario is outside the stated valid input domain.",
    });
    assert.deepEqual(
      assembled.concernAssessments.map(({ kind, concernIndex, status }) => ({
        kind,
        concernIndex,
        status,
      })),
      [
        { kind: "EVIDENCE_GAP", concernIndex: 0, status: "NO_BLOCKING_UNCERTAINTY" },
        {
          kind: "LIMITATION",
          concernIndex: 0,
          status: "BLOCKING_UNCERTAINTY_DEMONSTRATED",
        },
      ],
    );
    assert.doesNotMatch(JSON.stringify(candidate), /preliminaryFindingId|concernIndex/);
    assert.doesNotThrow(() =>
      assertFindingVerificationScopeV3(assembled, ["finding_domain"], concerns),
    );
    assert.throws(
      () => assertFindingVerificationScopeV3(assembled, ["finding_domain"], concerns.slice(0, 1)),
      /every preliminary concern exactly once/i,
    );
    assert.throws(
      () => assembleFindingVerificationV3(candidate, ["finding_domain"], concerns.slice(0, 1)),
      /one judgment per frozen concern/i,
    );
  });

  it("rejects duplicate, missing, and unknown preliminary finding IDs", () => {
    const duplicate = {
      ...verification(),
      assessments: [
        ...verification().assessments,
        { ...verification().assessments[0], status: "CONFIRMED" as const },
      ],
    };
    assert.throws(() => FindingVerificationV1Schema.parse(duplicate), /unique/i);
    assert.throws(() => assertFindingVerificationScopeV1(verification(), []), /exactly once/i);
    assert.throws(
      () => assertFindingVerificationScopeV1(verification(), ["finding_boundary", "finding_other"]),
      /exactly once/i,
    );
  });

  it("matches the committed JSON Schema", async () => {
    assert.deepEqual(
      JSON.parse(await readFile("schemas/finding-verification-candidate-v1.schema.json", "utf8")),
      FINDING_VERIFICATION_CANDIDATE_V1_JSON_SCHEMA,
    );
    assert.deepEqual(
      JSON.parse(await readFile("schemas/finding-verification-v1.schema.json", "utf8")),
      FINDING_VERIFICATION_V1_JSON_SCHEMA,
    );
    assert.deepEqual(
      JSON.parse(await readFile("schemas/finding-verification-candidate-v2.schema.json", "utf8")),
      FINDING_VERIFICATION_CANDIDATE_V2_JSON_SCHEMA,
    );
    assert.deepEqual(
      JSON.parse(await readFile("schemas/finding-verification-v2.schema.json", "utf8")),
      FINDING_VERIFICATION_V2_JSON_SCHEMA,
    );
    assert.deepEqual(
      JSON.parse(await readFile("schemas/finding-verification-candidate-v3.schema.json", "utf8")),
      FINDING_VERIFICATION_CANDIDATE_V3_JSON_SCHEMA,
    );
    assert.deepEqual(
      JSON.parse(await readFile("schemas/finding-verification-v3.schema.json", "utf8")),
      FINDING_VERIFICATION_V3_JSON_SCHEMA,
    );
  });
});
