import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { captureCopilotGuidanceV1 } from "../../src/guidance/copilot-discovery.js";
import { captureGitSnapshotV1, type ReviewRequestV1 } from "../../src/index.js";

const exec = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", repositoryPath, ...args]);
}

function request(repositoryPath: string): ReviewRequestV1 {
  return {
    schemaVersion: 1,
    flowId: "flow_copilot_guidance",
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

async function repository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "copilot-guidance-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Copilot Guidance Test");
  await git(repositoryPath, "config", "user.email", "copilot-guidance@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  for (const directory of [".github/instructions", ".claude", "src/lib", "test", "docs"]) {
    await mkdir(join(repositoryPath, directory), { recursive: true });
  }
  await writeFile(
    join(repositoryPath, ".github/copilot-instructions.md"),
    "# Repository instructions\n\nRead @../docs/shared.md\n",
  );
  await writeFile(
    join(repositoryPath, ".github/instructions/src.instructions.md"),
    "---\napplyTo: 'src/**'\n---\n# Source modular\n\n@../../docs/modular-only.md\n",
  );
  await writeFile(
    join(repositoryPath, ".github/instructions/excluded.instructions.md"),
    "---\napplyTo: 'src/**'\nexcludeAgent: code-review\n---\n# Excluded\n",
  );
  await writeFile(join(repositoryPath, "AGENTS.md"), "# Root agents\n");
  await writeFile(join(repositoryPath, "src/AGENTS.md"), "# Source agents\n");
  await writeFile(join(repositoryPath, "CLAUDE.md"), "# Root Claude\n");
  await writeFile(join(repositoryPath, "src/CLAUDE.md"), "# Source Claude\n");
  await writeFile(join(repositoryPath, ".claude/CLAUDE.md"), "# Dot Claude\n");
  await writeFile(join(repositoryPath, "GEMINI.md"), "# Root Gemini\n\n@docs/gemini-only.md\n");
  await writeFile(join(repositoryPath, "src/GEMINI.md"), "# Source Gemini\n");
  await writeFile(join(repositoryPath, "docs/shared.md"), "# Shared imported guidance\n");
  await writeFile(join(repositoryPath, "docs/modular-only.md"), "# Must remain opaque\n");
  await writeFile(join(repositoryPath, "docs/gemini-only.md"), "# Must remain opaque\n");
  await writeFile(join(repositoryPath, "src/lib/code.ts"), "export const value = 1;\n");
  await writeFile(join(repositoryPath, "test/code.test.ts"), "export const testValue = 1;\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "base");
  await git(repositoryPath, "switch", "-c", "feature/copilot-guidance");
  await writeFile(join(repositoryPath, "src/lib/code.ts"), "export const value = 2;\n");
  await writeFile(join(repositoryPath, "test/code.test.ts"), "export const testValue = 2;\n");
  return repositoryPath;
}

describe("captureCopilotGuidanceV1", () => {
  it("applies documented Copilot sources in exact native order and expands allowed imports", async () => {
    const repositoryPath = await repository();
    try {
      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureCopilotGuidanceV1(repositoryPath, snapshot.manifest);
      const recognitionsFor = (applicabilityPath: string) => {
        const target = captured.graph.targets.find(
          (candidate) => candidate.applicabilityPath === applicabilityPath,
        );
        assert.ok(
          target,
          `missing ${applicabilityPath}; targets=${captured.graph.targets
            .map(({ applicabilityPath: path }) => path)
            .join(",")}`,
        );
        return captured.graph.nodes
          .flatMap(({ directRecognitions }) => directRecognitions)
          .filter(({ applicableTargetId }) => applicableTargetId === target.targetId)
          .sort((left, right) => left.nativeOrder - right.nativeOrder)
          .map(({ discoveredPath, sourceKind, nativeOrder }) => ({
            discoveredPath,
            sourceKind,
            nativeOrder,
          }));
      };

      assert.deepEqual(recognitionsFor("src/lib/code.ts"), [
        {
          discoveredPath: ".github/copilot-instructions.md",
          sourceKind: "COPILOT_REPOSITORY",
          nativeOrder: 0,
        },
        { discoveredPath: "AGENTS.md", sourceKind: "COPILOT_AGENTS", nativeOrder: 1 },
        { discoveredPath: "src/AGENTS.md", sourceKind: "COPILOT_AGENTS", nativeOrder: 2 },
        { discoveredPath: "CLAUDE.md", sourceKind: "COPILOT_CLAUDE", nativeOrder: 3 },
        { discoveredPath: "src/CLAUDE.md", sourceKind: "COPILOT_CLAUDE", nativeOrder: 4 },
        { discoveredPath: ".claude/CLAUDE.md", sourceKind: "COPILOT_DOT_CLAUDE", nativeOrder: 5 },
        { discoveredPath: "GEMINI.md", sourceKind: "COPILOT_GEMINI", nativeOrder: 6 },
        { discoveredPath: "src/GEMINI.md", sourceKind: "COPILOT_GEMINI", nativeOrder: 7 },
        {
          discoveredPath: ".github/instructions/src.instructions.md",
          sourceKind: "COPILOT_MODULAR",
          nativeOrder: 8,
        },
      ]);
      assert.deepEqual(
        recognitionsFor("test/code.test.ts").map(({ discoveredPath }) => discoveredPath),
        [
          ".github/copilot-instructions.md",
          "AGENTS.md",
          "CLAUDE.md",
          ".claude/CLAUDE.md",
          "GEMINI.md",
        ],
      );
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) =>
          resolvedPath.endsWith("excluded.instructions.md"),
        ),
        false,
      );
      assert.equal(captured.graph.occurrences.length, 1);
      assert.equal(captured.graph.edges.length, 2);
      assert.ok(captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "docs/shared.md"));
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "docs/modular-only.md"),
        false,
      );
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "docs/gemini-only.md"),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("uses frozen BASE and excludes HEAD-only Copilot files", async () => {
    const repositoryPath = await repository();
    try {
      await writeFile(
        join(repositoryPath, ".github/copilot-instructions.md"),
        "# Relaxed HEAD instructions\n",
      );
      await writeFile(
        join(repositoryPath, ".github/instructions/head-only.instructions.md"),
        "---\napplyTo: '**'\n---\n# Head only\n",
      );
      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureCopilotGuidanceV1(repositoryPath, snapshot.manifest);
      const repositoryNode = captured.graph.nodes.find(
        ({ resolvedPath }) => resolvedPath === ".github/copilot-instructions.md",
      );
      assert.ok(repositoryNode);
      assert.match(
        Buffer.from(captured.blobs.get(repositoryNode.contentDigest.value) ?? []).toString(),
        /Repository instructions/,
      );
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) =>
          resolvedPath.endsWith("head-only.instructions.md"),
        ),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
