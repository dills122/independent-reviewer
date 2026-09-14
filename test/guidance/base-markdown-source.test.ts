import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import {
  baseGuidanceBlobMetadataV1,
  GuidanceCaptureError,
  listBaseGuidanceBlobMetadataV1,
  readBaseGuidanceFrontmatterV1,
} from "../../src/guidance/base-markdown-source.js";

const exec = promisify(execFile);

describe("listBaseGuidanceBlobMetadataV1", () => {
  it("reads bounded leading metadata without decoding an excluded binary body", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "guidance-metadata-prefix-"));
    try {
      await exec("git", ["-C", repositoryPath, "init", "--initial-branch=main"]);
      await exec("git", ["-C", repositoryPath, "config", "user.name", "Guidance Prefix Test"]);
      await exec("git", [
        "-C",
        repositoryPath,
        "config",
        "user.email",
        "guidance-prefix@example.invalid",
      ]);
      await exec("git", ["-C", repositoryPath, "config", "commit.gpgsign", "false"]);
      const frontmatter = Buffer.from("---\ninclusion: manual\n---\n", "utf8");
      await writeFile(
        join(repositoryPath, "manual.md"),
        Buffer.concat([frontmatter, Buffer.alloc(1024 * 1024, 0xff)]),
      );
      await exec("git", ["-C", repositoryPath, "add", "."]);
      await exec("git", ["-C", repositoryPath, "commit", "-m", "base"]);
      const { stdout } = await exec("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);
      const metadata = await baseGuidanceBlobMetadataV1(repositoryPath, stdout.trim(), "manual.md");
      assert.ok(metadata);

      assert.equal(
        await readBaseGuidanceFrontmatterV1(repositoryPath, "manual.md", metadata),
        frontmatter.toString("utf8"),
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("stops matching-entry construction at the requested cap", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "guidance-list-cap-"));
    try {
      await exec("git", ["-C", repositoryPath, "init", "--initial-branch=main"]);
      await exec("git", ["-C", repositoryPath, "config", "user.name", "Guidance List Test"]);
      await exec("git", [
        "-C",
        repositoryPath,
        "config",
        "user.email",
        "guidance-list@example.invalid",
      ]);
      await exec("git", ["-C", repositoryPath, "config", "commit.gpgsign", "false"]);
      await writeFile(join(repositoryPath, "a.md"), "# A\n");
      await writeFile(join(repositoryPath, "b.md"), "# B\n");
      await writeFile(join(repositoryPath, "c.md"), "# C\n");
      for (let index = 0; index < 256; index += 1) {
        await writeFile(
          join(repositoryPath, `ignored-${index.toString().padStart(3, "0")}.txt`),
          "ignored\n",
        );
      }
      await exec("git", ["-C", repositoryPath, "add", "."]);
      await exec("git", ["-C", repositoryPath, "commit", "-m", "base"]);
      const { stdout } = await exec("git", ["-C", repositoryPath, "rev-parse", "HEAD"]);

      await assert.rejects(
        listBaseGuidanceBlobMetadataV1(repositoryPath, stdout.trim(), ".", {
          include: (path) => path.endsWith(".md"),
          maximumEntries: 2,
        }),
        (error: unknown) =>
          error instanceof GuidanceCaptureError &&
          error.code === "GUIDANCE_DISCOVERY_LIMIT_EXCEEDED",
      );
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
