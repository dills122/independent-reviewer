import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { captureGeminiGuidanceV1 } from "../../src/guidance/gemini-discovery.js";
import {
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
    flowId: "flow_gemini_guidance",
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
  const repositoryPath = await mkdtemp(join(tmpdir(), "gemini-guidance-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Gemini Guidance Test");
  await git(repositoryPath, "config", "user.email", "gemini-guidance@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await mkdir(join(repositoryPath, ".gemini"), { recursive: true });
  await mkdir(join(repositoryPath, "src"), { recursive: true });
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await mkdir(join(repositoryPath, "ignored"), { recursive: true });
  await writeFile(
    join(repositoryPath, ".gemini", "settings.json"),
    JSON.stringify({
      context: { fileName: ["GEMINI.md", "PROJECT.md"] },
      futureSetting: { value: "not retained in diagnostics" },
    }),
  );
  await writeFile(join(repositoryPath, ".gitignore"), "ignored/\n");
  await writeFile(join(repositoryPath, "GEMINI.md"), "# Root\n\n@docs/shared.md\n");
  await writeFile(join(repositoryPath, "src", "PROJECT.md"), "# Source\n\n@../docs/shared.md\n");
  await writeFile(join(repositoryPath, "docs", "shared.md"), "# Shared\n");
  await writeFile(join(repositoryPath, "ignored", "GEMINI.md"), "# Ignored\n");
  await writeFile(join(repositoryPath, "src", "code.ts"), "export const value = 1;\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "base");
  await git(repositoryPath, "switch", "-c", "feature/gemini-guidance");
  await writeFile(join(repositoryPath, "src", "code.ts"), "export const value = 2;\n");
  await mkdir(join(repositoryPath, "new"), { recursive: true });
  await writeFile(join(repositoryPath, "new", "GEMINI.md"), "# HEAD only\n");
  return repositoryPath;
}

describe("captureGeminiGuidanceV1", () => {
  it("discovers BASE context names, honors ignores, and expands imports", async () => {
    const repositoryPath = await repository();
    try {
      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureGeminiGuidanceV1(repositoryPath, snapshot.manifest);
      const target = captured.graph.targets.find(
        ({ applicabilityPath }) => applicabilityPath === "src/code.ts",
      );
      assert.ok(target);
      const direct = captured.graph.nodes
        .flatMap(({ directRecognitions }) => directRecognitions)
        .filter(({ applicableTargetId }) => applicableTargetId === target.targetId)
        .sort((left, right) => left.nativeOrder - right.nativeOrder);
      assert.deepEqual(
        direct.map(({ discoveredPath, nativeOrder }) => ({ discoveredPath, nativeOrder })),
        [
          { discoveredPath: "GEMINI.md", nativeOrder: 0 },
          { discoveredPath: "src/PROJECT.md", nativeOrder: 1 },
        ],
      );
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "ignored/GEMINI.md"),
        false,
      );
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "new/GEMINI.md"),
        false,
      );
      assert.equal(
        captured.graph.nodes.filter(({ resolvedPath }) => resolvedPath === "docs/shared.md").length,
        1,
      );
      assert.equal(captured.graph.occurrences.length, 2);
      assert.equal(captured.graph.edges.length, 2);
      assert.deepEqual(
        captured.graph.diagnostics.map(({ code, path }) => ({ code, path })),
        [{ code: "UNKNOWN_SETTING_IGNORED", path: ".gemini/settings.json" }],
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("resolves internal BASE symlinks for settings and ignore control files", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "add", ".");
      await git(repositoryPath, "commit", "-m", "feature changes");
      await git(repositoryPath, "switch", "main");
      await mkdir(join(repositoryPath, "config"), { recursive: true });
      await writeFile(
        join(repositoryPath, "config/gemini-settings.json"),
        JSON.stringify({ context: { fileName: ["GEMINI.md", "PROJECT.md"] } }),
      );
      await writeFile(join(repositoryPath, "config/root.gitignore"), "ignored/\n");
      await unlink(join(repositoryPath, ".gemini/settings.json"));
      await unlink(join(repositoryPath, ".gitignore"));
      await symlink(
        "../config/gemini-settings.json",
        join(repositoryPath, ".gemini/settings.json"),
      );
      await symlink("config/root.gitignore", join(repositoryPath, ".gitignore"));
      await git(repositoryPath, "add", ".");
      await git(repositoryPath, "commit", "-m", "symlink Gemini controls");
      await git(repositoryPath, "switch", "feature/gemini-guidance");
      await git(repositoryPath, "merge", "main", "--no-edit");
      await writeFile(join(repositoryPath, "src/code.ts"), "export const value = 3;\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureGeminiGuidanceV1(repositoryPath, snapshot.manifest);
      assert.ok(captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "src/PROJECT.md"));
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "ignored/GEMINI.md"),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects repository-escaping BASE symlinks for settings and ignore controls", async () => {
    for (const controlPath of [".gemini/settings.json", ".gitignore"]) {
      const repositoryPath = await repository();
      try {
        await git(repositoryPath, "add", ".");
        await git(repositoryPath, "commit", "-m", "feature changes");
        await git(repositoryPath, "switch", "main");
        await unlink(join(repositoryPath, controlPath));
        await symlink(
          controlPath.startsWith(".gemini/") ? "../../outside" : "../outside",
          join(repositoryPath, controlPath),
        );
        await git(repositoryPath, "add", ".");
        await git(repositoryPath, "commit", "-m", "escaping Gemini control");
        await git(repositoryPath, "switch", "feature/gemini-guidance");
        await git(repositoryPath, "merge", "main", "--no-edit");
        await writeFile(join(repositoryPath, "src/code.ts"), "export const value = 3;\n");

        const snapshot = await captureGitSnapshotV1(request(repositoryPath));
        await assert.rejects(
          captureGeminiGuidanceV1(repositoryPath, snapshot.manifest),
          (error: unknown) =>
            error instanceof GuidanceCaptureError && error.code === "GUIDANCE_SYMLINK_UNSUPPORTED",
        );
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    }
  });
});
