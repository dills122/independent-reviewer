import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  assertFindingVerificationScopeV1,
  FINDING_VERIFICATION_V1_JSON_SCHEMA,
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
  it("accepts one bounded assessment for every preliminary finding", () => {
    const parsed = FindingVerificationV1Schema.parse(verification());
    assert.doesNotThrow(() => assertFindingVerificationScopeV1(parsed, ["finding_boundary"]));
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
      JSON.parse(await readFile("schemas/finding-verification-v1.schema.json", "utf8")),
      FINDING_VERIFICATION_V1_JSON_SCHEMA,
    );
  });
});
