import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { resolveBaseGuidanceBlobV1 } from "../../src/guidance/base-markdown-source.js";
import { scanCopilotImportOccurrencesV1 } from "../../src/guidance/copilot-imports.js";
import { scanCursorImportOccurrencesV1 } from "../../src/guidance/cursor-imports.js";
import { createGuidanceDiscoverySessionV1 } from "../../src/guidance/discovery-capacity.js";
import { scanGeminiImportOccurrencesV1 } from "../../src/guidance/gemini-imports.js";
import { scanKiroFileReferenceOccurrencesV1 } from "../../src/guidance/kiro-imports.js";
import {
  type DigestV1,
  finalizeSnapshotManifestV1,
  GuidanceCaptureError,
  MAX_GUIDANCE_APPLICABILITY_PAIRS_V1,
  MAX_GUIDANCE_APPLICABILITY_PATHS_V1,
  MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1,
  MAX_GUIDANCE_EDGES_V1,
  MAX_GUIDANCE_NODES_V1,
  MAX_GUIDANCE_OCCURRENCES_V1,
  MAX_GUIDANCE_SNAPSHOT_ENTRIES_V1,
  MAX_GUIDANCE_TARGETS_V1,
  type SnapshotManifestV1,
} from "../../src/index.js";

const exec = promisify(execFile);
const digest: DigestV1 = { algorithm: "SHA256", value: "a".repeat(64) };

async function manifestFixture(): Promise<SnapshotManifestV1> {
  const persisted = JSON.parse(
    await readFile(resolve("test", "fixtures", "snapshot-manifest.valid.json"), "utf8"),
  ) as Record<string, unknown>;
  const { snapshotDigest: _digest, ...draft } = persisted;
  return finalizeSnapshotManifestV1(draft);
}

function expectLimit(action: () => void, messageFragment?: string): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof GuidanceCaptureError &&
      error.code === "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED" &&
      (messageFragment === undefined || error.message.includes(messageFragment)),
  );
}

describe("Slice 3 resource-cap boundaries", () => {
  it("projects 8,190 then 8,192 relocation targets and applicability paths before rejecting entry 4,097", async () => {
    const fixture = await manifestFixture();
    const template = fixture.paths.find(({ changeType }) => changeType === "RENAMED");
    assert.ok(template);
    const manifestWith = (count: number): SnapshotManifestV1 => ({
      ...fixture,
      paths: Array.from({ length: count }, (_, index) => ({
        ...template,
        path: `new/file-${index.toString().padStart(4, "0")}.ts`,
        previousPath: `old/file-${index.toString().padStart(4, "0")}.ts`,
      })),
      workingTree: { ...fixture.workingTree, includedUntrackedPaths: [] },
    });

    const below = createGuidanceDiscoverySessionV1(
      manifestWith(MAX_GUIDANCE_SNAPSHOT_ENTRIES_V1 - 1),
    );
    assert.equal(below.targets.length, MAX_GUIDANCE_TARGETS_V1 - 2);
    assert.equal(
      new Set(below.targets.map(({ applicabilityPath }) => applicabilityPath)).size,
      MAX_GUIDANCE_APPLICABILITY_PATHS_V1 - 2,
    );

    const at = createGuidanceDiscoverySessionV1(manifestWith(MAX_GUIDANCE_SNAPSHOT_ENTRIES_V1));
    assert.equal(at.targets.length, MAX_GUIDANCE_TARGETS_V1);
    assert.equal(
      new Set(at.targets.map(({ applicabilityPath }) => applicabilityPath)).size,
      MAX_GUIDANCE_APPLICABILITY_PATHS_V1,
    );

    // One entry can project at most two targets, so snapshot admission is the earlier guard for
    // every input capable of exceeding either derived 8,192-item cap.
    expectLimit(() =>
      createGuidanceDiscoverySessionV1(manifestWith(MAX_GUIDANCE_SNAPSHOT_ENTRIES_V1 + 1)),
    );
  });

  it("counts unique direct recognitions below, at, and above the 65,536-record cap", async () => {
    const session = createGuidanceDiscoverySessionV1(await manifestFixture());
    const target = session.targets[0];
    assert.ok(target);
    const source = { resolvedPath: "AGENTS.md", contentDigest: digest };
    const claim = (nativeOrder: number) =>
      session.claimDirectRecognition(source, {
        familyId: "CODEX",
        sourceKind: "CODEX_AGENTS",
        nativeOrder,
        applicableTargetId: target.targetId,
        discoveredPath: "AGENTS.md",
      });

    for (let index = 0; index < MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1 - 1; index += 1) {
      claim(index);
    }
    claim(MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1 - 1);
    claim(MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1 - 1);
    expectLimit(
      () => claim(MAX_GUIDANCE_DIRECT_RECOGNITIONS_V1),
      "direct recognitions were produced",
    );
  });

  it("counts unique applicability pairs below, at, and above the 65,536-pair cap", async () => {
    const session = createGuidanceDiscoverySessionV1(await manifestFixture());
    const directSource = { resolvedPath: "AGENTS.md", contentDigest: digest };
    const importedSource = { resolvedPath: "docs/imported.md", contentDigest: digest };
    const directPairsAtLimit = MAX_GUIDANCE_APPLICABILITY_PAIRS_V1 - MAX_GUIDANCE_EDGES_V1;
    const claimDirectPair = (index: number) =>
      session.claimDirectRecognition(directSource, {
        familyId: "CODEX",
        sourceKind: "CODEX_AGENTS",
        nativeOrder: index,
        applicableTargetId: `guidance_target_direct_${index}`,
        discoveredPath: "AGENTS.md",
      });

    for (let index = 0; index < directPairsAtLimit - 1; index += 1) claimDirectPair(index);
    for (let index = 0; index < MAX_GUIDANCE_EDGES_V1; index += 1) {
      session.claimImportEdge(
        `occurrence-${index}`,
        importedSource,
        `guidance_target_import_${index}`,
      );
    }
    claimDirectPair(directPairsAtLimit - 1);
    expectLimit(
      () => claimDirectPair(directPairsAtLimit),
      "source/target applicability pairs were produced",
    );
  });

  it("counts unique canonical nodes below, at, and above the 256-node cap", async () => {
    const session = createGuidanceDiscoverySessionV1(await manifestFixture());
    const target = session.targets[0];
    assert.ok(target);
    const claim = (index: number) =>
      session.claimDirectRecognition(
        { resolvedPath: `rules/rule-${index}.md`, contentDigest: digest },
        {
          familyId: "CODEX",
          sourceKind: "CODEX_AGENTS",
          nativeOrder: index,
          applicableTargetId: target.targetId,
          discoveredPath: `rules/rule-${index}.md`,
        },
      );

    for (let index = 0; index < MAX_GUIDANCE_NODES_V1 - 1; index += 1) claim(index);
    claim(MAX_GUIDANCE_NODES_V1 - 1);
    claim(MAX_GUIDANCE_NODES_V1 - 1);
    expectLimit(() => claim(MAX_GUIDANCE_NODES_V1));
  });

  it("counts unique occurrences and edges below, at, and above their caps", async () => {
    const occurrenceSession = createGuidanceDiscoverySessionV1(await manifestFixture());
    for (let index = 0; index < MAX_GUIDANCE_OCCURRENCES_V1 - 1; index += 1) {
      occurrenceSession.claimOccurrence({ index });
    }
    occurrenceSession.claimOccurrence({ index: MAX_GUIDANCE_OCCURRENCES_V1 - 1 });
    occurrenceSession.claimOccurrence({ index: MAX_GUIDANCE_OCCURRENCES_V1 - 1 });
    expectLimit(() => occurrenceSession.claimOccurrence({ index: MAX_GUIDANCE_OCCURRENCES_V1 }));

    const edgeSession = createGuidanceDiscoverySessionV1(await manifestFixture());
    const target = edgeSession.targets[0];
    assert.ok(target);
    for (let index = 0; index < MAX_GUIDANCE_EDGES_V1 - 1; index += 1) {
      edgeSession.claimImportEdge(
        `occurrence-${index}`,
        { resolvedPath: "docs/imported.md", contentDigest: digest },
        target.targetId,
      );
    }
    edgeSession.claimImportEdge(
      `occurrence-${MAX_GUIDANCE_EDGES_V1 - 1}`,
      { resolvedPath: "docs/imported.md", contentDigest: digest },
      target.targetId,
    );
    edgeSession.claimImportEdge(
      `occurrence-${MAX_GUIDANCE_EDGES_V1 - 1}`,
      { resolvedPath: "docs/imported.md", contentDigest: digest },
      target.targetId,
    );
    expectLimit(() =>
      edgeSession.claimImportEdge(
        `occurrence-${MAX_GUIDANCE_EDGES_V1}`,
        { resolvedPath: "docs/imported.md", contentDigest: digest },
        target.targetId,
      ),
    );
  });

  for (const scanner of [
    {
      family: "Gemini",
      scan: scanGeminiImportOccurrencesV1,
      token: (index: number) => `@file-${index}.md`,
    },
    {
      family: "Kiro",
      scan: scanKiroFileReferenceOccurrencesV1,
      token: (index: number) => `#[[file:file-${index}.md]]`,
    },
    {
      family: "Copilot",
      scan: scanCopilotImportOccurrencesV1,
      token: (index: number) => `@file-${index}.md`,
    },
    {
      family: "Cursor",
      scan: scanCursorImportOccurrencesV1,
      token: (index: number) => `@file-${index}.md`,
    },
  ] as const) {
    it(`${scanner.family} admits 32 import tokens and rejects token 33`, () => {
      const content = (count: number) =>
        Array.from({ length: count }, (_, index) => scanner.token(index)).join("\n");
      assert.equal(scanner.scan("rules.md", content(31)).length, 31);
      assert.equal(scanner.scan("rules.md", content(32)).length, 32);
      assert.throws(
        () => scanner.scan("rules.md", content(33)),
        (error: unknown) =>
          error instanceof GuidanceCaptureError &&
          error.code === "GUIDANCE_IMPORT_OCCURRENCE_LIMIT",
      );
    });
  }

  it("follows exactly 16 BASE symlinks and rejects the seventeenth", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "slice-3-symlink-cap-"));
    try {
      await exec("git", ["-C", repositoryPath, "init", "--initial-branch=main"]);
      await exec("git", ["-C", repositoryPath, "config", "user.name", "Symlink Cap Test"]);
      await exec("git", ["-C", repositoryPath, "config", "user.email", "symlink@example.invalid"]);
      await exec("git", ["-C", repositoryPath, "config", "commit.gpgsign", "false"]);
      await writeFile(join(repositoryPath, "rules.md"), "# Rules\n");
      for (const [prefix, count] of [
        ["at", 16],
        ["above", 17],
      ] as const) {
        for (let index = count - 1; index >= 0; index -= 1) {
          const destination = index === count - 1 ? "rules.md" : `${prefix}-${index + 1}.md`;
          await symlink(destination, join(repositoryPath, `${prefix}-${index}.md`));
        }
      }
      await exec("git", ["-C", repositoryPath, "add", "."]);
      await exec("git", ["-C", repositoryPath, "commit", "-m", "base"]);
      const { stdout } = await exec("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
      const baseCommit = stdout.trim();

      assert.equal(
        (await resolveBaseGuidanceBlobV1(repositoryPath, baseCommit, "at-0.md"))?.resolvedPath,
        "rules.md",
      );
      await assert.rejects(
        resolveBaseGuidanceBlobV1(repositoryPath, baseCommit, "above-0.md"),
        (error: unknown) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_SYMLINK_LIMIT",
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
