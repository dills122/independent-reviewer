import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ReviewBrief } from "../../src/contracts/neutral-review-brief.js";
import {
  assertFindingsUseTransmittedEvidenceV1,
  transmittedEvidencePathsV1,
} from "../../src/orchestrator/transmitted-evidence.js";

const diffBrief = {
  initialEvidence: [
    {
      type: "DIFF_HUNK",
      evidenceId: "evidence_change_0001",
      path: "src/example.ts",
      hunkId: "hunk_change_0001",
      content: [
        "Change: MODIFIED src/example.ts",
        "Evidence form: UNIFIED_HUNKS",
        "--- BASE/src/example.ts",
        "+++ HEAD/src/example.ts",
        "@@ -10,2 +10,2 @@",
        "-const oldName = 1;",
        "+const newName = 1;",
        " export const stable = 2;",
      ].join("\n"),
    },
  ],
} as unknown as ReviewBrief;

function lineEvidence(side: "BASE" | "HEAD", startLine: number, endLine = startLine) {
  return [
    {
      evidence: [
        {
          path: "src/example.ts",
          anchor: "LINE_RANGE" as const,
          side,
          startLine,
          endLine,
          detail: "Visible diff evidence.",
        },
      ],
    },
  ];
}

function symbolEvidence(side: "BASE" | "HEAD", symbol: string) {
  return [
    {
      evidence: [
        {
          path: "src/example.ts",
          anchor: "SYMBOL" as const,
          side,
          symbol,
          detail: "Visible diff evidence.",
        },
      ],
    },
  ];
}

describe("assertFindingsUseTransmittedEvidenceV1", () => {
  it("keeps a transmitted rename source available for BASE citations", () => {
    const renamed = {
      ...diffBrief,
      snapshotManifest: {
        paths: [
          {
            path: "src/example.ts",
            previousPath: "src/old-example.ts",
            changeType: "RENAMED",
          },
        ],
      },
      initialEvidence: [
        {
          ...diffBrief.initialEvidence[0],
          content: diffBrief.initialEvidence[0]?.content.replace(
            "BASE/src/example.ts",
            "BASE/src/old-example.ts",
          ),
        },
      ],
    } as unknown as ReviewBrief;

    assert.deepEqual(transmittedEvidencePathsV1(renamed), ["src/example.ts", "src/old-example.ts"]);
    const baseFinding = lineEvidence("BASE", 10);
    assert.ok(baseFinding[0]?.evidence[0]);
    baseFinding[0].evidence[0].path = "src/old-example.ts";
    assert.doesNotThrow(() => assertFindingsUseTransmittedEvidenceV1(baseFinding, renamed));
  });

  it("tracks deleted, added, and context lines on their source sides", () => {
    assert.doesNotThrow(() =>
      assertFindingsUseTransmittedEvidenceV1(lineEvidence("BASE", 10), diffBrief),
    );
    assert.doesNotThrow(() =>
      assertFindingsUseTransmittedEvidenceV1(lineEvidence("HEAD", 10), diffBrief),
    );
    assert.doesNotThrow(() =>
      assertFindingsUseTransmittedEvidenceV1(lineEvidence("HEAD", 10, 11), diffBrief),
    );
    assert.throws(
      () => assertFindingsUseTransmittedEvidenceV1(lineEvidence("HEAD", 9), diffBrief),
      /not included in transmitted evidence/i,
    );
  });

  it("keeps symbols bound to the side whose text was transmitted", () => {
    assert.doesNotThrow(() =>
      assertFindingsUseTransmittedEvidenceV1(symbolEvidence("BASE", "oldName"), diffBrief),
    );
    assert.doesNotThrow(() =>
      assertFindingsUseTransmittedEvidenceV1(symbolEvidence("HEAD", "newName"), diffBrief),
    );
    assert.throws(
      () => assertFindingsUseTransmittedEvidenceV1(symbolEvidence("HEAD", "oldName"), diffBrief),
      /not included in transmitted evidence/i,
    );
  });
});
