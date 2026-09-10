import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const helperPath = join(process.cwd(), "support", "collect-bug-report-info.sh");

async function git(repositoryPath: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

it("collects replay metadata without printing paths or source", async () => {
  const repositoryPath = await mkdtemp(join(tmpdir(), "bug-report-info-"));
  try {
    await git(repositoryPath, "init", "--initial-branch=main");
    await git(repositoryPath, "config", "user.name", "Bug Report Test");
    await git(repositoryPath, "config", "user.email", "bug-report@example.invalid");
    await git(repositoryPath, "config", "commit.gpgsign", "false");
    await writeFile(join(repositoryPath, "sensitive-name.txt"), "initial\n");
    await git(repositoryPath, "add", ".");
    await git(repositoryPath, "commit", "-m", "initial");
    const baseCommit = await git(repositoryPath, "rev-parse", "HEAD");

    await writeFile(join(repositoryPath, "sensitive-name.txt"), "PRIVATE_STAGED_CONTENT\n");
    await git(repositoryPath, "add", "sensitive-name.txt");
    await writeFile(join(repositoryPath, "sensitive-name.txt"), "PRIVATE_UNSTAGED_CONTENT\n");
    await writeFile(
      join(repositoryPath, "private-untracked-name.txt"),
      "PRIVATE_UNTRACKED_CONTENT\n",
    );

    const result = await execFileAsync(
      helperPath,
      [
        "--repo",
        repositoryPath,
        "--base",
        baseCommit,
        "--public-url",
        "https://github.com/example/reproduction",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_DIR: join(repositoryPath, "does-not-exist") },
      },
    );

    assert.match(result.stdout, /Target public URL: https:\/\/github\.com\/example\/reproduction/);
    assert.match(result.stdout, new RegExp(`Target base commit: ${baseCommit}`));
    assert.match(result.stdout, new RegExp(`Target HEAD commit: ${baseCommit}`));
    assert.match(result.stdout, /Target working tree: dirty/);
    assert.match(result.stdout, /Staged entries: 1/);
    assert.match(result.stdout, /Unstaged entries: 1/);
    assert.match(result.stdout, /Untracked entries: 1/);
    assert.match(result.stdout, /Tracked diff SHA-256: [0-9a-f]{64}/);
    assert.match(result.stdout, /Source contents included: no/);
    assert.doesNotMatch(result.stdout, /sensitive-name|private-untracked-name/);
    assert.doesNotMatch(result.stdout, /PRIVATE_(STAGED|UNSTAGED|UNTRACKED)_CONTENT/);
    assert.doesNotMatch(result.stdout, new RegExp(repositoryPath));
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
});

it("rejects a public URL that is not explicitly HTTPS", async () => {
  await assert.rejects(
    execFileAsync(helperPath, ["--public-url", "git@example.com:private/repository.git"], {
      encoding: "utf8",
    }),
    /must be an HTTPS URL that is safe to publish/,
  );
});

it("rejects credentials in an HTTPS public URL", async () => {
  await assert.rejects(
    execFileAsync(helperPath, ["--public-url", "https://token@github.com/private/repository"], {
      encoding: "utf8",
    }),
    /must not contain credentials/,
  );
});
