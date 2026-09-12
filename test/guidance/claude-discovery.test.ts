import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  captureClaudeGuidanceV1,
  captureGitSnapshotV1,
  captureRepositoryGuidanceV1,
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
  await mkdir(join(repositoryPath, "docs"), { recursive: true });
  await mkdir(join(repositoryPath, "config"), { recursive: true });
  await mkdir(join(repositoryPath, ".claude", "rules"), { recursive: true });
  await writeFile(
    join(repositoryPath, "CLAUDE.md"),
    "# Root Claude\n\nRead @docs/shared.md and @config/nested.md.\n",
  );
  await writeFile(join(repositoryPath, "docs", "shared.md"), "# Shared\n\n@../common.md\n");
  await writeFile(join(repositoryPath, "config", "nested.md"), "# Nested\n");
  await writeFile(join(repositoryPath, "common.md"), "# Common\n");
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
      assert.equal(captured.graph.nodes.length, 9);
      assert.equal(captured.blobs.size, 9);
      assert.equal(captured.graph.occurrences.length, 3);
      assert.equal(captured.graph.edges.length, 6);
      for (const path of ["docs/shared.md", "config/nested.md", "common.md"]) {
        const imported = captured.graph.nodes.find(({ resolvedPath }) => resolvedPath === path);
        assert.ok(imported);
        assert.deepEqual(imported.directRecognitions, []);
        assert.equal(imported.applicableTargetIds.length, 2);
      }

      const combined = await captureRepositoryGuidanceV1(repositoryPath, snapshot.manifest);
      assert.equal(combined.graph.occurrences.length, 3);
      assert.equal(combined.graph.edges.length, 6);
      assert.deepEqual(combined.graph, captured.graph);
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

  it("fails closed on a reachable import cycle", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "common.md"), "@CLAUDE.md\n");
      await git(repositoryPath, "add", "common.md");
      await git(repositoryPath, "commit", "-m", "cyclic import");
      await git(repositoryPath, "switch", "-c", "feature/cyclic-import");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      await assert.rejects(
        captureClaudeGuidanceV1(repositoryPath, snapshot.manifest),
        (error: unknown) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_IMPORT_CYCLE",
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("resolves imports only from frozen BASE, never a HEAD-only file", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "CLAUDE.md"), "Read @docs/head-only.md\n");
      await git(repositoryPath, "add", "CLAUDE.md");
      await git(repositoryPath, "commit", "-m", "reference missing guidance");
      await git(repositoryPath, "switch", "-c", "feature/head-only-import");
      await writeFile(join(repositoryPath, "docs", "head-only.md"), "# Untrusted HEAD guidance\n");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      await assert.rejects(
        captureClaudeGuidanceV1(repositoryPath, snapshot.manifest),
        (error: unknown) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_IMPORT_UNRESOLVED",
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("applies secret policy before capturing an imported BASE file", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "CLAUDE.md"), "Read @.env.production\n");
      await writeFile(join(repositoryPath, ".env.production"), "SECRET_DO_NOT_EXPOSE\n");
      await git(repositoryPath, "add", "CLAUDE.md", ".env.production");
      await git(repositoryPath, "commit", "-m", "reference secret guidance");
      await git(repositoryPath, "switch", "-c", "feature/secret-import");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      await assert.rejects(
        captureClaudeGuidanceV1(repositoryPath, snapshot.manifest),
        (error: unknown) => {
          assert.ok(error instanceof GuidanceCaptureError);
          assert.equal(error.code, "GUIDANCE_SECRET_PATH");
          assert.doesNotMatch(error.message, /SECRET_DO_NOT_EXPOSE/);
          return true;
        },
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("merges one file reached directly and through an import into one source node", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "CLAUDE.md"), "Read @src/CLAUDE.md\n");
      await git(repositoryPath, "add", "CLAUDE.md");
      await git(repositoryPath, "commit", "-m", "import nested direct guidance");
      await git(repositoryPath, "switch", "-c", "feature/merged-import");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");
      await writeFile(
        join(repositoryPath, "test", "code.test.ts"),
        "export const testValue = 3;\n",
      );

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureClaudeGuidanceV1(repositoryPath, snapshot.manifest);
      const nested = captured.graph.nodes.filter(
        ({ resolvedPath }) => resolvedPath === "src/CLAUDE.md",
      );
      assert.equal(nested.length, 1);
      assert.equal(nested[0]?.directRecognitions.length, 1);
      assert.equal(nested[0]?.applicableTargetIds.length, 2);
      assert.equal(captured.graph.occurrences.length, 1);
      assert.equal(captured.graph.edges.length, 2);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("follows repository-internal import symlinks through frozen BASE", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "CLAUDE.md"), "Read @guidance-link.md\n");
      await symlink("docs/shared.md", join(repositoryPath, "guidance-link.md"));
      await git(repositoryPath, "add", "CLAUDE.md", "guidance-link.md");
      await git(repositoryPath, "commit", "-m", "add guidance symlink");
      await git(repositoryPath, "switch", "-c", "feature/symlink-import");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      const captured = await captureClaudeGuidanceV1(repositoryPath, snapshot.manifest);
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "guidance-link.md"),
        false,
      );
      assert.equal(
        captured.graph.nodes.some(({ resolvedPath }) => resolvedPath === "docs/shared.md"),
        true,
      );
      assert.equal(captured.graph.occurrences.length, 2);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("rejects an imported BASE symlink that escapes the repository", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "CLAUDE.md"), "Read @external-link.md\n");
      await symlink("../outside.md", join(repositoryPath, "external-link.md"));
      await git(repositoryPath, "add", "CLAUDE.md", "external-link.md");
      await git(repositoryPath, "commit", "-m", "add external guidance symlink");
      await git(repositoryPath, "switch", "-c", "feature/external-symlink-import");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");

      const snapshot = await captureGitSnapshotV1(request(repositoryPath));
      await assert.rejects(
        captureClaudeGuidanceV1(repositoryPath, snapshot.manifest),
        (error: unknown) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_SYMLINK_UNSUPPORTED",
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("allows four import hops and fails closed before a fifth", async () => {
    const repositoryPath = await repository();
    try {
      await git(repositoryPath, "switch", "main");
      await mkdir(join(repositoryPath, "chain"), { recursive: true });
      await writeFile(join(repositoryPath, "CLAUDE.md"), "@chain/one.md\n");
      await writeFile(join(repositoryPath, "chain", "one.md"), "@two.md\n");
      await writeFile(join(repositoryPath, "chain", "two.md"), "@three.md\n");
      await writeFile(join(repositoryPath, "chain", "three.md"), "@four.md\n");
      await writeFile(join(repositoryPath, "chain", "four.md"), "# Fourth hop\n");
      await git(repositoryPath, "add", "CLAUDE.md", "chain");
      await git(repositoryPath, "commit", "-m", "add bounded import chain");
      await git(repositoryPath, "switch", "-c", "feature/four-import-hops");
      await writeFile(join(repositoryPath, "src", "lib", "code.ts"), "export const value = 3;\n");

      const allowedSnapshot = await captureGitSnapshotV1(request(repositoryPath));
      const allowed = await captureClaudeGuidanceV1(repositoryPath, allowedSnapshot.manifest);
      assert.equal(allowed.graph.occurrences.length, 4);

      await git(repositoryPath, "switch", "main");
      await writeFile(join(repositoryPath, "chain", "four.md"), "@five.md\n");
      await writeFile(join(repositoryPath, "chain", "five.md"), "# Fifth hop\n");
      await git(repositoryPath, "add", "chain/four.md", "chain/five.md");
      await git(repositoryPath, "commit", "-m", "exceed bounded import chain");
      await git(repositoryPath, "switch", "-c", "feature/five-import-hops");

      const rejectedSnapshot = await captureGitSnapshotV1(request(repositoryPath));
      await assert.rejects(
        captureClaudeGuidanceV1(repositoryPath, rejectedSnapshot.manifest),
        (error: unknown) =>
          error instanceof GuidanceCaptureError && error.code === "GUIDANCE_IMPORT_DEPTH_LIMIT",
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
