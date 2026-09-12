import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  captureClaudeGuidanceV1,
  captureGitSnapshotV1,
  GuidanceCaptureError,
  type ReviewRequestV1,
} from "../../src/index.js";

const exec = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<void> {
  await exec("git", ["-C", repositoryPath, ...args]);
}

function request(repositoryPath: string): ReviewRequestV1 {
  return {
    schemaVersion: 1,
    flowId: "flow_claude_guidance",
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
  const repositoryPath = await mkdtemp(join(tmpdir(), "claude-guidance-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Claude Guidance Test");
  await git(repositoryPath, "config", "user.email", "claude-guidance@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await mkdir(join(repositoryPath, "src", "lib"), { recursive: true });
  await mkdir(join(repositoryPath, "test"), { recursive: true });
  await mkdir(join(repositoryPath, ".claude", "rules"), { recursive: true });
  await writeFile(join(repositoryPath, "CLAUDE.md"), "# Root Claude\n");
  await writeFile(join(repositoryPath, "src", "CLAUDE.md"), "# Source Claude\n");
  await writeFile(join(repositoryPath, ".claude", "CLAUDE.md"), "# Dot Claude\n");
  await writeFile(join(repositoryPath, ".claude", "rules", "all.md"), "# All\n");
  await writeFile(
    join(repositoryPath, ".claude", "rules", "docs.md"),
    "---\npaths: [docs/**]\n---\n# Documentation rule\n",
  );
  await writeFile(
    join(repositoryPath, ".claude", "rules", "ignored.txt"),
    "x".repeat(64 * 1024 + 1),
  );
  await writeFile(
    join(repositoryPath, ".claude", "rules", "src.md"),
    "---\npaths: [src/**]\n---\n# Source rule\n",
  );
  await writeFile(
    join(repositoryPath, ".claude", "rules", "tests.md"),
    "---\npaths: [test/**]\n---\n# Test rule\n",
  );
  await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 1;\n");
  await writeFile(join(repositoryPath, "test", "code.test.ts"), "export const testValue = 1;\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "base");
  await git(repositoryPath, "switch", "-c", "feature/claude-guidance");
  await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 2;\n");
  await writeFile(join(repositoryPath, "test", "code.test.ts"), "export const testValue = 2;\n");
  return repositoryPath;
}

describe("captureClaudeGuidanceV1", () => {
  it("applies ancestor, dot-directory, and conditional rule sources in native order", async () => {
    const repositoryPath = await repository();
    try {
      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureClaudeGuidanceV1(repositoryPath, snapshot.manifest);
      const recognitionsFor = (applicabilityPath: string) => {
        const target = captured.graph.targets.find(
          (candidate) => candidate.applicabilityPath === applicabilityPath,
        );
        assert.ok(target);
        return captured.graph.nodes
          .flatMap(({ directRecognitions }) => directRecognitions)
          .filter(({ applicableTargetId }) => applicableTargetId === target.targetId)
          .sort((left, right) => left.nativeOrder - right.nativeOrder)
          .map(({ discoveredPath }) => discoveredPath);
      };

      assert.deepEqual(recognitionsFor("src/lib/code.ts"), [
        "CLAUDE.md",
        "src/CLAUDE.md",
        ".claude/CLAUDE.md",
        ".claude/rules/all.md",
        ".claude/rules/src.md",
      ]);
      assert.deepEqual(recognitionsFor("test/code.test.ts"), [
        "CLAUDE.md",
        ".claude/CLAUDE.md",
        ".claude/rules/all.md",
        ".claude/rules/tests.md",
      ]);
      assert.equal(captured.graph.nodes.length, 6);
      assert.equal(captured.blobs.size, 6);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("fails closed on malformed recognized rule frontmatter", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(
        join(repositoryPath, ".claude", "rules", "bad.md"),
        "---\npaths: src/**\n---\n",
      );
      await git(repositoryPath, "add", ".claude/rules/bad.md");
      await git(repositoryPath, "commit", "-m", "bad rule");
      await git(repositoryPath, "switch", "-c", "feature/bad-rule");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      await assert.rejects(
        captureClaudeGuidanceV1(repositoryPath, snapshot.manifest),
        (error: unknown) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_INVALID_FRONTMATTER",
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
