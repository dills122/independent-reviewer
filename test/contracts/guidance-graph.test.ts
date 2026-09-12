import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  assertGuidanceGraphMatchesSnapshotV1,
  buildReviewerRulesGuidanceGraphV1,
  finalizeSnapshotManifestV1,
  GUIDANCE_GRAPH_V1_JSON_SCHEMA,
  GuidanceGraphV1Schema,
  projectGuidanceTargetsV1,
  sha256Utf8,
  verifyGuidanceGraphIdentityV1,
} from "../../src/index.js";

async function manifestFixture() {
  const persisted = JSON.parse(
    await readFile(resolve("test", "fixtures", "snapshot-manifest.valid.json"), "utf8"),
  ) as Record<string, unknown>;
  const { snapshotDigest: _digest, ...draft } = persisted;
  return finalizeSnapshotManifestV1(draft);
}

describe("GuidanceGraphV1", () => {
  it("projects exact relocation-aware targets from a frozen snapshot", async () => {
    const manifest = await manifestFixture();
    const targets = projectGuidanceTargetsV1(manifest);

    assert.deepEqual(
      targets.map(({ applicabilityPath, side, role, changeType }) => ({
        applicabilityPath,
        side,
        role,
        changeType,
      })),
      [
        {
          applicabilityPath: "docs/current-name.md",
          side: "HEAD",
          role: "PRIMARY",
          changeType: "RENAMED",
        },
        {
          applicabilityPath: "docs/old-name.md",
          side: "BASE",
          role: "RELOCATION_SOURCE",
          changeType: "RENAMED",
        },
        {
          applicabilityPath: "src/contracts/review-request.ts",
          side: "HEAD",
          role: "PRIMARY",
          changeType: "MODIFIED",
        },
        {
          applicabilityPath: "test/new-contract.test.ts",
          side: "HEAD",
          role: "PRIMARY",
          changeType: "UNTRACKED",
        },
      ],
    );
    assert.equal(new Set(targets.map(({ targetId }) => targetId)).size, targets.length);
    assert.ok(targets.every(({ targetId }) => /^guidance_target_[0-9a-f]{64}$/.test(targetId)));
  });

  it("builds one highest-priority reviewer-rules node applicable to every target", async () => {
    const manifest = await manifestFixture();
    const contentDigest = sha256Utf8("# Reviewer rules\n\nNever weaken authentication.\n");
    const graph = buildReviewerRulesGuidanceGraphV1(manifest, contentDigest);

    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.nodes[0]?.resolvedPath, ".independent-reviewer/rules.md");
    assert.equal(graph.nodes[0]?.semanticTier, "REVIEWER_SPECIFIC");
    assert.equal(graph.nodes[0]?.directRecognitions.length, graph.targets.length);
    assert.ok(
      graph.nodes[0]?.directRecognitions.every(
        ({ familyId, sourceKind, nativeOrder }) =>
          familyId === "INDEPENDENT_REVIEWER" &&
          sourceKind === "REVIEWER_RULES" &&
          nativeOrder === 0,
      ),
    );
    assert.equal(graph.occurrences.length, 0);
    assert.equal(graph.edges.length, 0);
    assert.equal(verifyGuidanceGraphIdentityV1(graph), true);
  });

  it("rejects graph, source, target, ordering, and derived-field tampering", async () => {
    const manifest = await manifestFixture();
    const original = buildReviewerRulesGuidanceGraphV1(manifest, sha256Utf8("# Rules\n"));
    const mutations = [
      (graph: typeof original) => {
        const node = graph.nodes[0];
        assert.ok(node);
        node.contentDigest.value = "f".repeat(64);
      },
      (graph: typeof original) => {
        const node = graph.nodes[0];
        assert.ok(node);
        node.semanticTier = "REPOSITORY_PEER";
      },
      (graph: typeof original) => graph.targets.reverse(),
      (graph: typeof original) => {
        const target = graph.targets[0];
        assert.ok(target);
        target.applicabilityPath = "different/path.ts";
      },
    ];

    for (const mutate of mutations) {
      const graph = structuredClone(original);
      mutate(graph);
      assert.equal(verifyGuidanceGraphIdentityV1(graph), false);
      assert.equal(GuidanceGraphV1Schema.safeParse(graph).success, false);
    }
  });

  it("rejects a valid graph substituted across snapshot packets", async () => {
    const manifest = await manifestFixture();
    const graph = buildReviewerRulesGuidanceGraphV1(manifest, sha256Utf8("# Rules\n"));
    const otherManifest = structuredClone(manifest);
    otherManifest.snapshotDigest.value = "9".repeat(64);

    assert.throws(
      () => assertGuidanceGraphMatchesSnapshotV1(graph, otherManifest),
      /different snapshot/,
    );
  });

  it("matches the committed JSON Schema artifact", async () => {
    const schema = JSON.parse(
      await readFile(resolve("schemas", "guidance-graph-v1.schema.json"), "utf8"),
    );
    assert.deepEqual(schema, GUIDANCE_GRAPH_V1_JSON_SCHEMA);
  });
});
