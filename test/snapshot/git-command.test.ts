import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  decodeGitText,
  runGit,
  runGitNulRecords,
  runGitStdoutPrefix,
} from "../../src/snapshot/git-command.js";

const execFileAsync = promisify(execFile);

const gitCommandModuleUrl = new URL("../../src/snapshot/git-command.js", import.meta.url).href;

async function runWithFreshFakeGit<T>(fakeGitProgram: string, callerProgram: string): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "independent-reviewer-fake-git-"));
  const fakeGitPath = join(root, "git");
  const callerPath = join(root, "caller.mjs");
  try {
    await writeFile(fakeGitPath, `#!${process.execPath}\n${fakeGitProgram}`, { mode: 0o700 });
    await writeFile(
      callerPath,
      `import { runGit, runGitNulRecords, runGitStdoutPrefix } from ${JSON.stringify(gitCommandModuleUrl)};\n${callerProgram}`,
    );
    const { stdout } = await execFileAsync(process.execPath, [callerPath], {
      cwd: root,
      encoding: "utf8",
      env: {
        HOME: root,
        PATH: root,
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        ...(process.env.PATHEXT === undefined ? {} : { PATHEXT: process.env.PATHEXT }),
      },
      timeout: 4_000,
    });
    return JSON.parse(stdout) as T;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createRepository(): Promise<string> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "independent-reviewer-git-command-"));
  await execFileAsync("git", ["-C", repositoryPath, "init", "--initial-branch=main"]);
  return repositoryPath;
}

describe("runGit", () => {
  it("streams NUL records and stops an active producer when the consumer rejects overflow", async () => {
    const repositoryPath = await createRepository();
    const records: string[] = [];
    const startedAt = Date.now();
    try {
      await assert.rejects(
        runGitNulRecords(
          repositoryPath,
          ["-c", "alias.records=!while :; do printf '%s\\0' one two three; done", "records"],
          (record) => {
            records.push(record.toString("utf8"));
            if (records.length === 3) throw new Error("record limit reached");
          },
          5_000,
        ),
        /record limit reached/,
      );
      assert.deepEqual(records, ["one", "two", "three"]);
      assert.ok(Date.now() - startedAt < 2_000, "producer did not stop promptly");
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("returns only the requested stdout prefix", async () => {
    const repositoryPath = await createRepository();
    try {
      assert.equal(
        (await runGitStdoutPrefix(repositoryPath, ["version"], 3)).toString("ascii"),
        "git",
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

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
      await execFileAsync("git", ["-C", repositoryPath, "config", "commit.gpgsign", "false"]);
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

describe("safe.directory preflight", () => {
  it("forwards complete configured entries from a fresh process", async () => {
    const observed = await runWithFreshFakeGit<{
      count: string;
      keys: string[];
      values: string[];
    }>(
      `
if (process.argv[2] === "config") {
  process.stdout.write("/trusted/one\\n*\\n");
} else {
  process.stdout.write(JSON.stringify({
    count: process.env.GIT_CONFIG_COUNT,
    keys: [process.env.GIT_CONFIG_KEY_0, process.env.GIT_CONFIG_KEY_1],
    values: [process.env.GIT_CONFIG_VALUE_0, process.env.GIT_CONFIG_VALUE_1],
  }));
}
`,
      `
const result = await runGit(process.cwd(), ["status"], [0], 100);
console.log(result.stdout.toString("utf8"));
`,
    );

    assert.deepEqual(observed, {
      count: "2",
      keys: ["safe.directory", "safe.directory"],
      values: ["/trusted/one", "*"],
    });
  });

  it("treats an unset key as an empty forwarding set", async () => {
    const observed = await runWithFreshFakeGit<{ count: string }>(
      `
if (process.argv[2] === "config") {
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ count: process.env.GIT_CONFIG_COUNT }));
}
`,
      `
const result = await runGit(process.cwd(), ["status"], [0], 100);
console.log(result.stdout.toString("utf8"));
`,
    );

    assert.deepEqual(observed, { count: "0" });
  });

  it("discards output from a failed lookup", async () => {
    const observed = await runWithFreshFakeGit<{ count: string }>(
      `
if (process.argv[2] === "config") {
  process.stdout.write("/must-not-be-forwarded\\n");
  process.exitCode = 2;
} else {
  process.stdout.write(JSON.stringify({ count: process.env.GIT_CONFIG_COUNT }));
}
`,
      `
const result = await runGit(process.cwd(), ["status"], [0], 100);
console.log(result.stdout.toString("utf8"));
`,
    );

    assert.deepEqual(observed, { count: "0" });
  });

  it("discards overflow and stops its producer before running Git", async () => {
    const observed = await runWithFreshFakeGit<{ count: string }>(
      `
if (process.argv[2] === "config") {
  process.stdout.write(Buffer.alloc(1024 * 1024 + 1, 97));
  setTimeout(() => {}, 30_000);
} else {
  process.stdout.write(JSON.stringify({ count: process.env.GIT_CONFIG_COUNT }));
}
`,
      `
const result = await runGit(process.cwd(), ["status"], [0], 100);
console.log(result.stdout.toString("utf8"));
`,
    );

    assert.deepEqual(observed, { count: "0" });
  });

  it("bounds a shared stalled lookup for every Git wrapper", async () => {
    const observed = await runWithFreshFakeGit<{
      elapsedMs: number;
      records: string[];
      results: string[];
    }>(
      `
if (process.argv[2] === "config") {
  setTimeout(() => {}, 30_000);
} else {
  process.stdout.write(Buffer.from("ok\\0"));
}
`,
      `
const records = [];
const startedAt = performance.now();
const settled = await Promise.all([
  runGit(process.cwd(), ["status"], [0], 100).then((result) => result.stdout.subarray(0, 2).toString("utf8")),
  runGitNulRecords(process.cwd(), ["records"], (record) => records.push(record.toString("utf8")), 100).then(() => "records"),
  runGitStdoutPrefix(process.cwd(), ["prefix"], 2, 100).then((result) => result.toString("utf8")),
]);
console.log(JSON.stringify({ elapsedMs: performance.now() - startedAt, records, results: settled }));
`,
    );

    assert.ok(observed.elapsedMs < 2_500, `preflight took ${observed.elapsedMs} ms`);
    assert.deepEqual(observed.records, ["ok"]);
    assert.deepEqual(observed.results, ["ok", "records", "ok"]);
  });
});
