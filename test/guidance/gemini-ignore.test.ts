import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { buildGeminiIgnoreMatcherV1 } from "../../src/guidance/gemini-ignore.js";

const exec = promisify(execFile);

describe("Gemini ignore adapter", () => {
  it("preserves comments, negation, directory bases, and case", () => {
    const ignored = buildGeminiIgnoreMatcherV1([
      { path: ".gitignore", content: "# generated\nbuild/\n*.tmp\n!keep.tmp\n" },
      { path: ".geminiignore", content: "!gemini-visible.tmp\n" },
      { path: "docs/.geminiignore", content: "private/*\n!private/keep.md\n" },
    ]);

    assert.equal(ignored("build/GEMINI.md"), true);
    assert.equal(ignored("notes.tmp"), true);
    assert.equal(ignored("keep.tmp"), false);
    assert.equal(ignored("KEEP.TMP"), false);
    assert.equal(ignored("gemini-visible.tmp"), false);
    assert.equal(ignored("docs/private/GEMINI.md"), true);
    assert.equal(ignored("docs/private/keep.md"), false);
    assert.equal(ignored("src/private/GEMINI.md"), false);
  });

  it("does not re-include a file while an ancestor directory remains excluded", () => {
    const stillIgnored = buildGeminiIgnoreMatcherV1([
      { path: ".gitignore", content: "docs/private/\n" },
      { path: "docs/.geminiignore", content: "!private/keep.md\n" },
    ]);
    const reIncluded = buildGeminiIgnoreMatcherV1([
      { path: ".gitignore", content: "docs/private/\n" },
      { path: "docs/.geminiignore", content: "!private/\n!private/keep.md\n" },
    ]);

    assert.equal(stillIgnored("docs/private/keep.md"), true);
    assert.equal(reIncluded("docs/private/keep.md"), false);
  });

  it("matches Git for root ignore ordering, directories, negation, and case", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "gemini-ignore-parity-"));
    const content = "build/\n*.tmp\n!keep.tmp\n";
    const ignored = buildGeminiIgnoreMatcherV1([{ path: ".gitignore", content }]);
    const paths = ["build/GEMINI.md", "notes.tmp", "keep.tmp", "KEEP.TMP"];
    try {
      await exec("git", ["-C", repositoryPath, "init", "--initial-branch=main"]);
      await writeFile(join(repositoryPath, ".gitignore"), content);
      await mkdir(join(repositoryPath, "build"));
      for (const path of paths) {
        await mkdir(join(repositoryPath, posixDirectory(path)), { recursive: true });
        await writeFile(join(repositoryPath, path), "fixture\n");
      }
      for (const path of paths) {
        let gitIgnored = true;
        try {
          await exec("git", ["-C", repositoryPath, "check-ignore", "--no-index", "--quiet", path]);
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === 1) {
            gitIgnored = false;
          } else {
            throw error;
          }
        }
        assert.equal(ignored(path), gitIgnored, path);
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});

function posixDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}
