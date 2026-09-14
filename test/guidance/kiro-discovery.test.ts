import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { captureKiroGuidanceV1 } from "../../src/guidance/kiro-discovery.js";
import { captureGitSnapshotV1, type ReviewRequestV1 } from "../../src/index.js";

const exec = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", repositoryPath, ...args]);
}

function request(repositoryPath: string): ReviewRequestV1 {
  return {
    schemaVersion: 1,
    flowId: "flow_kiro_guidance",
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
  const repositoryPath = await mkdtemp(join(tmpdir(), "kiro-guidance-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Kiro Guidance Test");
  await git(repositoryPath, "config", "user.email", "kiro-guidance@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await mkdir(join(repositoryPath, ".kiro", "steering"), { recursive: true });
  await mkdir(join(repositoryPath, "src"), { recursive: true });
  await mkdir(join(repositoryPath, "test"), { recursive: true });
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await writeFile(join(repositoryPath, "AGENTS.md"), "# Root agents\n");
  await writeFile(join(repositoryPath, "src", "AGENTS.md"), "# Source agents\n");
  await writeFile(
    join(repositoryPath, ".kiro", "steering", "all.md"),
    "# All\n\n#[[file:../../docs/shared.md]]\n",
  );
  await writeFile(
    join(repositoryPath, ".kiro", "steering", "src.md"),
    "---\ninclusion: fileMatch\nfileMatchPattern: src/**\n---\n# Source\n",
  );
  await writeFile(
    join(repositoryPath, ".kiro", "steering", "test.md"),
    "---\ninclusion: fileMatch\nfileMatchPattern: test/**\n---\n# Test\n",
  );
  await writeFile(
    join(repositoryPath, ".kiro", "steering", "manual.md"),
    `---\ninclusion: manual\n---\n# Manual\n\nAKIAABCDEFGHIJKLMNOP\n${"x".repeat(64 * 1024)}\n`,
  );
  await writeFile(
    join(repositoryPath, ".kiro", "steering", "auto.md"),
    `---\ninclusion: auto\n---\n# Auto\n\nAKIAABCDEFGHIJKLMNOP\n${"x".repeat(64 * 1024)}\n`,
  );
  await writeFile(join(repositoryPath, "docs", "shared.md"), "# Shared\n");
  await writeFile(join(repositoryPath, "src", "code.ts"), "export const value = 1;\n");
  await writeFile(join(repositoryPath, "test", "code.test.ts"), "export const testValue = 1;\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "base");
  await git(repositoryPath, "switch", "-c", "feature/kiro-guidance");
  await writeFile(join(repositoryPath, "src", "code.ts"), "export const value = 2;\n");
  await writeFile(join(repositoryPath, "test", "code.test.ts"), "export const testValue = 2;\n");
  await writeFile(join(repositoryPath, ".kiro", "steering", "head-only.md"), "# Head only\n");
  return repositoryPath;
}

describe("captureKiroGuidanceV1", () => {
  it("scopes AGENTS and steering, excludes dynamic modes, and expands references", async () => {
    const repositoryPath = await repository();
    try {
      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureKiroGuidanceV1(repositoryPath, snapshot.manifest);
      const recognitionsFor = (path: string) => {
        const target = captured.graph.targets.find(
          ({ applicabilityPath }) => applicabilityPath === path,
        );
        assert.ok(target);
        return captured.graph.nodes
          .flatMap(({ directRecognitions }) => directRecognitions)
          .filter(({ applicableTargetId }) => applicableTargetId === target.targetId)
          .sort((left, right) => left.nativeOrder - right.nativeOrder)
          .map(({ discoveredPath }) => discoveredPath);
      };
      assert.deepEqual(recognitionsFor("src/code.ts"), [
        "AGENTS.md",
        "src/AGENTS.md",
        ".kiro/steering/all.md",
        ".kiro/steering/src.md",
      ]);
      assert.deepEqual(recognitionsFor("test/code.test.ts"), [
        "AGENTS.md",
        ".kiro/steering/all.md",
        ".kiro/steering/test.md",
      ]);
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath.endsWith("head-only.md")),
        false,
      );
      assert.equal(
        captured.graph.nodes.filter(({ resolvedPath }) => resolvedPath === "docs/shared.md").length,
        1,
      );
      assert.equal(captured.graph.occurrences.length, 1);
      assert.equal(captured.graph.edges.length, 2);
      assert.deepEqual(
        captured.graph.diagnostics.map(({ code, path }) => ({ code, path })),
        [
          { code: "UNSELECTED_MANUAL_MODE", path: ".kiro/steering/manual.md" },
          { code: "UNSELECTED_MODEL_SELECTED_MODE", path: ".kiro/steering/auto.md" },
        ],
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
