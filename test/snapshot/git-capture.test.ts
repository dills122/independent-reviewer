import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { captureGitSnapshotV1, type ReviewRequestV1 } from "../../src/index.js";

const execFileAsync = promisify(execFile);
const syntheticAwsAccessKeyId = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const syntheticOpenSshPrivateKeyHeader = ["-----BEGIN OPENSSH", " PRIVATE KEY-----"].join("");

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
  await writeFile(join(repositoryPath, "modified.ts"), "before\n");
  await writeFile(join(repositoryPath, "renamed.ts"), "rename me\n");
  await writeFile(join(repositoryPath, "deleted.ts"), "delete me\n");
  await git(repositoryPath, "add", ".");
  await git(repositoryPath, "commit", "-m", "initial");
  return repositoryPath;
}

function reviewRequest(repositoryPath: string, base?: string): ReviewRequestV1 {
  return {
    schemaVersion: 1,
    flowId: "flow_git_capture_test",
    reviewInstance: { number: 1, maximum: 3 },
    repository: {
      path: repositoryPath,
      ...(base ? { base } : {}),
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
      await writeFile(join(repositoryPath, "modified.ts"), "after\n");
      await git(repositoryPath, "mv", "renamed.ts", "current-name.ts");
      await rm(join(repositoryPath, "deleted.ts"));
      await writeFile(join(repositoryPath, "added.ts"), "added\n");
      await git(repositoryPath, "add", ".");
      await git(repositoryPath, "commit", "-m", "change files");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const repeated = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const byPath = new Map(captured.manifest.paths.map((entry) => [entry.path, entry]));

      assert.equal(captured.manifest.source.baseCommit, baseCommit);
      assert.equal(
        captured.manifest.source.headCommit,
        await git(repositoryPath, "rev-parse", "HEAD"),
      );
      assert.equal(captured.manifest.source.branch, "feature/capture");
      assert.equal(byPath.get("modified.ts")?.changeType, "MODIFIED");
      assert.equal(byPath.get("current-name.ts")?.changeType, "RENAMED");
      assert.equal(byPath.get("deleted.ts")?.changeType, "DELETED");
      assert.equal(byPath.get("added.ts")?.changeType, "ADDED");
      assert.equal(captured.manifest.workingTree.hasStagedChanges, false);
      assert.equal(captured.manifest.workingTree.hasUnstagedChanges, false);
      assert.equal(captured.manifest.workingTree.includedUntrackedPaths.length, 0);
      assert.equal(captured.blobs.size, 5);
      assert.equal(captured.manifest.snapshotDigest.value, repeated.manifest.snapshotDigest.value);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("captures staged, unstaged, and untracked changes cumulatively", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/dirty");
      await writeFile(join(repositoryPath, "modified.ts"), "staged\n");
      await git(repositoryPath, "add", "modified.ts");
      await writeFile(join(repositoryPath, "modified.ts"), "unstaged after staged\n");
      await writeFile(join(repositoryPath, "new.ts"), "untracked\n");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const modified = captured.manifest.paths.find((entry) => entry.path === "modified.ts");
      const untracked = captured.manifest.paths.find((entry) => entry.path === "new.ts");

      assert.equal(captured.manifest.workingTree.hasStagedChanges, true);
      assert.equal(captured.manifest.workingTree.hasUnstagedChanges, true);
      assert.deepEqual(captured.manifest.workingTree.includedUntrackedPaths, ["new.ts"]);
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

  it("reconciles a staged deletion and changed unstaged recreation into one modification", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/recreated");
      await git(repositoryPath, "rm", "modified.ts");
      await writeFile(join(repositoryPath, "modified.ts"), "recreated\n");
      const statusBefore = await git(repositoryPath, "status", "--short");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const entries = captured.manifest.paths.filter((entry) => entry.path === "modified.ts");

      assert.equal(entries.length, 1);
      const entry = entries[0];
      assert.ok(entry?.before?.digest && entry.after?.digest);
      assert.equal(entry.changeType, "MODIFIED");
      assert.notEqual(entry.before.digest.value, entry.after.digest.value);
      assert.equal(captured.manifest.workingTree.hasStagedChanges, true);
      assert.equal(captured.manifest.workingTree.hasUnstagedChanges, false);
      assert.deepEqual(captured.manifest.workingTree.includedUntrackedPaths, []);
      assert.equal(await git(repositoryPath, "status", "--short"), statusBefore);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("omits a byte-identical recreation from the net base-to-working-tree changes", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/recreated-identical");
      await git(repositoryPath, "rm", "modified.ts");
      await writeFile(join(repositoryPath, "modified.ts"), "before\n");
      const statusBefore = await git(repositoryPath, "status", "--short");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));

      assert.equal(
        captured.manifest.paths.some((entry) => entry.path === "modified.ts"),
        false,
      );
      assert.equal(captured.manifest.workingTree.hasStagedChanges, true);
      assert.equal(captured.manifest.workingTree.hasUnstagedChanges, false);
      assert.deepEqual(captured.manifest.workingTree.includedUntrackedPaths, []);
      assert.equal(await git(repositoryPath, "status", "--short"), statusBefore);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("captures a staged deletion recreated as a symlink as one type change", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/recreated-symlink");
      await git(repositoryPath, "rm", "modified.ts");
      await symlink("renamed.ts", join(repositoryPath, "modified.ts"));
      const statusBefore = await git(repositoryPath, "status", "--short");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const entries = captured.manifest.paths.filter((entry) => entry.path === "modified.ts");

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.changeType, "TYPE_CHANGED");
      assert.equal(entries[0]?.before?.kind, "TEXT");
      assert.equal(entries[0]?.after?.kind, "SYMLINK");
      assert.equal(captured.manifest.workingTree.hasStagedChanges, true);
      assert.equal(captured.manifest.workingTree.hasUnstagedChanges, false);
      assert.deepEqual(captured.manifest.workingTree.includedUntrackedPaths, []);
      assert.equal(await git(repositoryPath, "status", "--short"), statusBefore);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("makes secret-policy and size exclusions visible without storing their bytes", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/exclusions");
      await writeFile(join(repositoryPath, ".env.production"), "API_KEY=do-not-store\n");
      await writeFile(join(repositoryPath, "large.ts"), "x".repeat(33));

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"), {
        maxFileBytes: 32,
      });

      assert.deepEqual(
        captured.manifest.exclusions.map(({ path, reason }) => ({ path, reason })),
        [
          { path: ".env.production", reason: "SECRET_POLICY" },
          { path: "large.ts", reason: "SIZE_LIMIT" },
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
      const first = await captureGitSnapshotV1(reviewRequest(firstRepository, "main"));
      const second = await captureGitSnapshotV1(reviewRequest(secondRepository, "main"));

      assert.notEqual(first.manifest.source.repositoryId, second.manifest.source.repositoryId);
    } finally {
      await rm(firstRepository, { recursive: true, force: true });
      await rm(secondRepository, { recursive: true, force: true });
    }
  });

  it("uses the remote default when the current upstream is the feature branch", async () => {
    const repositoryPath = await createRepository();
    try {
      const mainCommit = await git(repositoryPath, "rev-parse", "main");
      await git(repositoryPath, "remote", "add", "origin", repositoryPath);
      await git(repositoryPath, "update-ref", "refs/remotes/origin/main", mainCommit);
      await git(
        repositoryPath,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
      );
      await git(repositoryPath, "switch", "-c", "feature/default-base");
      await writeFile(join(repositoryPath, "modified.ts"), "feature change\n");
      await git(repositoryPath, "add", ".");
      await git(repositoryPath, "commit", "-m", "feature change");
      const featureCommit = await git(repositoryPath, "rev-parse", "HEAD");
      await git(
        repositoryPath,
        "update-ref",
        "refs/remotes/origin/feature/default-base",
        featureCommit,
      );
      await git(
        repositoryPath,
        "branch",
        "--set-upstream-to=origin/feature/default-base",
        "feature/default-base",
      );

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath));

      assert.equal(captured.manifest.source.baseCommit, mainCommit);
      assert.equal(
        captured.manifest.paths.some((entry) => entry.path === "modified.ts"),
        true,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
  it("reads the mode of the requested file when the path contains glob characters", async () => {
    const repositoryPath = await createRepository();
    try {
      await writeFile(join(repositoryPath, "a0c.ts"), "executable\n");
      await chmod(join(repositoryPath, "a0c.ts"), 0o755);
      await writeFile(join(repositoryPath, "a?c.ts"), "plain\n");
      await git(repositoryPath, "add", "-A");
      await git(repositoryPath, "commit", "-m", "add glob-shaped paths");
      await git(repositoryPath, "switch", "-c", "feature/glob");
      await writeFile(join(repositoryPath, "a?c.ts"), "plain changed\n");
      await git(repositoryPath, "add", "-A");
      await git(repositoryPath, "commit", "-m", "change the glob-shaped path");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const entry = captured.manifest.paths.find((candidate) => candidate.path === "a?c.ts");

      assert.equal(entry?.changeType, "MODIFIED");
      assert.equal(entry?.before?.gitMode, "100644");
      assert.equal(entry?.after?.gitMode, "100644");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("captures the named repository even when GIT_DIR points elsewhere", async () => {
    const target = await createRepository();
    const decoy = await createRepository();
    const previousGitDir = process.env.GIT_DIR;
    const previousWorkTree = process.env.GIT_WORK_TREE;
    try {
      await git(target, "switch", "-c", "feature/target");
      await writeFile(join(target, "modified.ts"), "target change\n");
      await git(target, "add", "-A");
      await git(target, "commit", "-m", "target change");
      const targetHead = await git(target, "rev-parse", "HEAD");

      process.env.GIT_DIR = join(decoy, ".git");
      process.env.GIT_WORK_TREE = decoy;
      const captured = await captureGitSnapshotV1(reviewRequest(target, "main"));

      assert.equal(captured.manifest.source.headCommit, targetHead);
      assert.equal(captured.manifest.source.branch, "feature/target");
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
      if (previousWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = previousWorkTree;
      }
      await rm(target, { recursive: true, force: true });
      await rm(decoy, { recursive: true, force: true });
    }
  });

  it("reports an unreadable untracked file as an omission carrying the error code", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const repositoryPath = await createRepository();
    const unreadablePath = join(repositoryPath, "unreadable.ts");
    try {
      await git(repositoryPath, "switch", "-c", "feature/unreadable");
      await writeFile(unreadablePath, "secret\n");
      await chmod(unreadablePath, 0o000);

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const omission = captured.manifest.omissions.find(
        (candidate) => candidate.scope === "unreadable.ts",
      );

      assert.equal(omission?.reason, "UNREADABLE");
      assert.match(omission?.detail ?? "", /EACCES/);
    } finally {
      await chmod(unreadablePath, 0o644).catch(() => undefined);
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
  it("excludes credential-shaped filenames and credential directories", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/secret-names");
      await mkdir(join(repositoryPath, ".ssh"), { recursive: true });
      await writeFile(join(repositoryPath, ".ssh", "notes.txt"), "in a credential directory\n");
      await writeFile(join(repositoryPath, "id_ed25519"), "private key material\n");
      await writeFile(join(repositoryPath, "terraform.tfvars"), 'token = "value"\n');
      await writeFile(join(repositoryPath, "keystore.jks"), "binary-ish\n");
      await writeFile(join(repositoryPath, "kept.ts"), "ordinary source\n");
      await writeFile(
        join(repositoryPath, "scanner.ts"),
        [
          "const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;",
          "const pgp = /-----BEGIN PGP PRIVATE KEY BLOCK-----/;",
          'const publicExample = "AKIAIOSFODNN7EXAMPLE";',
        ].join("\n"),
      );

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const excluded = new Set(captured.manifest.exclusions.map((entry) => entry.path));
      const capturedPaths = new Set(captured.manifest.paths.map((entry) => entry.path));

      for (const path of [".ssh/notes.txt", "id_ed25519", "terraform.tfvars", "keystore.jks"]) {
        assert.equal(excluded.has(path), true, `${path} must be excluded`);
        assert.equal(capturedPaths.has(path), false, `${path} must not be captured`);
      }
      assert.equal(capturedPaths.has("kept.ts"), true);
      assert.equal(capturedPaths.has("scanner.ts"), true);
      assert.equal(
        captured.manifest.exclusions.every((entry) => entry.reason === "SECRET_POLICY"),
        true,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("excludes a credential pasted into ordinary source", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/secret-content");
      await writeFile(
        join(repositoryPath, "config.ts"),
        `export const token = "${syntheticAwsAccessKeyId}";\n`,
      );
      await writeFile(
        join(repositoryPath, "fixture.pem.txt"),
        `${syntheticOpenSshPrivateKeyHeader}\nbase64\n`,
      );
      await writeFile(join(repositoryPath, "kept.ts"), "ordinary source\n");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const byPath = new Map(
        captured.manifest.exclusions.map((entry) => [entry.path, entry.reason]),
      );
      const capturedPaths = new Set(captured.manifest.paths.map((entry) => entry.path));
      const blobs = [...captured.blobs.values()].map((bytes) =>
        Buffer.from(bytes).toString("utf8"),
      );

      assert.equal(byPath.get("config.ts"), "SECRET_CONTENT");
      assert.equal(byPath.get("fixture.pem.txt"), "SECRET_CONTENT");
      assert.equal(capturedPaths.has("kept.ts"), true);
      assert.equal(
        blobs.some((content) => content.includes("AKIAIOSFODNN7EXAMPLE")),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("excludes a credential in a NUL-dense encoding and keeps its bytes out of the packet", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/utf16-secret");
      const source = `export const token = "${syntheticAwsAccessKeyId}";\n`;
      // Regression for #92: the content scan short-circuited on any NUL byte, so this file read as
      // clean, classified as SOURCE from its extension, and had its key written into blobs/.
      await writeFile(join(repositoryPath, "utf16.ts"), Buffer.from(source, "utf16le"));
      await writeFile(join(repositoryPath, "kept.ts"), "ordinary source\n");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const byPath = new Map(
        captured.manifest.exclusions.map((entry) => [entry.path, entry.reason]),
      );

      assert.equal(byPath.get("utf16.ts"), "SECRET_CONTENT");
      assert.equal(
        captured.manifest.paths.some((entry) => entry.path === "utf16.ts"),
        false,
      );
      assert.equal(
        [...captured.blobs.values()].some((bytes) =>
          Buffer.from(bytes).toString("utf16le").includes(syntheticAwsAccessKeyId),
        ),
        false,
      );
      assert.equal(
        captured.manifest.paths.some((entry) => entry.path === "kept.ts"),
        true,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("records an omission for a reviewable path no supported encoding decodes", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/undecodable");
      // NULs on both parities, so neither UTF-16 orientation explains them and the content policy
      // cannot clear the file. It is still reviewable by extension, so the manifest must say the
      // scan did not run rather than imply it passed.
      await writeFile(
        join(repositoryPath, "undecodable.ts"),
        Buffer.from([0x41, 0x00, 0x42, 0x00, 0x00, 0x43, 0x44, 0x00]),
      );

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const omission = captured.manifest.omissions.find(
        (entry) => entry.scope === "undecodable.ts",
      );

      assert.equal(omission?.reason, "OTHER");
      assert.match(omission?.detail ?? "", /without a credential content scan/);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("keeps synthetic secret-scanner fixtures reviewable", async () => {
    const repositoryPath = await createRepository();
    try {
      const compiledTestSource = await readFile(new URL(import.meta.url), "utf8");
      await writeFile(join(repositoryPath, "security-test.ts"), compiledTestSource);
      await git(repositoryPath, "add", "security-test.ts");
      await git(repositoryPath, "commit", "-m", "add reviewable security test");
      await git(repositoryPath, "switch", "-c", "feature/reviewable-security-test");
      await writeFile(
        join(repositoryPath, "security-test.ts"),
        `${compiledTestSource}\n// Exercise a later security-test change.\n`,
      );

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));

      assert.equal(
        captured.manifest.paths.some((entry) => entry.path === "security-test.ts"),
        true,
      );
      assert.equal(
        captured.manifest.exclusions.some((entry) => entry.path === "security-test.ts"),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("omits credential-bearing unchanged referenced source without storing its bytes", async () => {
    const repositoryPath = await createRepository();
    try {
      await writeFile(
        join(repositoryPath, "credential.ts"),
        `export const token = "${syntheticAwsAccessKeyId}";\n`,
      );
      await git(repositoryPath, "add", "credential.ts");
      await git(repositoryPath, "commit", "-m", "add referenced source");
      await git(repositoryPath, "switch", "-c", "feature/reference-secret");
      await writeFile(
        join(repositoryPath, "modified.ts"),
        'import { token } from "./credential.js";\nexport const value = token;\n',
      );

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const omission = captured.manifest.omissions.find(
        (candidate) => candidate.scope === "credential.ts",
      );
      const blobTexts = [...captured.blobs.values()].map((bytes) =>
        Buffer.from(bytes).toString("utf8"),
      );

      assert.equal(
        captured.manifest.referencedSources.some((source) => source.path === "credential.ts"),
        false,
      );
      assert.equal(omission?.reason, "OTHER");
      assert.match(omission?.detail ?? "", /content policy.*AWS access key id/i);
      assert.equal(
        blobTexts.some((content) => content.includes(syntheticAwsAccessKeyId)),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("omits referenced sources with credential-shaped paths before capturing them", async () => {
    const repositoryPath = await createRepository();
    try {
      await mkdir(join(repositoryPath, ".aws"), { recursive: true });
      await writeFile(join(repositoryPath, ".aws", "config.ts"), "export const region = 'test';\n");
      await writeFile(join(repositoryPath, ".env.production"), "SAFE_TEST_VALUE=true\n");
      await writeFile(join(repositoryPath, "server.key"), "test key material\n");
      await git(repositoryPath, "add", "-f", ".aws/config.ts", ".env.production", "server.key");
      await git(repositoryPath, "commit", "-m", "add sensitive referenced paths");
      await git(repositoryPath, "switch", "-c", "feature/reference-secret-paths");
      await writeFile(
        join(repositoryPath, "modified.ts"),
        [
          'import "./.aws/config.js";',
          'import "./.env.production";',
          'import "./server.key";',
          "export const value = true;",
          "",
        ].join("\n"),
      );

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const omittedByScope = new Map(
        captured.manifest.omissions.map((omission) => [omission.scope, omission]),
      );
      const referencedPaths = new Set(
        captured.manifest.referencedSources.map((source) => source.path),
      );
      const blobTexts = [...captured.blobs.values()].map((bytes) =>
        Buffer.from(bytes).toString("utf8"),
      );

      for (const path of [".aws/config.ts", ".env.production", "server.key"]) {
        assert.equal(referencedPaths.has(path), false, `${path} must not be referenced context`);
        assert.equal(omittedByScope.get(path)?.reason, "OTHER");
        assert.match(omittedByScope.get(path)?.detail ?? "", /secret filename policy/i);
      }
      for (const content of ["export const region", "SAFE_TEST_VALUE", "test key material"]) {
        assert.equal(
          blobTexts.some((blob) => blob.includes(content)),
          false,
          `${content} must not be stored`,
        );
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("scans changed and referenced source content beyond the former prefix boundary", async () => {
    const repositoryPath = await createRepository();
    const padding = `// ${"x".repeat(256 * 1024)}\n`;
    const credential = `export const token = "${syntheticAwsAccessKeyId}";\n`;
    try {
      await writeFile(join(repositoryPath, "large-reference.ts"), padding + credential);
      await git(repositoryPath, "add", "large-reference.ts");
      await git(repositoryPath, "commit", "-m", "add large referenced source");
      await git(repositoryPath, "switch", "-c", "feature/late-secret-content");
      await writeFile(join(repositoryPath, "large-changed.ts"), padding + credential);
      await writeFile(
        join(repositoryPath, "modified.ts"),
        'import { token } from "./large-reference.js";\nexport const value = token;\n',
      );

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const changedExclusion = captured.manifest.exclusions.find(
        (entry) => entry.path === "large-changed.ts",
      );
      const referencedOmission = captured.manifest.omissions.find(
        (entry) => entry.scope === "large-reference.ts",
      );
      const blobTexts = [...captured.blobs.values()].map((bytes) =>
        Buffer.from(bytes).toString("utf8"),
      );

      assert.equal(changedExclusion?.reason, "SECRET_CONTENT");
      assert.match(changedExclusion?.detail ?? "", /AWS access key id/);
      assert.equal(referencedOmission?.reason, "OTHER");
      assert.match(referencedOmission?.detail ?? "", /content policy.*AWS access key id/i);
      assert.equal(
        blobTexts.some((content) => content.includes(syntheticAwsAccessKeyId)),
        false,
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("uses the caller evidence budget for referenced source capture", async () => {
    const repositoryPath = await createRepository();
    const largeComment = `// ${"x".repeat(70_000)}\n`;
    try {
      await writeFile(
        join(repositoryPath, "reference-a.ts"),
        `${largeComment}export const a = 1;\n`,
      );
      await writeFile(
        join(repositoryPath, "reference-b.ts"),
        `${largeComment}export const b = 2;\n`,
      );
      await git(repositoryPath, "add", "reference-a.ts", "reference-b.ts");
      await git(repositoryPath, "commit", "-m", "add large references");
      await git(repositoryPath, "switch", "-c", "feature/reference-budget");
      await writeFile(
        join(repositoryPath, "modified.ts"),
        [
          'import { a } from "./reference-a.js";',
          'import { b } from "./reference-b.js";',
          "export const value = a + b;",
          "",
        ].join("\n"),
      );

      const defaultCapture = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"));
      const configuredCapture = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"), {
        maxReferencedSourceBytes: 160_000,
      });

      assert.equal(defaultCapture.manifest.referencedSources.length, 1);
      assert.match(defaultCapture.manifest.omissions[0]?.detail ?? "", /budget is exhausted/i);
      assert.deepEqual(
        configuredCapture.manifest.referencedSources.map(({ path }) => path),
        ["reference-a.ts", "reference-b.ts"],
      );
      assert.equal(configuredCapture.manifest.omissions.length, 0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("excludes caller-supplied path patterns", async () => {
    const repositoryPath = await createRepository();
    try {
      await git(repositoryPath, "switch", "-c", "feature/patterns");
      await mkdir(join(repositoryPath, "vendor", "nested"), { recursive: true });
      await writeFile(join(repositoryPath, "vendor", "nested", "bundle.js"), "vendored\n");
      await writeFile(join(repositoryPath, "notes.md"), "generated\n");
      await writeFile(join(repositoryPath, "kept.ts"), "ordinary source\n");

      const captured = await captureGitSnapshotV1(reviewRequest(repositoryPath, "main"), {
        excludedPathPatterns: ["vendor/**", "*.md"],
      });
      const byPath = new Map(
        captured.manifest.exclusions.map((entry) => [entry.path, entry.reason]),
      );
      const capturedPaths = new Set(captured.manifest.paths.map((entry) => entry.path));

      assert.equal(byPath.get("vendor/nested/bundle.js"), "USER_EXCLUDED");
      assert.equal(byPath.get("notes.md"), "USER_EXCLUDED");
      assert.equal(capturedPaths.has("kept.ts"), true);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
