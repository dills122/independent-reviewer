import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { createGuidanceDiscoverySessionV1 } from "../../src/guidance/discovery-capacity.js";
import {
  createGuidanceDiagnosticV1,
  finalizeSnapshotManifestV1,
  GuidanceCaptureError,
} from "../../src/index.js";

async function manifestFixture() {
  const persisted = JSON.parse(
    await readFile(resolve("test", "fixtures", "snapshot-manifest.valid.json"), "utf8"),
  ) as Record<string, unknown>;
  const { snapshotDigest: _digest, ...draft } = persisted;
  return finalizeSnapshotManifestV1(draft);
}

function diagnostics(count: number) {
  return Array.from({ length: count }, (_, index) =>
    createGuidanceDiagnosticV1({
      code: "UNKNOWN_SETTING_IGNORED",
      severity: "WARNING",
      path: `rules/rule-${index}.md`,
      startUtf16: index,
      omittedCount: null,
    }),
  );
}

describe("GuidanceDiscoverySessionV1", () => {
  it("deduplicates cross-family candidates before enforcing the shared 4,096-path cap", async () => {
    const session = createGuidanceDiscoverySessionV1(await manifestFixture());
    const firstFamily = Array.from({ length: 3_072 }, (_, index) => `rules/rule-${index}.md`);
    const secondFamily = Array.from(
      { length: 2_048 },
      (_, index) => `rules/rule-${index + 2_048}.md`,
    );

    session.claimDirectCandidates(firstFamily);
    session.claimDirectCandidates(secondFamily);

    assert.throws(
      () => session.claimDirectCandidates(["rules/one-path-too-many.md"]),
      (error: unknown) =>
        error instanceof GuidanceCaptureError &&
        error.code === "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED" &&
        error.path === "guidance",
    );
  });

  for (const count of [255, 256]) {
    it(`retains all ${count} canonical diagnostics without an overflow summary`, async () => {
      const session = createGuidanceDiscoverySessionV1(await manifestFixture());
      const inputs = diagnostics(count);
      for (const diagnostic of inputs) session.addDiagnostic(diagnostic);

      const finalized = session.finalizeDiagnostics();

      assert.equal(finalized.length, count);
      assert.equal(
        finalized.some(({ code }) => code === "DIAGNOSTIC_LIMIT_EXCEEDED"),
        false,
      );
      assert.deepEqual(
        new Set(finalized.map(({ diagnosticId }) => diagnosticId)),
        new Set(inputs.map(({ diagnosticId }) => diagnosticId)),
      );
    });
  }

  it("compacts 257 diagnostics to 255 originals plus a summary and stays permutation-stable", async () => {
    const manifest = await manifestFixture();
    const inputs = diagnostics(257);
    const forward = createGuidanceDiscoverySessionV1(manifest);
    const reverse = createGuidanceDiscoverySessionV1(manifest);
    for (const diagnostic of inputs) forward.addDiagnostic(diagnostic);
    for (const diagnostic of inputs.toReversed()) reverse.addDiagnostic(diagnostic);

    const finalized = forward.finalizeDiagnostics();
    const overflow = finalized.filter(({ code }) => code === "DIAGNOSTIC_LIMIT_EXCEEDED");

    assert.equal(finalized.length, 256);
    assert.equal(finalized.length - overflow.length, 255);
    assert.equal(overflow.length, 1);
    assert.equal(overflow[0]?.omittedCount, 2);
    assert.deepEqual(finalized, reverse.finalizeDiagnostics());
  });
});
