import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  buildGuidanceGraphV1,
  captureGitSnapshotV1,
  captureRepositoryGuidanceV1,
  finalizeSnapshotManifestV1,
  GuidanceCaptureError,
  projectGuidanceTargetsV1,
  type ReviewRequestV1,
  type SnapshotManifestV1,
} from "../../src/index.js";

const exec = promisify(execFile);
const SECRET_SENTINEL = "github_pat_abcdefghijklmnopqrstuvwxyz";

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", repositoryPath, ...args]);
}

function request(repositoryPath: string): ReviewRequestV1 {
  return {
    schemaVersion: 1,
    flowId: "flow_slice_3_acceptance",
    reviewInstance: { number: 1, maximum: 3 },
    repository: {
      path: repositoryPath,
      base: "main",
      workingTree: { mode: "CUMULATIVE", includeUntracked: true },
    },
    canonicalInputs: {
      requirements: [
        {
          id: "input_requirement",
          kind: "REQUIREMENTS",
          title: "Requirement",
          content: "Review changed code.",
          provenance: { type: "INLINE", label: "test" },
        },
      ],
      implementationPlan: {
        id: "input_plan",
        kind: "IMPLEMENTATION_PLAN",
        title: "Plan",
        content: "Change source.",
        provenance: { type: "INLINE", label: "test" },
      },
      projectGuidance: [],
    },
    reviewConfigRef: "config_test",
  };
}

async function initializeRepository(prefix: string): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), prefix));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Slice 3 Acceptance Test");
  await git(repositoryPath, "config", "user.email", "slice-3@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  return repositoryPath;
}

async function commitBase(repositoryPath: string): Promise<void> {
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "base");
  await git(repositoryPath, "switch", "-c", "feature/slice-3-acceptance");
}

function recognitionKinds(
  graph: Awaited<ReturnType<typeof captureRepositoryGuidanceV1>>["graph"],
  resolvedPath: string,
): string[] {
  const node = graph.nodes.find((candidate) => candidate.resolvedPath === resolvedPath);
  assert.ok(node, `missing guidance node ${resolvedPath}`);
  return [
    ...new Set(
      node.directRecognitions.map(({ familyId, sourceKind }) => `${familyId}:${sourceKind}`),
    ),
  ].sort();
}

function rebuildInReverseOrder(
  manifest: SnapshotManifestV1,
  graph: Awaited<ReturnType<typeof captureRepositoryGuidanceV1>>["graph"],
) {
  const nodesById = new Map(graph.nodes.map((node) => [node.sourceId, node]));
  const sources = graph.nodes.toReversed().map((node) => ({
    resolvedPath: node.resolvedPath,
    contentDigest: node.contentDigest,
    directRecognitions: node.directRecognitions.toReversed(),
  }));
  const imports = graph.occurrences.toReversed().map((occurrence) => {
    const importer = nodesById.get(occurrence.importerSourceId);
    const edges = graph.edges.filter(
      ({ occurrenceId }) => occurrenceId === occurrence.occurrenceId,
    );
    const importedIds = new Set(edges.map(({ importedSourceId }) => importedSourceId));
    assert.ok(importer);
    assert.equal(importedIds.size, 1);
    const imported = nodesById.get([...importedIds][0] ?? "");
    assert.ok(imported);
    return {
      familyId: occurrence.familyId,
      syntaxKind: occurrence.syntaxKind,
      importerPath: importer.resolvedPath,
      importerContentDigest: importer.contentDigest,
      importedPath: imported.resolvedPath,
      importedContentDigest: imported.contentDigest,
      requestedSpecifier: occurrence.requestedSpecifier,
      startUtf16: occurrence.startUtf16,
      endUtf16: occurrence.endUtf16,
      applicableTargetIds: edges.map(({ applicableTargetId }) => applicableTargetId).toReversed(),
    };
  });
  return buildGuidanceGraphV1(manifest, sources, imports, graph.diagnostics.toReversed());
}

describe("Slice 3 provider-free acceptance matrix", () => {
  it("keeps multi-family source kinds, import closure, dynamic exclusions, and language-neutral applicability canonical", async () => {
    const repositoryPath = await initializeRepository("slice-3-matrix-");
    try {
      for (const directory of [
        ".claude",
        ".cursor/rules",
        ".github",
        ".kiro/steering",
        ".independent-reviewer",
        "docs",
        "src",
      ]) {
        await mkdir(join(repositoryPath, directory), { recursive: true });
      }
      await writeFile(join(repositoryPath, "AGENTS.md"), "# Shared agent instructions\n");
      await writeFile(join(repositoryPath, "CLAUDE.md"), "# Claude\n\n@docs/shared.md\n");
      await writeFile(join(repositoryPath, "GEMINI.md"), "# Gemini\n\n@docs/shared.md\n");
      await writeFile(
        join(repositoryPath, ".github", "copilot-instructions.md"),
        "# Copilot\n\n@../docs/shared.md\n",
      );
      await writeFile(
        join(repositoryPath, ".kiro", "steering", "always.md"),
        "# Kiro\n\n#[[file:../../docs/shared.md]]\n",
      );
      await writeFile(
        join(repositoryPath, ".kiro", "steering", "manual.md"),
        "---\ninclusion: manual\n---\n# Never selected\n",
      );
      await writeFile(
        join(repositoryPath, ".kiro", "steering", "auto.md"),
        "---\ninclusion: auto\n---\n# Never model-selected\n",
      );
      await writeFile(
        join(repositoryPath, ".cursor", "rules", "always.mdc"),
        "---\nalwaysApply: true\n---\n# Cursor\n\n@../../docs/shared.md\n",
      );
      await writeFile(
        join(repositoryPath, ".cursor", "rules", "model.mdc"),
        "---\nalwaysApply: false\ndescription: Use when model selects this rule\n---\n# Never model-selected\n",
      );
      await writeFile(
        join(repositoryPath, ".cursor", "rules", "manual.mdc"),
        "# Never manually selected\n",
      );
      await writeFile(join(repositoryPath, ".independent-reviewer", "rules.md"), "# Reviewer\n");
      await writeFile(join(repositoryPath, "docs", "shared.md"), "# Imported once per payload\n");
      const languagePaths = [
        "src/app.ts",
        "src/app.py",
        "src/app.go",
        "src/App.java",
        "src/guide.md",
      ];
      for (const path of languagePaths) await writeFile(join(repositoryPath, path), "before\n");
      await commitBase(repositoryPath);
      for (const path of languagePaths) await writeFile(join(repositoryPath, path), "after\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath), {
        pathRoleOverrides: new Map([["src/guide.md", "SOURCE"]]),
      });
      const captured = await captureRepositoryGuidanceV1(repositoryPath, snapshot.manifest);

      assert.deepEqual(
        captured.graph.targets.map(({ applicabilityPath }) => applicabilityPath),
        [...languagePaths].sort(),
      );

      assert.deepEqual(recognitionKinds(captured.graph, "AGENTS.md"), [
        "CODEX:CODEX_AGENTS",
        "COPILOT:COPILOT_AGENTS",
        "KIRO:KIRO_AGENTS",
      ]);
      assert.deepEqual(recognitionKinds(captured.graph, "CLAUDE.md"), [
        "CLAUDE:CLAUDE_MD",
        "COPILOT:COPILOT_CLAUDE",
      ]);
      assert.deepEqual(recognitionKinds(captured.graph, "GEMINI.md"), [
        "COPILOT:COPILOT_GEMINI",
        "GEMINI:GEMINI_CONTEXT",
      ]);
      assert.equal(
        captured.graph.nodes.filter(({ resolvedPath }) => resolvedPath === "docs/shared.md").length,
        1,
      );
      assert.equal(captured.graph.occurrences.length, 6);
      assert.equal(captured.graph.edges.length, languagePaths.length * 6);

      const directPathsForTarget = (path: string) => {
        const target = captured.graph.targets.find(
          ({ applicabilityPath }) => applicabilityPath === path,
        );
        assert.ok(target);
        return captured.graph.nodes
          .filter(({ directRecognitions }) =>
            directRecognitions.some(
              ({ applicableTargetId }) => applicableTargetId === target.targetId,
            ),
          )
          .map(({ resolvedPath }) => resolvedPath)
          .sort();
      };
      const baseline = directPathsForTarget(languagePaths[0] ?? "");
      for (const path of languagePaths.slice(1)) {
        assert.deepEqual(directPathsForTarget(path), baseline, `${path} changed discovery policy`);
      }
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) =>
          /(?:manual|model)\.(?:md|mdc)$/u.test(resolvedPath),
        ),
        false,
      );
      assert.deepEqual(
        new Set(captured.graph.diagnostics.map(({ code }) => code)),
        new Set(["UNSELECTED_MANUAL_MODE", "UNSELECTED_MODEL_SELECTED_MODE"]),
      );
      assert.deepEqual(rebuildInReverseOrder(snapshot.manifest, captured.graph), captured.graph);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("projects every snapshot change type and scopes cross-directory and same-directory renames", async () => {
    const repositoryPath = await initializeRepository("slice-3-relocation-");
    try {
      for (const directory of ["old", "new", "same"]) {
        await mkdir(join(repositoryPath, directory), { recursive: true });
        await writeFile(join(repositoryPath, directory, "AGENTS.md"), `# ${directory}\n`);
      }
      await writeFile(join(repositoryPath, "old", "code.ts"), "old\n");
      await writeFile(join(repositoryPath, "same", "before.ts"), "same\n");
      await commitBase(repositoryPath);
      await git(repositoryPath, "mv", "old/code.ts", "new/code.ts");
      await git(repositoryPath, "mv", "same/before.ts", "same/after.ts");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureRepositoryGuidanceV1(repositoryPath, snapshot.manifest);
      const targetShape = captured.graph.targets.map(
        ({ applicabilityPath, side, role }) => `${applicabilityPath}:${side}:${role}`,
      );
      assert.deepEqual(targetShape, [
        "new/code.ts:HEAD:PRIMARY",
        "old/code.ts:BASE:RELOCATION_SOURCE",
        "same/after.ts:HEAD:PRIMARY",
        "same/before.ts:BASE:RELOCATION_SOURCE",
      ]);
      const recognizedTargets = (resolvedPath: string) => {
        const node = captured.graph.nodes.find(
          (candidate) => candidate.resolvedPath === resolvedPath,
        );
        assert.ok(node);
        return node.directRecognitions
          .map(({ applicableTargetId, familyId }) => {
            const target = captured.graph.targets.find(
              ({ targetId }) => targetId === applicableTargetId,
            );
            assert.ok(target);
            return `${familyId}:${target.applicabilityPath}`;
          })
          .sort();
      };
      assert.deepEqual(recognizedTargets("old/AGENTS.md"), [
        "CODEX:old/code.ts",
        "COPILOT:old/code.ts",
        "KIRO:old/code.ts",
      ]);
      assert.deepEqual(recognizedTargets("new/AGENTS.md"), [
        "CODEX:new/code.ts",
        "COPILOT:new/code.ts",
        "KIRO:new/code.ts",
      ]);
      assert.deepEqual(recognizedTargets("same/AGENTS.md"), [
        "CODEX:same/after.ts",
        "CODEX:same/before.ts",
        "COPILOT:same/after.ts",
        "COPILOT:same/before.ts",
        "KIRO:same/after.ts",
        "KIRO:same/before.ts",
      ]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("projects add, copy, delete, modify, rename, type-change, and untracked entries exactly", async () => {
    const fixture = JSON.parse(
      await readFile(
        join(process.cwd(), "test", "fixtures", "snapshot-manifest.valid.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const paths = (fixture.paths as Array<Record<string, unknown>>).map((entry) =>
      structuredClone(entry),
    );
    const modified = paths[0];
    const renamed = paths[1];
    const untracked = paths[2];
    assert.ok(modified && renamed && untracked);
    const before = modified.before;
    const after = modified.after;
    const entries = [
      { ...modified, changeType: "ADDED", path: "added/file", before: null },
      { ...modified, changeType: "COPIED", path: "copy/file", previousPath: "source/file" },
      { ...modified, changeType: "DELETED", path: "deleted/file", after: null },
      { ...modified, changeType: "MODIFIED", path: "modified/file" },
      {
        ...modified,
        changeType: "RENAMED",
        path: "rename/new",
        previousPath: "rename/old",
      },
      {
        ...modified,
        changeType: "TYPE_CHANGED",
        path: "typed/file",
        before,
        after: { ...(after as Record<string, unknown>), kind: "SYMLINK", gitMode: "120000" },
      },
      { ...untracked, path: "untracked/file" },
    ];
    const { snapshotDigest: _digest, ...draft } = fixture;
    const workingTree = {
      ...(draft.workingTree as Record<string, unknown>),
      includedUntrackedPaths: ["untracked/file"],
    };
    const manifest = finalizeSnapshotManifestV1({ ...draft, workingTree, paths: entries });

    assert.deepEqual(
      projectGuidanceTargetsV1(manifest).map(({ applicabilityPath, side, role, changeType }) => ({
        applicabilityPath,
        side,
        role,
        changeType,
      })),
      [
        { applicabilityPath: "added/file", side: "HEAD", role: "PRIMARY", changeType: "ADDED" },
        { applicabilityPath: "copy/file", side: "HEAD", role: "PRIMARY", changeType: "COPIED" },
        { applicabilityPath: "deleted/file", side: "BASE", role: "PRIMARY", changeType: "DELETED" },
        {
          applicabilityPath: "modified/file",
          side: "HEAD",
          role: "PRIMARY",
          changeType: "MODIFIED",
        },
        { applicabilityPath: "rename/new", side: "HEAD", role: "PRIMARY", changeType: "RENAMED" },
        {
          applicabilityPath: "rename/old",
          side: "BASE",
          role: "RELOCATION_SOURCE",
          changeType: "RENAMED",
        },
        {
          applicabilityPath: "typed/file",
          side: "HEAD",
          role: "PRIMARY",
          changeType: "TYPE_CHANGED",
        },
        {
          applicabilityPath: "untracked/file",
          side: "HEAD",
          role: "PRIMARY",
          changeType: "UNTRACKED",
        },
      ],
    );
  });

  for (const failure of [
    {
      name: "Gemini secret-bearing import",
      expectedCode: "GUIDANCE_SECRET_CONTENT",
      forbiddenText: SECRET_SENTINEL,
      setup: async (repositoryPath: string) => {
        await mkdir(join(repositoryPath, "docs"), { recursive: true });
        await writeFile(join(repositoryPath, "GEMINI.md"), "@docs/secret.md\n");
        await writeFile(
          join(repositoryPath, "docs", "secret.md"),
          `credential ${SECRET_SENTINEL}\n`,
        );
      },
    },
    {
      name: "Kiro repository-escaping symlink import",
      expectedCode: "GUIDANCE_SYMLINK_UNSUPPORTED",
      setup: async (repositoryPath: string) => {
        await mkdir(join(repositoryPath, ".kiro", "steering"), { recursive: true });
        await writeFile(
          join(repositoryPath, ".kiro", "steering", "always.md"),
          "#[[file:../../outside-link.md]]\n",
        );
        await symlink("../outside.md", join(repositoryPath, "outside-link.md"));
      },
    },
    {
      name: "Copilot unresolved import",
      expectedCode: "GUIDANCE_IMPORT_UNRESOLVED",
      setup: async (repositoryPath: string) => {
        await mkdir(join(repositoryPath, ".github"), { recursive: true });
        await writeFile(
          join(repositoryPath, ".github", "copilot-instructions.md"),
          "@missing.md\n",
        );
      },
    },
    {
      name: "Cursor import cycle",
      expectedCode: "GUIDANCE_IMPORT_CYCLE",
      setup: async (repositoryPath: string) => {
        await mkdir(join(repositoryPath, ".cursor", "rules"), { recursive: true });
        await writeFile(
          join(repositoryPath, ".cursor", "rules", "always.mdc"),
          "---\nalwaysApply: true\n---\n@other.mdc\n",
        );
        await writeFile(join(repositoryPath, ".cursor", "rules", "other.mdc"), "@always.mdc\n");
      },
    },
  ] as const) {
    it(`fails closed for ${failure.name}`, async () => {
      const repositoryPath = await initializeRepository("slice-3-failure-");
      try {
        await mkdir(join(repositoryPath, "src"), { recursive: true });
        await writeFile(join(repositoryPath, "src", "code.ts"), "before\n");
        await failure.setup(repositoryPath);
        await commitBase(repositoryPath);
        await writeFile(join(repositoryPath, "src", "code.ts"), "after\n");
        const snapshot = await captureGitSnapshotV1(request(repositoryPath));

        await assert.rejects(
          captureRepositoryGuidanceV1(repositoryPath, snapshot.manifest),
          (error: unknown) => {
            if (!(error instanceof GuidanceCaptureError) || error.code !== failure.expectedCode) {
              return false;
            }
            if ("forbiddenText" in failure) {
              assert.equal(error.message.includes(failure.forbiddenText), false);
            }
            return true;
          },
        );
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });
  }
});
