import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA,
  NeutralReviewBriefV1Schema,
} from "../../src/index.js";

async function readFixture(name: string): Promise<Record<string, unknown>> {
  const contents = await readFile(resolve("test", "fixtures", name), "utf8");
  const fixture = JSON.parse(contents) as unknown;
  assert.ok(fixture && typeof fixture === "object" && !Array.isArray(fixture));
  return fixture as Record<string, unknown>;
}

async function createValidBrief(): Promise<Record<string, unknown>> {
  const snapshotManifest = await readFixture("snapshot-manifest.valid.json");
  const request = await readFixture("review-request.valid.json");

  return {
    schemaVersion: 1,
    briefId: "brief_contract_fixture",
    briefDigest: {
      algorithm: "SHA256",
      value: "9".repeat(64),
    },
    objective: {
      text: "Review the implementation against the accepted protocol.",
      canonicalInputIds: ["input_review_protocol"],
    },
    successCriteria: [
      {
        text: "The reviewer receives neutral evidence before author rationale.",
        canonicalInputIds: ["input_review_protocol"],
      },
    ],
    canonicalInputs: request.canonicalInputs,
    snapshotManifest: {
      ...snapshotManifest,
      canonicalInputs: [
        {
          id: "input_review_protocol",
          kind: "REQUIREMENTS",
          digest: {
            algorithm: "SHA256",
            value: "2".repeat(64),
          },
          provenance: {
            type: "REPOSITORY_FILE",
            path: "docs/review-protocol-spec.md",
            revision: "d7d62a3",
          },
        },
        {
          id: "input_architecture_roadmap",
          kind: "IMPLEMENTATION_PLAN",
          digest: {
            algorithm: "SHA256",
            value: "5".repeat(64),
          },
          provenance: {
            type: "REPOSITORY_FILE",
            path: "docs/architecture-and-roadmap.md",
            revision: "d7d62a3",
          },
        },
        {
          id: "input_repository_steering",
          kind: "PROJECT_GUIDANCE",
          digest: {
            algorithm: "SHA256",
            value: "6".repeat(64),
          },
          provenance: {
            type: "REPOSITORY_FILE",
            path: ".codex/steering/repository-steering.md",
            revision: "d7d62a3",
          },
        },
      ],
    },
    initialEvidence: [
      {
        type: "DIFF_HUNK",
        evidenceId: "evidence_initial_diff",
        path: "src/contracts/review-request.ts",
        hunkId: "hunk_review_request_1",
        content: "@@ -1,1 +1,1 @@",
        digest: {
          algorithm: "SHA256",
          value: "7".repeat(64),
        },
      },
      {
        type: "SOURCE_CONTEXT",
        evidenceId: "evidence_initial_context",
        path: "src/contracts/review-request.ts",
        side: "HEAD",
        startLine: 1,
        endLine: 10,
        content: 'import * as z from "zod";',
        digest: {
          algorithm: "SHA256",
          value: "8".repeat(64),
        },
      },
    ],
    coverageConstraints: [
      {
        type: "EXCLUDED_PATH",
        detail: "Secrets are not reviewable evidence.",
        paths: [".env"],
      },
    ],
    capabilities: {
      evidenceOperations: ["READ_SNAPSHOT_FILE", "READ_DIFF", "SEARCH_SNAPSHOT"],
      verificationChecks: [
        {
          id: "check_application",
          title: "Application quality gate",
        },
      ],
    },
  };
}

describe("NeutralReviewBriefV1Schema", () => {
  it("accepts neutral canonical context and snapshot-bound evidence", async () => {
    const brief = NeutralReviewBriefV1Schema.parse(await createValidBrief());

    assert.equal(brief.initialEvidence.length, 2);
    assert.equal(brief.snapshotManifest.snapshotId, "snapshot_contract_fixture");
  });

  it("rejects author material at the strict brief boundary", async () => {
    const brief = { ...(await createValidBrief()), authorPacket: { intent: "trust me" } };

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("requires manifest identities for every canonical input", async () => {
    const brief = (await createValidBrief()) as {
      snapshotManifest: { canonicalInputs: unknown[] };
    };
    brief.snapshotManifest.canonicalInputs.pop();

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("rejects provenance drift between canonical content and the manifest", async () => {
    const brief = (await createValidBrief()) as {
      snapshotManifest: {
        canonicalInputs: Array<{ provenance: { path?: string } }>;
      };
    };
    const requirement = brief.snapshotManifest.canonicalInputs[0];
    assert.ok(requirement);
    requirement.provenance.path = "docs/different-source.md";

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("rejects initial evidence for a path outside the manifest", async () => {
    const brief = (await createValidBrief()) as {
      initialEvidence: Array<{ path: string }>;
    };
    const firstEvidence = brief.initialEvidence[0];
    assert.ok(firstEvidence);
    firstEvidence.path = "src/not-captured.ts";

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("rejects an inverted source-context line range", async () => {
    const brief = (await createValidBrief()) as {
      initialEvidence: Array<{ type: string; startLine?: number; endLine?: number }>;
    };
    const context = brief.initialEvidence.find((evidence) => evidence.type === "SOURCE_CONTEXT");
    assert.ok(context);
    context.startLine = 11;
    context.endLine = 10;

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("matches the committed JSON Schema artifact", async () => {
    const contents = await readFile(
      resolve("schemas", "neutral-review-brief-v1.schema.json"),
      "utf8",
    );

    assert.deepEqual(JSON.parse(contents), NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA);
  });
});
