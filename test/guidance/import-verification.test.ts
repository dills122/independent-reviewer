import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { assertGuidanceImportOccurrencesV1 } from "../../src/guidance/import-verification.js";
import {
  buildGuidanceGraphV1,
  finalizeSnapshotManifestV1,
  projectGuidanceTargetsV1,
  sha256Utf8,
} from "../../src/index.js";

async function manifestFixture() {
  const persisted = JSON.parse(
    await readFile(resolve("test", "fixtures", "snapshot-manifest.valid.json"), "utf8"),
  ) as Record<string, unknown>;
  const { snapshotDigest: _digest, ...draft } = persisted;
  return finalizeSnapshotManifestV1(draft);
}

describe("persisted guidance import verification", () => {
  it("rejects an attacker-selected import destination after BASE re-resolution", async () => {
    const manifest = await manifestFixture();
    const target = projectGuidanceTargetsV1(manifest)[0];
    assert.ok(target);
    const importerContent = "Read @expected.md\n";
    const attackerContent = "# Attacker-selected guidance\n";
    const importerDigest = sha256Utf8(importerContent);
    const attackerDigest = sha256Utf8(attackerContent);
    const graph = buildGuidanceGraphV1(
      manifest,
      [
        {
          resolvedPath: "CLAUDE.md",
          contentDigest: importerDigest,
          directRecognitions: [
            {
              familyId: "CLAUDE",
              sourceKind: "CLAUDE_MD",
              nativeOrder: 0,
              applicableTargetId: target.targetId,
              discoveredPath: "CLAUDE.md",
            },
          ],
        },
        {
          resolvedPath: "attacker.md",
          contentDigest: attackerDigest,
          directRecognitions: [],
        },
      ],
      [
        {
          familyId: "CLAUDE",
          syntaxKind: "CLAUDE_AT_PATH",
          importerPath: "CLAUDE.md",
          importerContentDigest: importerDigest,
          importedPath: "attacker.md",
          importedContentDigest: attackerDigest,
          requestedSpecifier: "expected.md",
          startUtf16: 5,
          endUtf16: 17,
          applicableTargetIds: [target.targetId],
        },
      ],
    );
    const bytes = new Map([
      [importerDigest.value, new TextEncoder().encode(importerContent)],
      [attackerDigest.value, new TextEncoder().encode(attackerContent)],
    ]);

    await assert.rejects(
      assertGuidanceImportOccurrencesV1(
        graph,
        async (node) => bytes.get(node.contentDigest.value) as Uint8Array,
        async () => ({ resolvedPath: "expected.md", contentDigest: sha256Utf8("# Expected\n") }),
      ),
      /resolved destination/i,
    );
  });

  it("rejects cycles and over-depth chains even when graph closure is self-consistent", async () => {
    const manifest = await manifestFixture();
    const target = projectGuidanceTargetsV1(manifest)[0];
    assert.ok(target);
    const contents = new Map([
      ["CLAUDE.md", "@one.md\n"],
      ["one.md", "@two.md\n"],
      ["two.md", "@three.md\n"],
      ["three.md", "@four.md\n"],
      ["four.md", "@five.md\n"],
      ["five.md", "# terminal\n"],
    ]);
    const sources = [...contents].map(([path, content]) => ({
      resolvedPath: path,
      contentDigest: sha256Utf8(content),
      directRecognitions:
        path === "CLAUDE.md"
          ? [
              {
                familyId: "CLAUDE" as const,
                sourceKind: "CLAUDE_MD" as const,
                nativeOrder: 0,
                applicableTargetId: target.targetId,
                discoveredPath: "CLAUDE.md",
              },
            ]
          : [],
    }));
    const imports = [...contents.keys()].slice(0, -1).map((path, index) => {
      const importedPath = [...contents.keys()][index + 1] as string;
      const requestedSpecifier = importedPath;
      const content = contents.get(path) as string;
      return {
        familyId: "CLAUDE" as const,
        syntaxKind: "CLAUDE_AT_PATH" as const,
        importerPath: path,
        importerContentDigest: sha256Utf8(content),
        importedPath,
        importedContentDigest: sha256Utf8(contents.get(importedPath) as string),
        requestedSpecifier,
        startUtf16: 0,
        endUtf16: requestedSpecifier.length + 1,
        applicableTargetIds: [target.targetId],
      };
    });
    const graph = buildGuidanceGraphV1(manifest, sources, imports);
    const byPath = new Map(sources.map((source) => [source.resolvedPath, source]));
    const bytes = new Map(
      [...contents].map(([path, content]) => [
        (byPath.get(path) as (typeof sources)[number]).contentDigest.value,
        new TextEncoder().encode(content),
      ]),
    );

    await assert.rejects(
      assertGuidanceImportOccurrencesV1(
        graph,
        async (node) => bytes.get(node.contentDigest.value) as Uint8Array,
        async (path) => {
          const source = byPath.get(path);
          assert.ok(source);
          return { resolvedPath: source.resolvedPath, contentDigest: source.contentDigest };
        },
      ),
      /depth/i,
    );
  });
});
