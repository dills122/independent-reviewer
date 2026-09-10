import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  computeCanonicalInputDigestV1,
  computeInitialEvidenceContentDigestV1,
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
  const canonicalInputs = request.canonicalInputs as {
    requirements: Array<Record<string, unknown>>;
    implementationPlan: Record<string, unknown>;
    projectGuidance: Array<Record<string, unknown>>;
  };
  const canonicalInputById = new Map(
    [
      ...canonicalInputs.requirements,
      canonicalInputs.implementationPlan,
      ...canonicalInputs.projectGuidance,
    ].map((input) => [input.id, input]),
  );
  const diffContent = "@@ -1,1 +1,1 @@";
  const sourceContent = 'import * as z from "zod";';

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
    canonicalInputs,
    snapshotManifest: {
      ...snapshotManifest,
      canonicalInputs: [
        {
          id: "input_review_protocol",
          kind: "REQUIREMENTS",
          digest: computeCanonicalInputDigestV1(canonicalInputById.get("input_review_protocol")),
          provenance: {
            type: "REPOSITORY_FILE",
            path: "docs/review-protocol-spec.md",
            revision: "d7d62a3",
          },
        },
        {
          id: "input_architecture_roadmap",
          kind: "IMPLEMENTATION_PLAN",
          digest: computeCanonicalInputDigestV1(
            canonicalInputById.get("input_architecture_roadmap"),
          ),
          provenance: {
            type: "REPOSITORY_FILE",
            path: "docs/architecture-and-roadmap.md",
            revision: "d7d62a3",
          },
        },
        {
          id: "input_repository_steering",
          kind: "PROJECT_GUIDANCE",
          digest: computeCanonicalInputDigestV1(
            canonicalInputById.get("input_repository_steering"),
          ),
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
        content: diffContent,
        digest: computeInitialEvidenceContentDigestV1(diffContent),
      },
      {
        type: "SOURCE_CONTEXT",
        evidenceId: "evidence_initial_context",
        path: "src/contracts/review-request.ts",
        side: "HEAD",
        startLine: 1,
        endLine: 1,
        content: sourceContent,
        digest: computeInitialEvidenceContentDigestV1(sourceContent),
      },
    ],
    referencedSources: [],
    coverageConstraints: [
      {
        type: "EXCLUDED_PATH",
        detail: "Secrets are not reviewable evidence.",
        paths: [".env"],
      },
    ],
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

  it("rejects structurally different provenance that collides when colon-delimited", async () => {
    const brief = (await createValidBrief()) as {
      canonicalInputs: {
        requirements: Array<{
          provenance: { type: "REPOSITORY_FILE"; path: string; revision?: string };
        }>;
      };
      snapshotManifest: {
        canonicalInputs: Array<{
          id: string;
          digest: unknown;
          provenance: { type: "REPOSITORY_FILE"; path: string; revision?: string };
        }>;
      };
    };
    const requirement = brief.canonicalInputs.requirements[0];
    const manifestRequirement = brief.snapshotManifest.canonicalInputs.find(
      (input) => input.id === "input_review_protocol",
    );
    assert.ok(requirement && manifestRequirement);
    requirement.provenance = {
      type: "REPOSITORY_FILE",
      path: "docs/a:b",
      revision: "c",
    };
    manifestRequirement.provenance = {
      type: "REPOSITORY_FILE",
      path: "docs/a",
      revision: "b:c",
    };
    manifestRequirement.digest = computeCanonicalInputDigestV1(requirement);

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("rejects canonical content that does not match its manifest digest", async () => {
    const brief = (await createValidBrief()) as {
      canonicalInputs: {
        requirements: Array<{ content: string }>;
      };
    };
    const requirement = brief.canonicalInputs.requirements[0];
    assert.ok(requirement);
    requirement.content = "Changed requirements under a stale manifest digest.";

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

  it("rejects duplicate initial-evidence identifiers", async () => {
    const brief = (await createValidBrief()) as {
      initialEvidence: Array<{ evidenceId: string }>;
    };
    const first = brief.initialEvidence[0];
    const second = brief.initialEvidence[1];
    assert.ok(first && second);
    second.evidenceId = first.evidenceId;

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("rejects initial evidence whose digest does not match its exact content", async () => {
    const brief = (await createValidBrief()) as {
      initialEvidence: Array<{ content: string }>;
    };
    const firstEvidence = brief.initialEvidence[0];
    assert.ok(firstEvidence);
    firstEvidence.content = "@@ -2,1 +2,1 @@";

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("requires source-context content to cover the declared logical lines", async () => {
    const brief = (await createValidBrief()) as {
      initialEvidence: Array<{ type: string; endLine?: number }>;
    };
    const context = brief.initialEvidence.find((evidence) => evidence.type === "SOURCE_CONTEXT");
    assert.ok(context);
    context.endLine = 2;

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("rejects a brief that declares reviewer capabilities", async () => {
    // The brief carries no capability declaration (ADR-005): a reviewer receives one fixed
    // payload and can request nothing, so an unknown block must be refused rather than ignored.
    const brief = (await createValidBrief()) as Record<string, unknown>;
    brief.capabilities = { evidenceOperations: [], verificationChecks: [] };

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, false);
  });

  it("rejects source context for a side where the path does not exist", async () => {
    const invalidAnchors = [
      { changeType: "UNTRACKED", path: "test/new-contract.test.ts", side: "BASE" },
      { changeType: "RENAMED", path: "docs/current-name.md", side: "BASE" },
      { changeType: "RENAMED", path: "docs/old-name.md", side: "HEAD" },
    ] as const;

    for (const anchor of invalidAnchors) {
      const brief = (await createValidBrief()) as {
        initialEvidence: Array<{ type: string; path: string; side?: string }>;
      };
      const context = brief.initialEvidence.find((evidence) => evidence.type === "SOURCE_CONTEXT");
      assert.ok(context);
      context.path = anchor.path;
      context.side = anchor.side;

      assert.equal(
        NeutralReviewBriefV1Schema.safeParse(brief).success,
        false,
        `${anchor.changeType} ${anchor.path} must not exist on ${anchor.side}`,
      );
    }
  });

  it("allows HEAD context for the retained source of a copied path", async () => {
    const brief = (await createValidBrief()) as {
      snapshotManifest: {
        paths: Array<{ changeType: string; previousPath?: string }>;
      };
      initialEvidence: Array<{ type: string; path: string; side?: string }>;
    };
    const renamed = brief.snapshotManifest.paths.find((path) => path.changeType === "RENAMED");
    const context = brief.initialEvidence.find((evidence) => evidence.type === "SOURCE_CONTEXT");
    assert.ok(renamed?.previousPath && context);
    renamed.changeType = "COPIED";
    context.path = renamed.previousPath;
    context.side = "HEAD";

    assert.equal(NeutralReviewBriefV1Schema.safeParse(brief).success, true);
  });

  it("allows text context on each valid rename and copy side", async () => {
    const validAnchors = [
      { changeType: "RENAMED", path: "docs/old-name.md", side: "BASE" },
      { changeType: "RENAMED", path: "docs/current-name.md", side: "HEAD" },
      { changeType: "COPIED", path: "docs/old-name.md", side: "BASE" },
      { changeType: "COPIED", path: "docs/old-name.md", side: "HEAD" },
      { changeType: "COPIED", path: "docs/current-name.md", side: "HEAD" },
    ] as const;

    for (const anchor of validAnchors) {
      const brief = (await createValidBrief()) as {
        snapshotManifest: { paths: Array<{ changeType: string }> };
        initialEvidence: Array<{ type: string; path: string; side?: string }>;
      };
      const relocated = brief.snapshotManifest.paths.find((path) => path.changeType === "RENAMED");
      const context = brief.initialEvidence.find((evidence) => evidence.type === "SOURCE_CONTEXT");
      assert.ok(relocated && context);
      relocated.changeType = anchor.changeType;
      context.path = anchor.path;
      context.side = anchor.side;

      assert.equal(
        NeutralReviewBriefV1Schema.safeParse(brief).success,
        true,
        `${anchor.changeType} ${anchor.path} must exist on ${anchor.side}`,
      );
    }
  });

  it("rejects source context for every non-text content kind", async () => {
    const nonTextContents = [
      {
        kind: "BINARY",
        digest: { algorithm: "SHA256", value: "a".repeat(64) },
        byteLength: 10,
        gitMode: "100644",
        isGenerated: false,
      },
      {
        kind: "SYMLINK",
        digest: { algorithm: "SHA256", value: "a".repeat(64) },
        byteLength: 10,
        gitMode: "120000",
        isGenerated: false,
      },
      {
        kind: "SUBMODULE",
        digest: { algorithm: "SHA256", value: "a".repeat(64) },
        byteLength: 10,
        gitMode: "160000",
        isGenerated: false,
      },
      {
        kind: "UNSUPPORTED",
        gitMode: "040000",
        isGenerated: false,
        reason: "Tree content is not directly reviewable.",
      },
    ];

    for (const content of nonTextContents) {
      const brief = (await createValidBrief()) as {
        snapshotManifest: {
          paths: Array<{ changeType: string; path: string; after?: unknown }>;
        };
        initialEvidence: Array<{ type: string; path: string; side?: string }>;
      };
      const untracked = brief.snapshotManifest.paths.find(
        (path) => path.changeType === "UNTRACKED",
      );
      const context = brief.initialEvidence.find((evidence) => evidence.type === "SOURCE_CONTEXT");
      assert.ok(untracked && context);
      untracked.after = content;
      context.path = untracked.path;
      context.side = "HEAD";

      assert.equal(
        NeutralReviewBriefV1Schema.safeParse(brief).success,
        false,
        `SOURCE_CONTEXT must reject ${content.kind}`,
      );
    }
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

  it("exports a materialized artifact schema with an explicit guidance ledger", () => {
    const schema = NEUTRAL_REVIEW_BRIEF_V1_JSON_SCHEMA as {
      properties?: { canonicalInputs?: { required?: string[] } };
    };

    assert.ok(schema.properties?.canonicalInputs?.required?.includes("projectGuidance"));
  });
});
