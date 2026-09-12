import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  captureCodexGuidanceV1,
  captureGitSnapshotV1,
  captureRepositoryGuidanceV1,
  GuidanceCaptureError,
  type ReviewRequestV1,
} from "../../src/index.js";

const exec = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await exec("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

function request(repositoryPath: string): ReviewRequestV1 {
  return {
    schemaVersion: 1,
    flowId: "flow_codex_guidance",
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

async function repository(includeReviewerRules = false): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "codex-guidance-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Codex Guidance Test");
  await git(repositoryPath, "config", "user.email", "codex-guidance@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await mkdir(join(repositoryPath, "src", "lib"), { recursive: true });
  await writeFile(join(repositoryPath, "AGENTS.md"), "# Root guidance\n");
  await writeFile(join(repositoryPath, "src", "AGENTS.md"), "# Replaced guidance\n");
  await writeFile(join(repositoryPath, "src", "AGENTS.override.md"), "# Source override\n");
  await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 1;\n");
  if (includeReviewerRules) {
    await mkdir(join(repositoryPath, ".independent-reviewer"), { recursive: true });
    await writeFile(
      join(repositoryPath, ".independent-reviewer", "rules.md"),
      "# Reviewer-specific guidance\n",
    );
  }
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "base");
  await git(repositoryPath, "switch", "-c", "feature/codex-guidance");
  await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 2;\n");
  return repositoryPath;
}

async function capture(repositoryPath: string) {
  const snapshot = await captureGitSnapshotV1(request(repositoryPath));
  return captureCodexGuidanceV1(repositoryPath, snapshot.manifest);
}

describe("captureCodexGuidanceV1", () => {
  it("selects one BASE instruction per ancestor with override precedence", async () => {
    const repositoryPath = await repository();
    try {
      const captured = await capture(repositoryPath);
      const paths = captured.graph.nodes.map(({ resolvedPath }) => resolvedPath).sort();
      assert.deepEqual(paths, ["AGENTS.md", "src/AGENTS.override.md"]);
      assert.equal(paths.includes("src/AGENTS.md"), false);

      const recognitions = captured.graph.nodes
        .flatMap(({ directRecognitions }) => directRecognitions)
        .sort((left, right) => left.nativeOrder - right.nativeOrder);
      assert.deepEqual(
        recognitions.map(({ sourceKind, nativeOrder, discoveredPath }) => ({
          sourceKind,
          nativeOrder,
          discoveredPath,
        })),
        [
          { sourceKind: "CODEX_AGENTS", nativeOrder: 0, discoveredPath: "AGENTS.md" },
          {
            sourceKind: "CODEX_AGENTS_OVERRIDE",
            nativeOrder: 1,
            discoveredPath: "src/AGENTS.override.md",
          },
        ],
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("combines harness and reviewer-specific guidance into one graph", async () => {
    const repositoryPath = await repository(true);
    try {
      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureRepositoryGuidanceV1(repositoryPath, snapshot.manifest);

      assert.equal(captured.graph.nodes.length, 3);
      assert.equal(captured.blobs.size, 3);
      assert.equal(
        captured.graph.nodes.filter(({ semanticTier }) => semanticTier === "REVIEWER_SPECIFIC")
          .length,
        1,
      );
      assert.deepEqual(
        captured.graph.nodes
          .flatMap(({ directRecognitions }) => directRecognitions)
          .map(({ familyId }) => familyId)
          .sort(),
        ["CODEX", "CODEX", "INDEPENDENT_REVIEWER"],
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("uses frozen BASE content and ignores HEAD-only instructions", async () => {
    const repositoryPath = await repository();
    try {
      await writeFile(join(repositoryPath, "AGENTS.md"), "# Relaxed HEAD guidance\n");
      await mkdir(join(repositoryPath, "src", "lib", "nested"), { recursive: true });
      await writeFile(
        join(repositoryPath, "src", "lib", "AGENTS.md"),
        "# HEAD-only nested guidance\n",
      );

      const captured = await capture(repositoryPath);
      assert.equal(captured.graph.nodes.length, 2);
      const root = captured.graph.nodes.find(({ resolvedPath }) => resolvedPath === "AGENTS.md");
      assert.ok(root);
      assert.equal(
        Buffer.from(captured.blobs.get(root.contentDigest.value) ?? []).toString(),
        "# Root guidance\n",
      );
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "src/lib/AGENTS.md"),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not admit a shadowed AGENTS file before override precedence", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "src", "AGENTS.md"), "x".repeat(64 * 1024 + 1));
      await git(repositoryPath, "add", "src/AGENTS.md");
      await git(repositoryPath, "commit", "-m", "oversized shadowed guidance");
      await git(repositoryPath, "switch", "-c", "feature/shadowed-guidance");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 4;\n");

      const captured = await capture(repositoryPath);
      assert.deepEqual(captured.graph.nodes.map(({ resolvedPath }) => resolvedPath).sort(), [
        "AGENTS.md",
        "src/AGENTS.override.md",
      ]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects secret-bearing applicable instructions without returning their bytes", async () => {
    const repositoryPath = await repository();
    const secretValue = `ghp_${"z".repeat(36)}`;
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "AGENTS.md"), `# Guidance\n\n${secretValue}\n`);
      await git(repositoryPath, "add", "AGENTS.md");
      await git(repositoryPath, "commit", "-m", "secret guidance");
      await git(repositoryPath, "switch", "-c", "feature/secret-guidance");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");

      await assert.rejects(capture(repositoryPath), (error: unknown) => {
        assert.ok(error instanceof GuidanceCaptureError);
        assert.equal(error.code, "GUIDANCE_SECRET_CONTENT");
        assert.equal(error.path, "AGENTS.md");
        assert.doesNotMatch(JSON.stringify(error), new RegExp(secretValue));
        return true;
      });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
