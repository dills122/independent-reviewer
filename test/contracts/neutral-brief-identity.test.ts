import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  computeCanonicalInputDigestV1,
  finalizeNeutralReviewBriefV1,
  finalizeSnapshotManifestV1,
  verifyNeutralReviewBriefIdentityV1,
} from "../../src/index.js";

async function readFixture(name: string): Promise<Record<string, unknown>> {
  const contents = await readFile(resolve("test", "fixtures", name), "utf8");
  return JSON.parse(contents) as Record<string, unknown>;
}

async function createBriefDraft(): Promise<Record<string, unknown>> {
  const request = await readFixture("review-request.valid.json");
  const canonicalInputs = request.canonicalInputs as {
    requirements: Array<Record<string, unknown>>;
    implementationPlan: Record<string, unknown>;
    projectGuidance: Array<Record<string, unknown>>;
  };
  const allCanonicalInputs = [
    ...canonicalInputs.requirements,
    canonicalInputs.implementationPlan,
    ...canonicalInputs.projectGuidance,
  ];
  const snapshot = await readFixture("snapshot-manifest.valid.json");
  const { snapshotDigest: _snapshotDigest, ...snapshotDraft } = snapshot;
  snapshotDraft.canonicalInputs = allCanonicalInputs.map((input) => ({
    id: input.id,
    kind: input.kind,
    digest: computeCanonicalInputDigestV1(input),
    provenance: input.provenance,
  }));

  return {
    schemaVersion: 1,
    briefId: "brief_identity_fixture",
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
    snapshotManifest: finalizeSnapshotManifestV1(snapshotDraft),
    initialEvidence: [],
    coverageConstraints: [],
    capabilities: {
      evidenceOperations: ["READ_SNAPSHOT_FILE", "READ_DIFF"],
      verificationChecks: [],
    },
  };
}

describe("neutral review brief identity", () => {
  it("finalizes and verifies a valid neutral brief", async () => {
    const brief = finalizeNeutralReviewBriefV1(await createBriefDraft());

    assert.equal(brief.briefDigest.algorithm, "SHA256");
    assert.equal(
      brief.briefDigest.value,
      "5c39a00631e45822789154efc7fc2b0d5ab189b1d5d2b0d86a7f36e43e0e745f",
    );
    assert.equal(verifyNeutralReviewBriefIdentityV1(brief), true);
  });

  it("does not let an opaque brief ID change content identity", async () => {
    const draft = await createBriefDraft();
    const changedId = { ...draft, briefId: "brief_another_artifact" };

    assert.deepEqual(
      finalizeNeutralReviewBriefV1(changedId).briefDigest,
      finalizeNeutralReviewBriefV1(draft).briefDigest,
    );
  });

  it("changes when blind-stage content changes", async () => {
    const draft = await createBriefDraft();
    const changed = structuredClone(draft) as {
      objective: { text: string };
    };
    changed.objective.text = "Review a different objective.";

    assert.notDeepEqual(
      finalizeNeutralReviewBriefV1(changed).briefDigest,
      finalizeNeutralReviewBriefV1(draft).briefDigest,
    );
  });

  it("detects a changed brief after finalization", async () => {
    const brief = finalizeNeutralReviewBriefV1(await createBriefDraft());
    brief.capabilities.evidenceOperations.push("SEARCH_SNAPSHOT");

    assert.equal(verifyNeutralReviewBriefIdentityV1(brief), false);
  });

  it("rejects an invalid embedded snapshot identity", async () => {
    const draft = (await createBriefDraft()) as {
      snapshotManifest: { source: { branch: string | null } };
    };
    draft.snapshotManifest.source.branch = "codex/tampered";

    assert.throws(() => finalizeNeutralReviewBriefV1(draft), /snapshot identity/);
  });

  it("rejects custom brief drafts before coercing them", async () => {
    const draft = await createBriefDraft();
    Object.setPrototypeOf(draft, { customDraft: true });

    assert.throws(() => finalizeNeutralReviewBriefV1(draft), /plain JSON objects/);
  });
});
