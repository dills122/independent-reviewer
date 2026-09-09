import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

import { decodeGitText, runGit } from "../../src/snapshot/git-command.js";

const execFileAsync = promisify(execFile);

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-git-command-"));
  await execFileAsync("git", ["-C", repositoryPath, "init", "--initial-branch=main"]);
  return repositoryPath;
}

describe("runGit", () => {
  it("rejects with a timeout diagnostic when Git does not finish in time", async () => {
    const repositoryPath = await createRepository();
    try {
      await assert.rejects(
        runGit(repositoryPath, ["-c", "alias.stall=!sleep 30", "stall"], [0], 250),
        (error: Error) => /timed out after 250 ms/.test(error.message),
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("does not inherit GIT_DIR from the ambient environment", async () => {
    const target = await createRepository();
    const decoy = await createRepository();
    const previousGitDir = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(decoy, ".git");
      const resolved = decodeGitText(
        (await runGit(target, ["rev-parse", "--absolute-git-dir"])).stdout,
      );

      assert.equal(resolved.startsWith(await realpath(target)), true);
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
      await rm(target, { recursive: true, force: true });
      await rm(decoy, { recursive: true, force: true });
    }
  });

  it("treats paths as literal, not as pathspec patterns", async () => {
    const repositoryPath = await createRepository();
    try {
      await execFileAsync("git", ["-C", repositoryPath, "config", "user.name", "Git Command Test"]);
      await execFileAsync("git", [
        "-C",
        repositoryPath,
        "config",
        "user.email",
        "git-command@example.invalid",
      ]);
      await execFileAsync("sh", [
        "-c",
        `cd ${JSON.stringify(repositoryPath)} && printf 'exec\\n' > 'a0c.txt' && chmod +x 'a0c.txt' && printf 'plain\\n' > 'a?c.txt' && git add -A && git commit -qm initial`,
      ]);

      const records = decodeGitText(
        (await runGit(repositoryPath, ["ls-files", "-s", "--", "a?c.txt"])).stdout,
      ).split("\n");

      assert.equal(records.length, 1);
      assert.equal(records[0]?.startsWith("100644"), true);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
