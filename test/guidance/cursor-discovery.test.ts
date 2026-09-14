import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { captureCursorGuidanceV1 } from "../../src/guidance/cursor-discovery.js";
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
    flowId: "flow_cursor_guidance",
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

async function repository(matchingFailure?: "SECRET" | "SIZE"): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "cursor-guidance-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Cursor Guidance Test");
  await git(repositoryPath, "config", "user.email", "cursor-guidance@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  for (const directory of [".cursor/rules", "src/.cursor/rules", "src/lib", "test", "docs"]) {
    await mkdir(join(repositoryPath, directory), { recursive: true });
  }
  await writeFile(
    join(repositoryPath, ".cursor/rules/always.mdc"),
    "---\nalwaysApply: true\n---\n# Always\n\n@../../docs/shared.md\n",
  );
  await writeFile(
    join(repositoryPath, ".cursor/rules/src.mdc"),
    `---\nglobs: ['src/**']\nalwaysApply: false\n---\n# Source\n${
      matchingFailure === "SECRET"
        ? "AKIAABCDEFGHIJKLMNOP\n"
        : matchingFailure === "SIZE"
          ? `${"x".repeat(64 * 1024)}\n`
          : ""
    }`,
  );
  await writeFile(
    join(repositoryPath, ".cursor/rules/docs-secret.mdc"),
    "---\nglobs: ['docs/**']\nalwaysApply: false\n---\nAKIAABCDEFGHIJKLMNOP\n",
  );
  await writeFile(
    join(repositoryPath, ".cursor/rules/config-size.mdc"),
    `---\nglobs: ['config/**']\nalwaysApply: false\n---\n${"x".repeat(64 * 1024)}\n`,
  );
  await writeFile(
    join(repositoryPath, ".cursor/rules/assets-utf8.mdc"),
    Buffer.concat([
      Buffer.from("---\nglobs: ['assets/**']\nalwaysApply: false\n---\n"),
      Buffer.from([0xff]),
    ]),
  );
  await writeFile(
    join(repositoryPath, ".cursor/rules/model-selected.mdc"),
    `---\ndescription: Apply when relevant\nalwaysApply: false\n---\n# Agent requested\n\nAKIAABCDEFGHIJKLMNOP\n${"x".repeat(64 * 1024)}\n`,
  );
  await writeFile(
    join(repositoryPath, ".cursor/rules/manual.mdc"),
    `---\nalwaysApply: false\n---\n# Manual\n\nAKIAABCDEFGHIJKLMNOP\n${"x".repeat(64 * 1024)}\n`,
  );
  await writeFile(
    join(repositoryPath, "src/.cursor/rules/nested.mdc"),
    "---\nalwaysApply: true\n---\n# Nested\n",
  );
  await writeFile(join(repositoryPath, "docs/shared.md"), "# Shared\n");
  await writeFile(join(repositoryPath, "src/lib/code.ts"), "export const value = 1;\n");
  await writeFile(join(repositoryPath, "test/code.test.ts"), "export const testValue = 1;\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "base");
  await git(repositoryPath, "switch", "-c", "feature/cursor-guidance");
  await writeFile(join(repositoryPath, "src/lib/code.ts"), "export const value = 2;\n");
  await writeFile(join(repositoryPath, "test/code.test.ts"), "export const testValue = 2;\n");
  return repositoryPath;
}

describe("captureCursorGuidanceV1", () => {
  it("applies always and glob-attached rules within nested scope", async () => {
    const repositoryPath = await repository();
    try {
      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureCursorGuidanceV1(repositoryPath, snapshot.manifest);
      const pathsFor = (applicabilityPath: string) => {
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
          .map(({ discoveredPath }) => discoveredPath);
      };

      assert.deepEqual(pathsFor("src/lib/code.ts"), [
        ".cursor/rules/always.mdc",
        ".cursor/rules/src.mdc",
        "src/.cursor/rules/nested.mdc",
      ]);
      assert.deepEqual(pathsFor("test/code.test.ts"), [".cursor/rules/always.mdc"]);
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) =>
          resolvedPath.endsWith("model-selected.mdc"),
        ),
        false,
      );
      assert.ok(
        captured.graph.diagnostics.some(
          ({ code, path }) =>
            code === "UNSELECTED_MODEL_SELECTED_MODE" &&
            path === ".cursor/rules/model-selected.mdc",
        ),
      );
      assert.ok(
        captured.graph.diagnostics.some(
          ({ code, path }) =>
            code === "UNSELECTED_MANUAL_MODE" && path === ".cursor/rules/manual.mdc",
        ),
      );
      for (const path of [
        ".cursor/rules/docs-secret.mdc",
        ".cursor/rules/config-size.mdc",
        ".cursor/rules/assets-utf8.mdc",
      ]) {
        assert.equal(
          captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === path),
          false,
        );
      }
      assert.equal(captured.graph.occurrences.length, 1);
      assert.equal(captured.graph.edges.length, 2);
      for (const bytes of captured.blobs.values()) {
        assert.ok(bytes.length <= 64 * 1024);
        assert.doesNotMatch(new TextDecoder("utf-8", { fatal: true }).decode(bytes), /AKIA/);
      }
      assert.ok(captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "docs/shared.md"));
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  for (const failure of [
    { name: "secret content", input: "SECRET", code: "GUIDANCE_SECRET_CONTENT" },
    { name: "oversized content", input: "SIZE", code: "GUIDANCE_SOURCE_SIZE_LIMIT" },
  ] as const) {
    it(`still rejects matching Cursor rules with ${failure.name}`, async () => {
      const repositoryPath = await repository(failure.input);
      try {
        const snapshot = await captureGitSnapshotV1(request(repositoryPath));
        await assert.rejects(
          captureCursorGuidanceV1(repositoryPath, snapshot.manifest),
          (error: unknown) => {
            assert.ok(error instanceof GuidanceCaptureError);
            assert.equal(error.code, failure.code);
            assert.equal(error.path, ".cursor/rules/src.mdc");
            assert.doesNotMatch(error.message, /AKIAABCDEFGHIJKLMNOP/);
            return true;
          },
        );
      } finally {
        await rm(repositoryPath, { recursive: true, force: true });
      }
    });
  }

  it("resolves a direct repository-internal BASE symlink and retains its discovered path", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "add", ".");
      await git(repositoryPath, "commit", "-m", "feature changes");
      await git(repositoryPath, "switch", "main");
      await writeFile(
        join(repositoryPath, "docs/symlinked-rule.mdc"),
        "---\nalwaysApply: true\n---\n# Symlinked rule\n",
      );
      await symlink(
        "../../docs/symlinked-rule.mdc",
        join(repositoryPath, ".cursor/rules/link.mdc"),
      );
      await git(repositoryPath, "add", ".");
      await git(repositoryPath, "commit", "-m", "add direct Cursor symlink");
      await git(repositoryPath, "switch", "feature/cursor-guidance");
      await git(repositoryPath, "merge", "main", "--no-edit");
      await writeFile(join(repositoryPath, "src/lib/code.ts"), "export const value = 3;\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureCursorGuidanceV1(repositoryPath, snapshot.manifest);
      const node = captured.graph.nodes.find(
        ({ resolvedPath }) => resolvedPath === "docs/symlinked-rule.mdc",
      );
      assert.ok(node);
      assert.ok(
        node.directRecognitions.some(
          ({ discoveredPath }) => discoveredPath === ".cursor/rules/link.mdc",
        ),
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not apply nested rules outside their enclosing directory", async () => {
    const repositoryPath = await repository();
    try {
      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureCursorGuidanceV1(repositoryPath, snapshot.manifest);
      const nested = captured.graph.nodes.find(
        ({ resolvedPath }) => resolvedPath === "src/.cursor/rules/nested.mdc",
      );
      assert.ok(nested);
      const applicablePaths = nested.applicableTargetIds.map((targetId) => {
        const target = captured.graph.targets.find((candidate) => candidate.targetId === targetId);
        assert.ok(target);
        return target.applicabilityPath;
      });
      assert.deepEqual(applicablePaths, ["src/lib/code.ts"]);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
