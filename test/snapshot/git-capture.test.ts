import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { captureGitSnapshotV1, type ReviewRequestV1 } from "../../src/index.js";

const execFileAsync = promisify(execFile);

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-capture-"));
  await git(repositoryPath, "init", "--initial-branch=main");
  await git(repositoryPath, "config", "user.name", "Capture Test");
  await git(repositoryPath, "config", "user.email", "capture@example.invalid");
  await git(repositoryPath, "config", "commit.gpgsign", "false");
  await writeFile(join(repositoryPath, "modified.txt"), "before\n");
  await writeFile(join(repositoryPath, "renamed.txt"), "rename me\n");
  await writeFile(join(repositoryPath, "deleted.txt"), "delete me\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  return repositoryPath;
}

function reviewRequest(repositoryPath: string, base = "main"): ReviewRequestV1 {
  return {
    schemaVersion: 1,
    flowId: "flow_git_capture_test",
    reviewInstance: { number: 1, maximum: 3 },
    repository: {
      path: repositoryPath,
      base,
      workingTree: { mode: "CUMULATIVE", includeUntracked: true },
    },
    canonicalInputs: {
      requirements: [
        {
          id: "input_requirement",
          kind: "REQUIREMENTS",
          title: "Requirement",
          content: "Review all captured changes.",
          provenance: { type: "INLINE", label: "test requirement" },
        },
      ],
      implementationPlan: {
        id: "input_plan",
        kind: "IMPLEMENTATION_PLAN",
        title: "Plan",
        content: "Capture the Git target.",
        provenance: { type: "INLINE", label: "test plan" },
      },
      projectGuidance: [],
    },
    reviewConfigRef: "config_test",
  };
}

describe("captureGitSnapshotV1", () => {
  it("captures committed modifications, renames, deletions, and additions", async () => {
    const repositoryPath = await createRepository();
    try {
      const baseCommit = await git(repositoryPath, "rev-parse", "HEAD");
      await git(repositoryPath, "switch", "-c", "feature/capture");
      await writeFile(join(repositoryPath, "modified.txt"), "after\n");
      await git(repositoryPath, "mv", "renamed.txt", "current-name.txt");
      await rm(join(repositoryPath, "deleted.txt"));
      await writeFile(join(repositoryPath, "added.txt"), "added\n");
      await git(repositoryPath, "add", ".");
      await git(repositoryPath, "commit", "-m", "change files");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath));
      const byPath = new Map(captured.manifest.paths.map((entry) => [entry.path, entry]));

      assert.equal(captured.manifest.source.baseCommit, baseCommit);
      assert.equal(
        captured.manifest.source.headCommit,
        await git(repositoryPath, "rev-parse", "HEAD"),
      );
      assert.equal(captured.manifest.source.branch, "feature/capture");
      assert.equal(byPath.get("modified.txt")?.changeType, "MODIFIED");
      assert.equal(byPath.get("current-name.txt")?.changeType, "RENAMED");
      assert.equal(byPath.get("deleted.txt")?.changeType, "DELETED");
      assert.equal(byPath.get("added.txt")?.changeType, "ADDED");
      assert.equal(captured.manifest.workingTree.hasStagedChanges, false);
      assert.equal(captured.manifest.workingTree.hasUnstagedChanges, false);
      assert.equal(captured.manifest.workingTree.includedUntrackedPaths.length, 0);
      assert.equal(captured.blobs.size, 5);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("captures staged, unstaged, and untracked changes cumulatively", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/dirty");
      await writeFile(join(repositoryPath, "modified.txt"), "staged\n");
      await git(repositoryPath, "add", "modified.txt");
      await writeFile(join(repositoryPath, "modified.txt"), "unstaged after staged\n");
      await writeFile(join(repositoryPath, "new.txt"), "untracked\n");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath));
      const modified = captured.manifest.paths.find((entry) => entry.path === "modified.txt");
      const untracked = captured.manifest.paths.find((entry) => entry.path === "new.txt");

      assert.equal(captured.manifest.workingTree.hasStagedChanges, true);
      assert.equal(captured.manifest.workingTree.hasUnstagedChanges, true);
      assert.deepEqual(captured.manifest.workingTree.includedUntrackedPaths, ["new.txt"]);
      assert.equal(modified?.changeType, "MODIFIED");
      assert.equal(untracked?.changeType, "UNTRACKED");
      assert.equal(untracked?.after?.kind, "TEXT");
      assert.equal(captured.manifest.raceCheck.status, "STABLE");
      assert.equal(
        captured.manifest.raceCheck.beforeStateDigest.value,
        captured.manifest.raceCheck.afterStateDigest.value,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("makes secret-policy and size exclusions visible without storing their bytes", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/exclusions");
      await writeFile(join(repositoryPath, ".env.production"), "API_KEY=do-not-store\n");
      await writeFile(join(repositoryPath, "large.txt"), "x".repeat(33));

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath), {
        maxFileBytes: 32,
      });

      assert.deepEqual(
        captured.manifest.exclusions.map(({ path, reason }) => ({ path, reason })),
        [
          { path: ".env.production", reason: "SECRET_POLICY" },
          { path: "large.txt", reason: "SIZE_LIMIT" },
        ],
      );
      assert.equal(captured.manifest.paths.length, 0);
      assert.equal(captured.blobs.size, 0);
      assert.equal(
        [...captured.blobs.values()].some((bytes) =>
          Buffer.from(bytes).includes(Buffer.from("do-not-store")),
        ),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("assigns distinct fallback identities to repositories without remotes", async () => {
    const firstRepository = await createRepository();
    const secondRepository = await createRepository();
    try {
      const first = await captureGitSnapshotV1(reviewRequest(firstRepository));
      const second = await captureGitSnapshotV1(reviewRequest(secondRepository));

      assert.notEqual(first.manifest.source.repositoryId, second.manifest.source.repositoryId);
    } finally {
      await rm(firstRepository, { recursive: true, force: true });
      await rm(secondRepository, { recursive: true, force: true });
    }
  });
});
